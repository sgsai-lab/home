import { HttpError, sanitizeText } from '../http.mjs';
import { deleteDoc, getDoc, getUserById, findUserByEmail, newId, queryDocs, setDoc, updateDoc, updateUser } from '../db.mjs';
import { isSgsAdmin, MEMBER_ROLES, membershipId, requireMembership, roleAtLeast, listMembershipsForUser } from '../authz.mjs';
import { randomToken, sha256 } from '../security.mjs';
import { siteOrigin, templates } from '../mail.mjs';
import { Checker, SECTORS, SLUG_PATTERN, pageParams, slugify, sortAndPage } from '../validation.mjs';
import { sendMailSafely } from './auth.mjs';

const CLIENT_STATUSES = ['prospect', 'active', 'paused', 'closed'];
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;
const COLOR = /^#[0-9a-f]{6}$/i;

export function publicClient(client, role = null) {
  return {
    id: client.id,
    name: client.name,
    slug: client.slug,
    primary_sector: client.primary_sector,
    status: client.status,
    contact: client.contact ?? {},
    branding: client.branding ?? {},
    created_at: client.created_at,
    updated_at: client.updated_at,
    ...(role ? { my_role: role } : {})
  };
}

async function uniqueClientSlug(name, requested) {
  const base = requested || slugify(name) || 'client';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt ? `${base.slice(0, 54)}-${attempt + 1}` : base;
    const [taken] = await queryDocs('clients', { where: [['slug', '==', candidate]], limit: 1 });
    if (!taken) return candidate;
  }
  throw new HttpError(409, 'SLUG_TAKEN', 'Choose a different slug.');
}

function readContact(check) {
  const raw = check.input.contact;
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return check.fail('contact', 'Expected an object.');
  const inner = new Checker(raw);
  inner.email('email', { required: false });
  inner.text('phone', { max: 40, nullable: true });
  inner.url('website');
  inner.details.forEach((detail) => check.fail(`contact.${detail.field}`, detail.message));
  check.output.contact = inner.output;
  return inner.output;
}

function readBranding(check) {
  const raw = check.input.branding;
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return check.fail('branding', 'Expected an object.');
  const output = {};
  if (raw.primary_color !== undefined && raw.primary_color !== null) {
    if (!COLOR.test(raw.primary_color)) return check.fail('branding.primary_color', 'Use a hex colour such as #3355ff.');
    output.primary_color = raw.primary_color.toLowerCase();
  }
  check.output.branding = output;
  return output;
}

async function memberCount(clientId) {
  return (await queryDocs('memberships', { where: [['client_id', '==', clientId], ['status', '==', 'active']] })).length;
}

async function listClients(ctx) {
  const { user } = await ctx.auth();
  const params = pageParams(ctx.query, { sortFields: ['name', 'created_at', 'updated_at'], defaultSort: 'name' });
  let items;
  if (isSgsAdmin(user)) {
    const where = [];
    const status = ctx.query.get('status');
    if (CLIENT_STATUSES.includes(status)) where.push(['status', '==', status]);
    const sector = ctx.query.get('sector');
    if (SECTORS.includes(sector)) where.push(['primary_sector', '==', sector]);
    items = (await queryDocs('clients', { where, limit: 2000 })).map((client) => ({ ...publicClient(client, 'owner') }));
  } else {
    const memberships = await listMembershipsForUser(user.id);
    const clients = await Promise.all(memberships.map((membership) => getDoc('clients', membership.client_id)));
    items = clients.map((client, index) => client && publicClient(client, memberships[index].role)).filter(Boolean);
  }
  const q = sanitizeText(ctx.query.get('q'), 100).toLowerCase();
  if (q) items = items.filter((client) => client.name.toLowerCase().includes(q) || client.slug.includes(q));
  const page = sortAndPage(items, params);
  page.items = await Promise.all(page.items.map(async (client) => ({ ...client, member_count: await memberCount(client.id) })));
  return ctx.send(200, page);
}

