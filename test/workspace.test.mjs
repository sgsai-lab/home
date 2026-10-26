import test from 'node:test';
import assert from 'node:assert/strict';
import { account, call, fakeStorage, PASSWORD, start, tokenFrom } from './helpers.mjs';
import { queryDocs } from '../src/server/db.mjs';

async function setup(t, options) {
  const ctx = await start(t, options);
  const admin = await account(ctx.baseUrl, 'admin@sgs.test', { role: 'admin', name: 'SGS Admin' });
  const client = await call(ctx.baseUrl, '/api/v1/clients', {
    method: 'POST', token: admin.token, body: { name: 'Riverside Academy', primary_sector: 'education', contact: { email: 'office@riverside.example' } }
  });
  assert.equal(client.status, 201, JSON.stringify(client.data));
  return { ...ctx, admin, client: client.data };
}

async function member(ctx, email, role) {
  const person = await account(ctx.baseUrl, email);
  const added = await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/members`, { method: 'POST', token: ctx.admin.token, body: { email, role } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  return person;
}

test('SGS admins create workspaces; members only see their own', async (t) => {
  const ctx = await setup(t);
  const { baseUrl, admin, client } = ctx;
  assert.equal(client.slug, 'riverside-academy');
  assert.equal(client.my_role, 'owner');
  assert.equal(client.member_count, 1);

  const second = await call(baseUrl, '/api/v1/clients', { method: 'POST', token: admin.token, body: { name: 'Riverside Academy', primary_sector: 'business' } });
  assert.equal(second.data.slug, 'riverside-academy-2');

  const teacher = await member(ctx, 'teacher@riverside.example', 'member');
  assert.equal((await call(baseUrl, '/api/v1/clients', { method: 'POST', token: teacher.token, body: { name: 'X', primary_sector: 'business' } })).status, 403);
  const mine = await call(baseUrl, '/api/v1/clients', { token: teacher.token });
  assert.deepEqual(mine.data.items.map((item) => [item.name, item.my_role]), [['Riverside Academy', 'member']]);
  assert.equal((await call(baseUrl, `/api/v1/clients/${second.data.id}`, { token: teacher.token })).status, 404, 'other workspaces are invisible');

  const me = await call(baseUrl, '/api/v1/users/me', { token: teacher.token });
  assert.deepEqual(me.data.memberships.map((item) => item.client_name), ['Riverside Academy']);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { method: 'PATCH', token: teacher.token, body: { default_client_id: second.data.id } })).status, 400);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { method: 'PATCH', token: teacher.token, body: { default_client_id: client.id } })).data.default_client_id, client.id);

  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}`, { method: 'PATCH', token: teacher.token, body: { name: 'Hijack' } })).status, 403);
  const invalid = await call(baseUrl, `/api/v1/clients/${client.id}`, { method: 'PATCH', token: admin.token, body: { primary_sector: 'farming', branding: { primary_color: 'blue' } } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.data.error.details.map((detail) => detail.field).sort(), ['branding.primary_color', 'primary_sector']);
});

