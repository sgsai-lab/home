import { HttpError, sanitizeText } from '../http.mjs';
import { deleteUserSessions, deleteWhere, findUserByEmail, getDoc, getUserById, newUser, queryDocs, saveOneTimeToken, saveUser, updateUser } from '../db.mjs';
import { listMembershipsForUser } from '../authz.mjs';
import { randomToken } from '../security.mjs';
import { siteOrigin, templates } from '../mail.mjs';
import { Checker, pageParams, sortAndPage } from '../validation.mjs';
import { publicUser, requireReauth, sendMailSafely } from './auth.mjs';

const ROLES = ['user', 'admin'];
const STATUSES = ['active', 'disabled'];

async function membershipsOf(user) {
  const memberships = await listMembershipsForUser(user.id);
  const clients = await Promise.all(memberships.map((membership) => getDoc('clients', membership.client_id)));
  return memberships
    .map((membership, index) => clients[index] && {
      client_id: membership.client_id,
      client_name: clients[index].name,
      client_slug: clients[index].slug,
      primary_sector: clients[index].primary_sector,
      role: membership.role
    })
    .filter(Boolean)
    .sort((a, b) => a.client_name.localeCompare(b.client_name));
}

async function me(ctx) {
  const { user } = await ctx.auth();
  return ctx.send(200, { ...publicUser(user), memberships: await membershipsOf(user) });
}

async function updateMe(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const check = new Checker(await ctx.body());
  check.text('full_name', { max: 120, min: 1 });
  check.url('avatar_url');
  const updates = check.done();
  if (Object.hasOwn(check.input, 'default_client_id')) {
    const clientId = check.input.default_client_id;
    const memberships = await membershipsOf(user);
    if (clientId !== null && !memberships.some((membership) => membership.client_id === clientId) && user.role !== 'admin') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Choose one of your workspaces.', [{ field: 'default_client_id', message: 'Not one of your workspaces.' }]);
    }
    updates.default_client_id = clientId;
  }
  const updated = await updateUser(user.id, updates);
  return ctx.send(200, { ...publicUser(updated), memberships: await membershipsOf(updated) });
}

/** Removes personal data but keeps the id so audit history and references stay consistent. */
async function anonymize(user) {
  await deleteUserSessions(user.id);
  await deleteWhere('memberships', [['user_id', '==', user.id]]);
  const now = new Date().toISOString();
  await saveUser({
    id: user.id,
    email: `deleted+${user.id}@invalid`,
    full_name: 'Deleted user',
    avatar_url: null,
    role: 'user',
    status: 'deleted',
    provider: null,
    provider_id: null,
    email_verified: false,
    created_at: user.created_at,
    updated_at: now,
    deleted_at: now
  });
}

async function deleteMe(ctx) {
  const { session, user } = await ctx.auth();
  const owned = (await membershipsOf(user)).filter((membership) => membership.role === 'owner');
  for (const membership of owned) {
    const owners = await queryDocs('memberships', { where: [['client_id', '==', membership.client_id], ['role', '==', 'owner'], ['status', '==', 'active']] });
    if (owners.length <= 1) throw new HttpError(409, 'LAST_OWNER', `Transfer ownership of ${membership.client_name} before deleting your account.`);
  }
  await requireReauth(ctx, user, session, await ctx.body({ optional: true }));
  await ctx.audit('user.deleted', { type: 'user', id: user.id }, { actorId: user.id });
  await anonymize(user);
  return ctx.send(200, { ok: true });
}

function adminUser(user) {
  return publicUser(user);
}

async function listUsers(ctx) {
  await ctx.admin();
  const params = pageParams(ctx.query, { sortFields: ['created_at', 'full_name', 'email', 'last_login_at'] });
  const where = [];
  const role = ctx.query.get('role');
  const status = ctx.query.get('status');
  if (ROLES.includes(role)) where.push(['role', '==', role]);
  if ([...STATUSES, 'deleted'].includes(status)) where.push(['status', '==', status]);
  let users = await queryDocs('users', { where, limit: 5000 });
  if (!status) users = users.filter((user) => user.status !== 'deleted');
  const q = sanitizeText(ctx.query.get('q'), 100).toLowerCase();
  if (q) users = users.filter((user) => user.email.includes(q) || user.full_name.toLowerCase().includes(q));
  const page = sortAndPage(users, params);
  return ctx.send(200, { ...page, items: page.items.map(adminUser) });
}

async function createUser(ctx) {
  const { user: actor } = await ctx.admin();
  ctx.limit('mutations', actor.id);
  const check = new Checker(await ctx.body());
  const fullName = check.text('full_name', { required: true, max: 120 });
  const email = check.email('email');
  const role = check.oneOf('role', ROLES) ?? 'user';
  check.done();
  if (await findUserByEmail(email)) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
  const user = await saveUser(newUser({ email, name: fullName, provider: 'password', emailVerified: false, role }));
  const token = randomToken();
  await saveOneTimeToken('password_resets', token, { user_id: user.id }, 24 * 60 * 60 * 1000);
  const emailSent = await sendMailSafely(ctx, email, templates.accountCreated(siteOrigin(ctx.env), token, fullName));
  await ctx.audit('user.created', { type: 'user', id: user.id }, { actorId: actor.id, diff: { role } });
  return ctx.send(201, { ...adminUser(user), email_sent: emailSent });
}

async function updateUserAsAdmin(ctx) {
  const { user: actor } = await ctx.admin();
  ctx.limit('mutations', actor.id);
  const target = await getUserById(ctx.params.id);
  if (!target || target.status === 'deleted') throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  const check = new Checker(await ctx.body());
  check.text('full_name', { max: 120, min: 1 });
  check.oneOf('role', ROLES);
  check.oneOf('status', STATUSES);
  const updates = check.done();
  if (target.id === actor.id && (('role' in updates && updates.role !== target.role) || ('status' in updates && updates.status !== target.status))) {
    throw new HttpError(400, 'SELF_MODIFICATION', 'You cannot change your own role or status.');
  }
  const updated = await updateUser(target.id, updates);
  if (updates.status === 'disabled' && target.status !== 'disabled') await deleteUserSessions(target.id);
  const diff = Object.fromEntries(Object.keys(updates).filter((key) => key !== 'full_name').map((key) => [key, { from: target[key], to: updates[key] }]));
  await ctx.audit('user.updated', { type: 'user', id: target.id }, { actorId: actor.id, diff });
  return ctx.send(200, adminUser(updated));
}

async function deleteUserAsAdmin(ctx) {
  const { user: actor } = await ctx.admin();
  if (ctx.params.id === actor.id) throw new HttpError(400, 'SELF_MODIFICATION', 'Delete your own account from the account page.');
  const target = await getUserById(ctx.params.id);
  if (!target || target.status === 'deleted') throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  await ctx.audit('user.deleted', { type: 'user', id: target.id }, { actorId: actor.id });
  await anonymize(target);
  return ctx.send(200, { ok: true });
}

export const userRoutes = [
  ['GET', '/api/v1/users/me', me],
  ['PATCH', '/api/v1/users/me', updateMe],
  ['DELETE', '/api/v1/users/me', deleteMe],
  ['GET', '/api/v1/users', listUsers],
  ['POST', '/api/v1/users', createUser],
  ['PATCH', '/api/v1/users/:id', updateUserAsAdmin],
  ['DELETE', '/api/v1/users/:id', deleteUserAsAdmin]
];