async function createClient(ctx) {
  const { user } = await ctx.admin();
  ctx.limit('mutations', user.id);
  const check = new Checker(await ctx.body());
  const name = check.text('name', { required: true, max: 120 });
  check.oneOf('primary_sector', SECTORS, { required: true });
  check.oneOf('status', CLIENT_STATUSES);
  const requestedSlug = check.text('slug', { max: 60 });
  if (requestedSlug && !SLUG_PATTERN.test(requestedSlug)) check.fail('slug', 'Use lowercase letters, numbers and dashes.');
  readContact(check);
  readBranding(check);
  const input = check.done();
  const now = new Date().toISOString();
  const client = {
    id: newId('cli'),
    name,
    slug: await uniqueClientSlug(name, requestedSlug),
    primary_sector: input.primary_sector,
    status: input.status ?? 'active',
    contact: input.contact ?? {},
    branding: input.branding ?? {},
    created_by: user.id,
    created_at: now,
    updated_at: now
  };
  await setDoc('clients', client.id, client);
  await setDoc('memberships', membershipId(client.id, user.id), {
    client_id: client.id, user_id: user.id, role: 'owner', status: 'active', invited_by: null, joined_at: now
  });
  await ctx.audit('client.created', { type: 'client', id: client.id }, { actorId: user.id, clientId: client.id, diff: { primary_sector: client.primary_sector } });
  return ctx.send(201, { ...publicClient(client, 'owner'), member_count: 1 });
}

async function getClient(ctx) {
  const { user } = await ctx.auth();
  const { client, role } = await requireMembership(user, ctx.params.id);
  return ctx.send(200, { ...publicClient(client, role), member_count: await memberCount(client.id) });
}

async function updateClient(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { client, sgsAdmin } = await requireMembership(user, ctx.params.id, 'admin');
  const check = new Checker(await ctx.body());
  check.text('name', { max: 120, min: 1 });
  check.oneOf('primary_sector', SECTORS);
  check.oneOf('status', CLIENT_STATUSES);
  readContact(check);
  readBranding(check);
  const updates = check.done();
  if ('status' in updates && !sgsAdmin) throw new HttpError(403, 'FORBIDDEN', 'Only SGS AI Technology can change a workspace status.');
  if (updates.branding) updates.branding = { ...client.branding, ...updates.branding };
  const { after } = await updateDoc('clients', client.id, (current) => current && { ...current, ...updates, updated_at: new Date().toISOString() });
  await ctx.audit('client.updated', { type: 'client', id: client.id }, { actorId: user.id, clientId: client.id, diff: { fields: Object.keys(updates) } });
  return ctx.send(200, publicClient(after));
}

// --- Members ------------------------------------------------------------------------

async function listMembers(ctx) {
  const { user } = await ctx.auth();
  const { client } = await requireMembership(user, ctx.params.id);
  const memberships = await queryDocs('memberships', { where: [['client_id', '==', client.id], ['status', '==', 'active']] });
  const users = await Promise.all(memberships.map((membership) => getUserById(membership.user_id)));
  const items = memberships
    .map((membership, index) => users[index] && {
      user_id: membership.user_id,
      full_name: users[index].full_name,
      email: users[index].email,
      avatar_url: users[index].avatar_url ?? null,
      role: membership.role,
      joined_at: membership.joined_at
    })
    .filter(Boolean)
    .sort((a, b) => MEMBER_ROLES.indexOf(b.role) - MEMBER_ROLES.indexOf(a.role) || a.full_name.localeCompare(b.full_name));
  return ctx.send(200, { items });
}

async function activeOwners(clientId) {
  return queryDocs('memberships', { where: [['client_id', '==', clientId], ['role', '==', 'owner'], ['status', '==', 'active']] });
}