test('invitations: email match, single use, resend invalidates, preview is minimal', async (t) => {
  const ctx = await setup(t);
  const { baseUrl, admin, client, mail } = ctx;
  const invited = await call(baseUrl, `/api/v1/clients/${client.id}/invites`, { method: 'POST', token: admin.token, body: { email: 'Head@Riverside.example', role: 'admin' } });
  assert.equal(invited.status, 201);
  assert.equal(invited.data.email, 'head@riverside.example');
  const firstToken = tokenFrom(mail.at(-1), '/workspace/join/');

  const resent = await call(baseUrl, `/api/v1/clients/${client.id}/invites/${invited.data.id}/resend`, { method: 'POST', token: admin.token });
  assert.equal(resent.status, 200);
  const token = tokenFrom(mail.at(-1), '/workspace/join/');
  assert.equal((await call(baseUrl, `/api/v1/invites/preview?token=${firstToken}`)).status, 404, 'resending invalidates the old link');
  assert.deepEqual((await call(baseUrl, `/api/v1/invites/preview?token=${encodeURIComponent(token)}`)).data, {
    client_name: 'Riverside Academy', primary_sector: 'education', role: 'admin', email: 'head@riverside.example'
  });

  const stranger = await account(baseUrl, 'y@example.com');
  const mismatch = await call(baseUrl, '/api/v1/invites/accept', { method: 'POST', token: stranger.token, body: { token } });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.data.error.code, 'INVITE_EMAIL_MISMATCH');

  // Signing up with the invitation verifies the address and joins the workspace in one step.
  const signedUp = await call(baseUrl, '/api/v1/auth/signup', { method: 'POST', body: { full_name: 'Head Teacher', email: 'head@riverside.example', password: PASSWORD, accept_terms: true, invite_token: token } });
  assert.deepEqual(signedUp.data, { email: 'head@riverside.example', verification_required: false });
  const head = await call(baseUrl, '/api/v1/auth/login', { method: 'POST', body: { email: 'head@riverside.example', password: PASSWORD } });
  assert.equal(head.status, 200);
  assert.equal(head.data.user.default_client_id, client.id);
  const again = await call(baseUrl, '/api/v1/invites/accept', { method: 'POST', token: head.data.access_token, body: { token } });
  assert.equal(again.status, 410);
  assert.equal(again.data.error.code, 'INVITE_CONSUMED');

  const pending = await call(baseUrl, `/api/v1/clients/${client.id}/invites`, { method: 'POST', token: admin.token, body: { email: 'later@example.com', role: 'viewer' } });
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/invites`, { token: admin.token })).data.items.length, 1);
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/invites/${pending.data.id}`, { method: 'DELETE', token: admin.token })).status, 200);
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/invites`, { token: admin.token })).data.items.length, 0);

  const already = await call(baseUrl, `/api/v1/clients/${client.id}/invites`, { method: 'POST', token: admin.token, body: { email: 'head@riverside.example', role: 'member' } });
  assert.equal(already.status, 409);
});

test('an existing account accepts an invitation while signed in', async (t) => {
  const ctx = await setup(t);
  const { baseUrl, admin, client, mail } = ctx;
  const person = await account(baseUrl, 'ops@example.com');
  await call(baseUrl, `/api/v1/clients/${client.id}/invites`, { method: 'POST', token: admin.token, body: { email: 'ops@example.com', role: 'member' } });
  const accepted = await call(baseUrl, '/api/v1/invites/accept', { method: 'POST', token: person.token, body: { token: tokenFrom(mail.at(-1), '/workspace/join/') } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.client.my_role, 'member');
});

test('roles: the last owner cannot leave or be demoted; only owners create owners', async (t) => {
  const ctx = await setup(t);
  const { baseUrl, admin, client } = ctx;
  const owner = await member(ctx, 'owner@riverside.example', 'owner');
  // Client admins invite people; direct adds (which reveal whether an account exists) are SGS-only.
  await account(baseUrl, 'probe-target@example.com');
  const probe = await call(baseUrl, `/api/v1/clients/${client.id}/members`, { method: 'POST', token: owner.token, body: { email: 'probe-target@example.com', role: 'viewer' } });
  assert.equal(probe.status, 403);
  const helper = await member(ctx, 'helper@riverside.example', 'admin');
  // The SGS admin who created the workspace is also an owner; remove that so `owner` is the last one.
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/members/${admin.user.id}`, { method: 'DELETE', token: owner.token })).status, 200);

  const lastLeave = await call(baseUrl, `/api/v1/clients/${client.id}/members/${owner.user.id}`, { method: 'DELETE', token: owner.token });
  assert.equal(lastLeave.status, 409);
  assert.equal(lastLeave.data.error.code, 'LAST_OWNER');
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/members/${owner.user.id}`, { method: 'PATCH', token: owner.token, body: { role: 'admin' } })).data.error.code, 'LAST_OWNER');
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/members/${helper.user.id}`, { method: 'PATCH', token: helper.token, body: { role: 'owner' } })).status, 403);
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/members/${owner.user.id}`, { method: 'DELETE', token: helper.token })).status, 403);

  const members = await call(baseUrl, `/api/v1/clients/${client.id}/members`, { token: helper.token });
  assert.deepEqual(members.data.items.map((item) => item.role), ['owner', 'admin']);
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/members/${helper.user.id}`, { method: 'DELETE', token: helper.token })).status, 200, 'non-owners can leave');
});

test('projects: tenancy, validation, ETag concurrency, sector profiles, soft delete and restore', async (t) => {
  const ctx = await setup(t);
  const { baseUrl, admin, client } = ctx;
  const lead = await member(ctx, 'lead@riverside.example', 'admin');
  const teacher = await member(ctx, 'teacher@riverside.example', 'viewer');
  const other = await call(baseUrl, '/api/v1/clients', { method: 'POST', token: admin.token, body: { name: 'Acme Ltd', primary_sector: 'business' } });
  const outsider = await account(baseUrl, 'outsider@acme.example');
  await call(baseUrl, `/api/v1/clients/${other.data.id}/members`, { method: 'POST', token: admin.token, body: { email: 'outsider@acme.example', role: 'owner' } });

  const invalid = await call(baseUrl, '/api/v1/projects', {
    method: 'POST', token: lead.token,
    body: { client_id: client.id, name: 'Portal', start_date: '2026-11-10', end_date: '2026-11-01', sector_profile: { engagement_type: 'build' } }
  });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.data.error.details.some((detail) => detail.field === 'sector_profile.engagement_type'));

  const created = await call(baseUrl, '/api/v1/projects', {
    method: 'POST', token: lead.token,
    body: { client_id: client.id, name: 'Learning portal', summary: 'Course PWA', tags: ['LMS', 'lms', 'pwa'], use_template: true, sector_profile: { institution_type: 'school', programme: 'Year 9 science', academic_year: '2026/27' } }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const project = created.data;
  assert.equal(project.sector, 'education', 'sector defaults to the workspace primary sector');
  assert.deepEqual(project.tags, ['lms', 'pwa']);
  assert.deepEqual(project.milestones.map((milestone) => milestone.title), ['Needs analysis', 'Pilot cohort', 'Rollout', 'Term review']);
  const etag = created.headers.get('etag');

  assert.equal((await call(baseUrl, '/api/v1/projects', { method: 'POST', token: teacher.token, body: { client_id: client.id, name: 'Nope' } })).status, 403, 'viewers cannot create');
  assert.equal((await call(baseUrl, `/api/v1/projects/${project.id}`, { token: outsider.token })).status, 404, 'other tenants cannot read');
  assert.equal((await call(baseUrl, `/api/v1/projects/${project.id}`, { method: 'PATCH', token: outsider.token, body: { name: 'x' } })).status, 404);
  assert.equal((await call(baseUrl, `/api/v1/projects?client_id=${client.id}`, { token: outsider.token })).status, 404);
  assert.equal((await call(baseUrl, '/api/v1/projects', { token: outsider.token })).data.total, 0);

  const viewerList = await call(baseUrl, '/api/v1/projects?q=portal', { token: teacher.token });
  assert.equal(viewerList.data.total, 1);
  assert.equal(viewerList.data.items[0].can_edit, false);

  const first = await call(baseUrl, `/api/v1/projects/${project.id}`, { method: 'PATCH', token: lead.token, headers: { 'if-match': etag }, body: { status: 'in_progress' } });
  assert.equal(first.status, 200);
  const stale = await call(baseUrl, `/api/v1/projects/${project.id}`, { method: 'PATCH', token: lead.token, headers: { 'if-match': etag }, body: { status: 'on_hold' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.data.error.code, 'PRECONDITION_FAILED');
  const moved = await call(baseUrl, `/api/v1/projects/${project.id}`, { method: 'PATCH', token: lead.token, body: { client_id: other.data.id } });
  assert.equal(moved.status, 400);

  const milestones = first.data.milestones.map((milestone, index) => ({ ...milestone, done: index === 0 }));
  const toggled = await call(baseUrl, `/api/v1/projects/${project.id}`, { method: 'PATCH', token: lead.token, headers: { 'if-match': first.headers.get('etag') }, body: { milestones } });
  assert.equal(toggled.data.milestones[0].done, true);

  assert.equal((await call(baseUrl, `/api/v1/projects/${project.id}`, { method: 'DELETE', token: teacher.token })).status, 403);
  const deleted = await call(baseUrl, `/api/v1/projects/${project.id}`, { method: 'DELETE', token: lead.token });
  assert.equal(deleted.status, 200);
  assert.ok(deleted.data.restore_until);
  assert.equal((await call(baseUrl, `/api/v1/projects/${project.id}`, { token: teacher.token })).status, 404);
  assert.equal((await call(baseUrl, '/api/v1/projects?deleted=only', { token: lead.token })).data.total, 1);
  assert.equal((await call(baseUrl, '/api/v1/projects?deleted=only', { token: teacher.token })).data.total, 0);
  const restored = await call(baseUrl, `/api/v1/projects/${project.id}/restore`, { method: 'POST', token: lead.token });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.status, 'in_progress');
  assert.equal(restored.data.milestones[0].done, true);

  const business = await call(baseUrl, '/api/v1/projects', {
    method: 'POST', token: admin.token, body: { client_id: client.id, name: 'Admin tooling', sector: 'business', sector_profile: { engagement_type: 'build', department: 'Finance' }, use_template: true }
  });
  assert.equal(business.data.milestones[0].title, 'Discovery');
  assert.equal((await call(baseUrl, '/api/v1/projects?sector=business', { token: teacher.token })).data.total, 1);
});

async function product(ctx, body, token = ctx.admin.token) {
  return call(ctx.baseUrl, '/api/v1/products', { method: 'POST', token, body: { client_id: ctx.client.id, ...body } });
}

test('products: validation, unique slugs, public publishing is SGS-only, catalog lists public apps', async (t) => {
  const ctx = await setup(t);
  const { baseUrl, admin, client } = ctx;
  const lead = await member(ctx, 'lead@riverside.example', 'admin');

  const unsafe = await product(ctx, { kind: 'pwa', name: 'Bad', launch_url: 'javascript:alert(1)' });
  assert.equal(unsafe.status, 400);
  assert.equal(unsafe.data.error.details[0].field, 'launch_url');
  assert.equal((await product(ctx, { kind: 'pwa', name: 'Plain', launch_url: 'http://insecure.example' })).status, 400);
  assert.equal((await product(ctx, { kind: 'android', name: 'No links' })).status, 400);

  const portal = await product(ctx, { kind: 'pwa', name: 'Learning Portal', launch_url: 'https://learn.riverside.example/app', status: 'live' }, lead.token);
  assert.equal(portal.status, 201);
  assert.equal(portal.data.slug, 'learning-portal');
  assert.equal(portal.data.visibility, 'client');
  const taken = await product(ctx, { kind: 'pwa', name: 'Learning Portal', launch_url: 'https://other.example' });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error.details[0].message, /learning-portal-2/);

  assert.equal((await product(ctx, { kind: 'pwa', name: 'Public by client', launch_url: 'https://x.example', visibility: 'public' }, lead.token)).status, 400);
  assert.equal((await call(baseUrl, `/api/v1/products/${portal.data.id}`, { method: 'PATCH', token: lead.token, body: { visibility: 'public' } })).status, 400);

  const showcase = await product(ctx, { kind: 'pwa', name: 'Showcase', slug: 'showcase', launch_url: 'https://showcase.example', visibility: 'public', status: 'beta', summary: 'Demo' });
  assert.equal(showcase.status, 201);
  const catalog = await call(baseUrl, '/api/v1/catalog');
  assert.equal(catalog.status, 200);
  assert.match(catalog.headers.get('cache-control'), /public/);
  assert.deepEqual(catalog.data.items.map((item) => [item.slug, item.sector, item.launch_path]), [['showcase', 'education', '/go/showcase']]);
  assert.ok(!('client_id' in catalog.data.items[0]), 'the public catalog exposes no tenant ids');

  const listed = await call(baseUrl, `/api/v1/products?client_id=${client.id}`, { token: lead.token });
  assert.equal(listed.data.total, 2);
  assert.equal((await call(baseUrl, `/api/v1/products/${portal.data.id}`, { method: 'DELETE', token: admin.token })).status, 200);
});

test('launch links: client apps require a member launch token, events are recorded, retired apps explain', async (t) => {
  const ctx = await setup(t);
  const { baseUrl, admin } = ctx;
  const teacher = await member(ctx, 'teacher@riverside.example', 'viewer');
  const outsider = await account(baseUrl, 'outsider@example.com');
  const portal = (await product(ctx, { kind: 'pwa', name: 'Learning Portal', launch_url: 'https://learn.riverside.example/app?x=1', status: 'live' })).data;

  const anonymous = await call(baseUrl, '/go/learning-portal');
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/workspace/launch/?slug=learning-portal');

  assert.equal((await call(baseUrl, `/api/v1/products/${portal.id}/launch-token`, { method: 'POST', token: outsider.token })).status, 404);
  assert.equal((await call(baseUrl, '/api/v1/products/by-slug/learning-portal', { token: outsider.token })).status, 403);
  assert.equal((await call(baseUrl, '/api/v1/products/by-slug/learning-portal')).status, 401);
  assert.equal((await call(baseUrl, '/api/v1/products/by-slug/learning-portal', { token: teacher.token })).data.id, portal.id);

  const issued = await call(baseUrl, `/api/v1/products/${portal.id}/launch-token`, { method: 'POST', token: teacher.token, headers: { 'x-client': 'mobile', 'x-client-platform': 'android' } });
  assert.equal(issued.status, 201);
  assert.equal(issued.data.expires_in, 60);
  assert.match(issued.data.url, /^https:\/\/site\.test\/go\/learning-portal\?t=.+&src=android$/);
  const launched = await call(baseUrl, issued.data.path);
  assert.equal(launched.status, 302);
  const target = new URL(launched.headers.get('location'));
  assert.equal(target.origin + target.pathname, 'https://learn.riverside.example/app');
  assert.equal(target.searchParams.get('x'), '1');
  assert.equal(target.searchParams.get('utm_source'), 'sgsai_hub');
  assert.equal(target.searchParams.get('utm_medium'), 'android');
  assert.equal((await call(baseUrl, issued.data.path)).headers.get('location'), '/workspace/launch/?slug=learning-portal', 'launch tokens are single-use');

  const events = await queryDocs('launch_events', { where: [['product_id', '==', portal.id]] });
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'android');
  assert.equal(events[0].user_id, teacher.user.id);
  const stats = await call(baseUrl, `/api/v1/products/${portal.id}/launches`, { token: admin.token });
  assert.deepEqual(stats.data.by_source, { web: 0, android: 1, ios: 0, link: 0 });

  const publicApp = (await product(ctx, { kind: 'web', name: 'Open Day', launch_url: 'https://open.example', visibility: 'public', status: 'live' })).data;
  const open = await call(baseUrl, `/go/${publicApp.slug}`);
  assert.equal(open.status, 302);
  assert.equal(new URL(open.headers.get('location')).searchParams.get('utm_medium'), 'link');

  await call(baseUrl, `/api/v1/products/${portal.id}`, { method: 'PATCH', token: admin.token, body: { status: 'retired', name: 'Portal & Co' } });
  const retired = await call(baseUrl, '/go/learning-portal');
  assert.equal(retired.status, 410);
  assert.match(retired.data, /retired/);
  assert.match(retired.data, /href="mailto:office@riverside\.example"/);
  assert.match(retired.data, /Portal &#38; Co is no longer available/, 'product names are escaped');
  assert.equal((await call(baseUrl, '/go/does-not-exist')).status, 404);
  assert.equal((await call(baseUrl, '/go/%3Cscript%3E')).status, 404);
});

test('assets: signed uploads with type and size limits, confirmation, scoped reads, public icons', async (t) => {
  const storage = fakeStorage();
  const ctx = await setup(t, { storage });
  const { baseUrl, admin, client } = ctx;
  const teacher = await member(ctx, 'teacher@riverside.example', 'viewer');
  const outsider = await account(baseUrl, 'outsider@example.com');
  const upload = (body, token = admin.token) => call(baseUrl, '/api/v1/assets/upload-url', { method: 'POST', token, body });
  const logo = { owner: { type: 'client', id: client.id }, purpose: 'logo', kind: 'image', filename: 'Crest.PNG', content_type: 'image/png', size_bytes: 2048, alt_text: 'Riverside crest' };

  assert.equal((await upload({ ...logo, size_bytes: 12 * 1024 * 1024 })).data.error.details[0].field, 'size_bytes');
  const html = await upload({ ...logo, content_type: 'text/html' });
  assert.equal(html.status, 400);
  assert.equal(html.data.error.code, 'UNSUPPORTED_TYPE');
  assert.equal((await upload({ ...logo, alt_text: '' })).status, 400, 'logos need alt text');
  assert.equal((await upload(logo, teacher.token)).status, 403);
  assert.equal((await upload(logo, outsider.token)).status, 404);

  const requested = await upload(logo);
  assert.equal(requested.status, 201);
  const { asset, upload: signed } = requested.data;
  assert.equal(asset.status, 'pending');
  assert.equal(signed.method, 'PUT');
  assert.equal(signed.headers['x-goog-content-length-range'], '2048,2048');
  const [stored] = await queryDocs('assets', { where: [['id', '==', asset.id]] });
  assert.match(stored.gcs_object, new RegExp(`^clients/${client.id}/image/${asset.id}-crest\\.png$`));
  assert.equal(stored.gcs_pending_object, `pending/${stored.gcs_object}`);
  assert.match(signed.url, /\/pending\/clients\//, 'uploads go to the pending/ prefix');

  const early = await call(baseUrl, `/api/v1/assets/${asset.id}/confirm`, { method: 'POST', token: admin.token });
  assert.equal(early.data.error.code, 'OBJECT_MISSING');
  storage.objects.set(stored.gcs_pending_object, { size: 2048, contentType: 'image/png', md5: 'abc' });
  const confirmed = await call(baseUrl, `/api/v1/assets/${asset.id}/confirm`, { method: 'POST', token: admin.token });
  assert.equal(confirmed.data.status, 'ready');
  assert.ok(storage.objects.has(stored.gcs_object) && !storage.objects.has(stored.gcs_pending_object), 'confirm moves the object out of pending/');
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}`, { token: teacher.token })).data.branding.logo_asset_id, asset.id);

  const read = await call(baseUrl, `/api/v1/assets/${asset.id}/url`, { token: teacher.token });
  assert.equal(read.status, 200);
  assert.match(read.data.url, /sig=read/);
  assert.equal((await call(baseUrl, `/api/v1/assets/${asset.id}/url`, { token: outsider.token })).status, 404);
  assert.equal((await call(baseUrl, `/api/v1/assets?owner_type=client&owner_id=${client.id}`, { token: teacher.token })).data.items.length, 1);

  const mismatched = (await upload({ ...logo, filename: 'b.png' })).data.asset;
  const [mismatchDoc] = await queryDocs('assets', { where: [['id', '==', mismatched.id]] });
  storage.objects.set(mismatchDoc.gcs_pending_object, { size: 999, contentType: 'image/png' });
  assert.equal((await call(baseUrl, `/api/v1/assets/${mismatched.id}/confirm`, { method: 'POST', token: admin.token })).data.error.code, 'OBJECT_MISMATCH');
  assert.equal(storage.objects.has(mismatchDoc.gcs_pending_object), false, 'mismatched uploads are removed');

  const app = (await product(ctx, { kind: 'pwa', name: 'Portal', launch_url: 'https://p.example', status: 'live' })).data;
  const icon = (await upload({ owner: { type: 'product', id: app.id }, purpose: 'icon', kind: 'image', filename: 'icon.png', content_type: 'image/png', size_bytes: 100, alt_text: 'Portal icon' })).data.asset;
  const [iconDoc] = await queryDocs('assets', { where: [['id', '==', icon.id]] });
  storage.objects.set(iconDoc.gcs_pending_object, { size: 100, contentType: 'image/png' });
  await call(baseUrl, `/api/v1/assets/${icon.id}/confirm`, { method: 'POST', token: admin.token });
  assert.equal(storage.published.size, 0, 'client-only products never publish icons');
  const published = await call(baseUrl, `/api/v1/products/${app.id}`, { method: 'PATCH', token: admin.token, body: { visibility: 'public' } });
  assert.match(published.data.public_icon_url, /^https:\/\/storage\.googleapis\.com\/public-test\/products\//);
  assert.equal(storage.published.size, 1);
  const hidden = await call(baseUrl, `/api/v1/products/${app.id}`, { method: 'PATCH', token: admin.token, body: { visibility: 'client' } });
  assert.equal(hidden.data.public_icon_url, null);
  assert.equal(storage.published.size, 0, 'hiding a product removes its public icon');

  assert.equal((await call(baseUrl, `/api/v1/assets/${asset.id}`, { method: 'DELETE', token: admin.token })).status, 200);
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}`, { token: admin.token })).data.branding.logo_asset_id, null);
});