function assertCanGrant(actorRole, role) {
  if (role === 'owner' && actorRole !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'Only an owner can make someone an owner.');
}

/** SGS admins only: client admins use invitations, so they cannot probe which emails have accounts. */
async function addMember(ctx) {
  const { user } = await ctx.admin();
  ctx.limit('mutations', user.id);
  const { client, role: actorRole } = await requireMembership(user, ctx.params.id, 'admin');
  const check = new Checker(await ctx.body());
  const email = check.email('email');
  const role = check.oneOf('role', MEMBER_ROLES, { required: true });
  check.done();
  assertCanGrant(actorRole, role);
  const member = await findUserByEmail(email);
  if (!member || member.status !== 'active') throw new HttpError(404, 'USER_NOT_FOUND', 'No active account uses that email. Send an invitation instead.');
  const id = membershipId(client.id, member.id);
  const existing = await getDoc('memberships', id);
  if (existing?.status === 'active') throw new HttpError(409, 'ALREADY_MEMBER', 'This person is already a member.');
  await setDoc('memberships', id, { client_id: client.id, user_id: member.id, role, status: 'active', invited_by: user.id, joined_at: new Date().toISOString() });
  await ctx.audit('member.added', { type: 'user', id: member.id }, { actorId: user.id, clientId: client.id, diff: { role } });
  return ctx.send(201, { user_id: member.id, full_name: member.full_name, email: member.email, role });
}

async function updateMember(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { client, role: actorRole } = await requireMembership(user, ctx.params.id, 'admin');
  const check = new Checker(await ctx.body());
  const role = check.oneOf('role', MEMBER_ROLES, { required: true });
  check.done();
  const id = membershipId(client.id, ctx.params.user_id);
  const membership = await getDoc('memberships', id);
  if (membership?.status !== 'active') throw new HttpError(404, 'NOT_FOUND', 'Member not found.');
  assertCanGrant(actorRole, role);
  if (membership.role === 'owner' && actorRole !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'Only an owner can change another owner.');
  if (membership.role === 'owner' && role !== 'owner' && (await activeOwners(client.id)).length <= 1) {
    throw new HttpError(409, 'LAST_OWNER', 'A workspace needs at least one owner. Make someone else an owner first.');
  }
  await setDoc('memberships', id, { ...membership, role });
  await ctx.audit('member.role_changed', { type: 'user', id: membership.user_id }, { actorId: user.id, clientId: client.id, diff: { role: { from: membership.role, to: role } } });
  return ctx.send(200, { user_id: membership.user_id, role });
}

async function removeMember(ctx) {
  const { user } = await ctx.auth();
  const self = ctx.params.user_id === user.id;
  const { client, role: actorRole } = await requireMembership(user, ctx.params.id, self ? 'viewer' : 'admin');
  const id = membershipId(client.id, ctx.params.user_id);
  const membership = await getDoc('memberships', id);
  if (membership?.status !== 'active') throw new HttpError(404, 'NOT_FOUND', 'Member not found.');
  if (membership.role === 'owner') {
    if (!self && actorRole !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'Only an owner can remove another owner.');
    if ((await activeOwners(client.id)).length <= 1) throw new HttpError(409, 'LAST_OWNER', 'A workspace needs at least one owner. Make someone else an owner first.');
  }
  await deleteDoc('memberships', id);
  const removed = await getUserById(membership.user_id);
  if (removed?.default_client_id === client.id) await updateUser(removed.id, { default_client_id: null });
  await ctx.audit(self ? 'member.left' : 'member.removed', { type: 'user', id: membership.user_id }, { actorId: user.id, clientId: client.id });
  return ctx.send(200, { ok: true });
}

// --- Invites ------------------------------------------------------------------------

function publicInvite(invite) {
  return { id: invite.id, email: invite.email, role: invite.role, invited_by: invite.invited_by, created_at: invite.created_at, expires_at: new Date(invite.expires_at).toISOString() };
}