test('assets report 503 when storage is not configured', async (t) => {
  const ctx = await setup(t, { storage: { configured: false } });
  const response = await call(ctx.baseUrl, '/api/v1/assets/upload-url', { method: 'POST', token: ctx.admin.token, body: {} });
  assert.equal(response.status, 503);
  assert.equal(response.data.error.code, 'STORAGE_NOT_CONFIGURED');
});

test('audit log records changes without secrets and is visible to owners and SGS admins only', async (t) => {
  const ctx = await setup(t);
  const { baseUrl, admin, client } = ctx;
  const lead = await member(ctx, 'lead@riverside.example', 'admin');
  await call(baseUrl, `/api/v1/clients/${client.id}/members/${lead.user.id}`, { method: 'PATCH', token: admin.token, body: { role: 'member' } });
  await call(baseUrl, `/api/v1/clients/${client.id}/invites`, { method: 'POST', token: admin.token, body: { email: 'x@example.com', role: 'viewer' } });

  assert.equal((await call(baseUrl, `/api/v1/audit?client_id=${client.id}`, { token: lead.token })).status, 403);
  assert.equal((await call(baseUrl, '/api/v1/audit', { token: lead.token })).status, 403);
  const log = await call(baseUrl, `/api/v1/audit?client_id=${client.id}`, { token: admin.token });
  assert.equal(log.status, 200);
  const roleChange = log.data.items.find((entry) => entry.action === 'member.role_changed');
  assert.deepEqual(roleChange.diff.role, { from: 'admin', to: 'member' });
  assert.ok(!JSON.stringify(log.data).match(/token|password/i));
  assert.ok(log.data.items.every((entry) => !('ip_hash' in entry)));
});

test('per-user mutation limit: the 61st change in ten minutes is throttled', async (t) => {
  const ctx = await setup(t, { realLimits: true });
  const { baseUrl, admin, client } = ctx;
  let last;
  for (let index = 0; index < 61; index += 1) {
    last = await call(baseUrl, `/api/v1/clients/${client.id}`, { method: 'PATCH', token: admin.token, body: { name: `Riverside ${index}` } });
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});