export async function findInviteByToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const [invite] = await queryDocs('invites', { where: [['token_hash', '==', sha256(token)]], limit: 1 });
  return invite && !invite.accepted_at && invite.expires_at > Date.now() ? invite : null;
}

/** Activates the membership and consumes the invite. */
export async function acceptInviteForUser(invite, user) {
  const acceptedAt = new Date().toISOString();
  const { before } = await updateDoc('invites', invite.id, (current) => (current && !current.accepted_at ? { ...current, accepted_at: acceptedAt, accepted_by: user.id } : undefined));
  if (!before || before.accepted_at) throw new HttpError(410, 'INVITE_CONSUMED', 'This invitation has already been used.');
  const id = membershipId(invite.client_id, user.id);
  let role;
  try {
    const existing = await getDoc('memberships', id);
    // Accepting never downgrades someone who is already a member.
    role = existing?.status === 'active' && roleAtLeast(existing.role, invite.role) ? existing.role : invite.role;
    await setDoc('memberships', id, {
      client_id: invite.client_id, user_id: user.id, role, status: 'active', invited_by: invite.invited_by, joined_at: existing?.joined_at ?? new Date().toISOString()
    });
  } catch (error) {
    // The invite was claimed first so it cannot be used twice; release the claim so the user can retry.
    await updateDoc('invites', invite.id, (current) => (current?.accepted_at === acceptedAt && current.accepted_by === user.id ? { ...current, accepted_at: null, accepted_by: null } : undefined)).catch(() => {});
    throw error;
  }
  if (!user.default_client_id) await updateUser(user.id, { default_client_id: invite.client_id });
  return role;
}

async function sendInvite(ctx, client, invite, inviter) {
  const token = randomToken();
  const now = Date.now();
  await setDoc('invites', invite.id, { ...invite, token_hash: sha256(token), expires_at: now + INVITE_TTL });
  return sendMailSafely(ctx, invite.email, templates.invite(siteOrigin(ctx.env), token, client.name, inviter.full_name, invite.role));
}

async function createInvite(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { client, role: actorRole } = await requireMembership(user, ctx.params.id, 'admin');
  const check = new Checker(await ctx.body());
  const email = check.email('email');
  const role = check.oneOf('role', MEMBER_ROLES, { required: true });
  check.done();
  assertCanGrant(actorRole, role);
  ctx.limit('invites', client.id);
  const existingUser = await findUserByEmail(email);
  if (existingUser && (await getDoc('memberships', membershipId(client.id, existingUser.id)))?.status === 'active') {
    throw new HttpError(409, 'ALREADY_MEMBER', 'This person is already a member.');
  }
  const pending = await queryDocs('invites', { where: [['client_id', '==', client.id], ['email', '==', email]] });
  await Promise.all(pending.filter((invite) => !invite.accepted_at).map((invite) => deleteDoc('invites', invite.id)));
  const invite = { id: newId('inv'), client_id: client.id, email, role, invited_by: user.id, accepted_at: null, created_at: new Date().toISOString() };
  const emailSent = await sendInvite(ctx, client, invite, user);
  await ctx.audit('invite.created', { type: 'invite', id: invite.id }, { actorId: user.id, clientId: client.id, diff: { role } });
  return ctx.send(201, { ...publicInvite({ ...invite, expires_at: Date.now() + INVITE_TTL }), email_sent: emailSent });
}

async function listInvites(ctx) {
  const { user } = await ctx.auth();
  const { client } = await requireMembership(user, ctx.params.id, 'admin');
  const invites = await queryDocs('invites', { where: [['client_id', '==', client.id]] });
  const items = invites.filter((invite) => !invite.accepted_at && invite.expires_at > Date.now()).map(publicInvite).sort((a, b) => b.created_at.localeCompare(a.created_at));
  return ctx.send(200, { items });
}

async function inviteFor(ctx, minimum = 'admin') {
  const { user } = await ctx.auth();
  const access = await requireMembership(user, ctx.params.id, minimum);
  const invite = await getDoc('invites', ctx.params.invite_id);
  if (!invite || invite.client_id !== access.client.id || invite.accepted_at) throw new HttpError(404, 'NOT_FOUND', 'Invitation not found.');
  return { user, invite, ...access };
}

async function resendInvite(ctx) {
  const { user, invite, client } = await inviteFor(ctx);
  ctx.limit('invites', client.id);
  // A new token invalidates the previous link.
  const emailSent = await sendInvite(ctx, client, invite, user);
  await ctx.audit('invite.resent', { type: 'invite', id: invite.id }, { actorId: user.id, clientId: client.id });
  return ctx.send(200, { ...publicInvite({ ...invite, expires_at: Date.now() + INVITE_TTL }), email_sent: emailSent });
}

async function revokeInvite(ctx) {
  const { user, invite, client } = await inviteFor(ctx);
  await deleteDoc('invites', invite.id);
  await ctx.audit('invite.revoked', { type: 'invite', id: invite.id }, { actorId: user.id, clientId: client.id });
  return ctx.send(200, { ok: true });
}

async function previewInvite(ctx) {
  ctx.limit('auth', ctx.ip);
  const invite = await findInviteByToken(ctx.query.get('token'));
  const client = invite ? await getDoc('clients', invite.client_id) : null;
  if (!client) throw new HttpError(404, 'INVITE_INVALID', 'This invitation is invalid or has expired. Ask your workspace admin for a new one.');
  return ctx.send(200, { client_name: client.name, primary_sector: client.primary_sector, role: invite.role, email: invite.email });
}

async function acceptInvite(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { token } = await ctx.body();
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'BAD_REQUEST', 'Missing token.');
  const [record] = await queryDocs('invites', { where: [['token_hash', '==', sha256(token)]], limit: 1 });
  if (record?.accepted_at) throw new HttpError(410, 'INVITE_CONSUMED', 'This invitation has already been used.');
  if (!record || record.expires_at <= Date.now()) throw new HttpError(404, 'INVITE_INVALID', 'This invitation is invalid or has expired.');
  if (record.email !== user.email) {
    throw new HttpError(403, 'INVITE_EMAIL_MISMATCH', `This invitation was sent to ${record.email}. Sign in with that address to accept it.`);
  }
  const role = await acceptInviteForUser(record, user);
  // The invitation reached this inbox, so the address is verified.
  if (!user.email_verified) await updateUser(user.id, { email_verified: true });
  const client = await getDoc('clients', record.client_id);
  await ctx.audit('invite.accepted', { type: 'invite', id: record.id }, { actorId: user.id, clientId: record.client_id, diff: { role } });
  return ctx.send(200, { client: publicClient(client, role) });
}

export const clientRoutes = [
  ['GET', '/api/v1/clients', listClients],
  ['POST', '/api/v1/clients', createClient],
  ['GET', '/api/v1/clients/:id', getClient],
  ['PATCH', '/api/v1/clients/:id', updateClient],
  ['GET', '/api/v1/clients/:id/members', listMembers],
  ['POST', '/api/v1/clients/:id/members', addMember],
  ['PATCH', '/api/v1/clients/:id/members/:user_id', updateMember],
  ['DELETE', '/api/v1/clients/:id/members/:user_id', removeMember],
  ['GET', '/api/v1/clients/:id/invites', listInvites],
  ['POST', '/api/v1/clients/:id/invites', createInvite],
  ['POST', '/api/v1/clients/:id/invites/:invite_id/resend', resendInvite],
  ['DELETE', '/api/v1/clients/:id/invites/:invite_id', revokeInvite],
  ['GET', '/api/v1/invites/preview', previewInvite],
  ['POST', '/api/v1/invites/accept', acceptInvite]
];
