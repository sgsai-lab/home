import test from 'node:test';
import assert from 'node:assert/strict';
import { account, call, start, tokenFrom } from './helpers.mjs';
import { getDoc, queryDocs, setDoc } from '../src/server/db.mjs';

async function setup(t) {
  const { baseUrl, mail } = await start(t);
  const issuer = await account(baseUrl, 'issuer@sgs.test', { role: 'admin' });
  const owner = await account(baseUrl, 'owner@customer.test');
  const client = (await call(baseUrl, '/api/v1/clients', {
    method: 'POST', token: issuer.token, body: { name: 'CRM customer', primary_sector: 'business' }
  })).data;
  assert.equal((await call(baseUrl, `/api/v1/clients/${client.id}/members`, {
    method: 'POST', token: issuer.token, body: { email: owner.user.email, role: 'owner' }
  })).status, 201);
  const project = (await call(baseUrl, '/api/v1/projects', {
    method: 'POST', token: issuer.token, body: { client_id: client.id, name: 'Customer portal' }
  })).data;
  const assignment = await call(baseUrl, `/api/v1/crm/issuer-operators/${issuer.user.id}`, {
    method: 'PUT', token: issuer.token, body: { active: true, reason: 'Designated SGS billing operator' }
  });
  assert.equal(assignment.status, 200, JSON.stringify(assignment.data));
  return { baseUrl, mail, issuer, owner, client, project };
}

const terms = {
  name: 'Portal delivery', scope: 'Build and hand over the customer portal.',
  amount_minor: 12000000, billing_method: 'fixed', currency: 'INR',
  start_date: '2026-11-01', end_date: '2026-12-31', expected_close_date: '2026-11-15'
};

async function createDeal(ctx, body = terms) {
  const response = await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}/deals`, {
    method: 'POST', token: ctx.issuer.token, body
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response;
}

async function action(ctx, deal, name, token = ctx.issuer.token, body = {}, key = name) {
  return call(ctx.baseUrl, `/api/v1/crm/deals/${deal.data.id}/${name}`, {
    method: 'POST', token, body,
    headers: { 'If-Match': deal.headers.get('etag'), 'Idempotency-Key': key }
  });
}

test('CRM: real owners only; SGS admin and project creator do not bypass membership', async (t) => {
  const ctx = await setup(t);
  const deal = await createDeal(ctx);
  const admin = await account(ctx.baseUrl, 'support@sgs.test', { role: 'admin' });
  const viewer = await account(ctx.baseUrl, 'viewer@customer.test');
  await setDoc('memberships', `${ctx.client.id}__${viewer.user.id}`, {
    client_id: ctx.client.id, user_id: viewer.user.id, role: 'viewer', status: 'active'
  });
  for (const [person, status] of [[admin, 404], [viewer, 403]]) {
    assert.equal((await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/crm/capabilities`, { token: person.token })).status, status);
    assert.equal((await call(ctx.baseUrl, `/api/v1/crm/deals/${deal.data.id}`, { token: person.token })).status, status);
    assert.equal((await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}/deals`, { token: person.token })).status, status);
  }
  const caps = await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/crm/capabilities`, { token: ctx.owner.token });
  assert.equal(caps.data.can_prepare, false);
  assert.equal(caps.data.can_accept, true);
  assert.equal(caps.data.invoice_issuance_enabled, false);
  assert.equal(caps.data.payment_terms_days, 30);
  assert.equal(caps.data.billing_cycle, 'month_end');
  assert.equal((await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}/deals`, {
    method: 'POST', token: ctx.owner.token, body: terms
  })).status, 403);
  const ordinary = await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}`, { token: viewer.token });
  assert.equal(ordinary.status, 200);
  assert.equal(Object.hasOwn(ordinary.data, 'amount_minor'), false);
});

test('CRM: edit, publish, accept exact revision and activate once with retained history', async (t) => {
  const ctx = await setup(t);
  let deal = await createDeal(ctx);
  const noVersion = await call(ctx.baseUrl, `/api/v1/crm/deals/${deal.data.id}`, {
    method: 'PATCH', token: ctx.issuer.token, body: { name: 'Updated portal' }
  });
  assert.equal(noVersion.status, 428);
  deal = await call(ctx.baseUrl, `/api/v1/crm/deals/${deal.data.id}`, {
    method: 'PATCH', token: ctx.issuer.token, body: { name: 'Updated portal' },
    headers: { 'If-Match': deal.headers.get('etag') }
  });
  assert.equal(deal.status, 200);
  const published = await action(ctx, deal, 'publish');
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.stage, 'proposal');
  assert.equal((await action(ctx, published, 'accept')).status, 403, 'issuer cannot accept for customer');
  const revision = published.data.current_revision_id;
  const accepted = await action(ctx, published, 'accept', ctx.owner.token, { revision_id: revision });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.accepted_revision_id, revision);
  const attempts = await Promise.all(Array.from({ length: 10 }, () => action(ctx, accepted, 'activate')));
  assert.ok(attempts.every((result) => result.status === 200), JSON.stringify(attempts));
  assert.equal(attempts[0].data.stage, 'closed_won');
  const plans = await queryDocs('billing_plans', { where: [['project_id', '==', ctx.project.id]] });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].currency, 'INR');
  assert.equal(plans[0].tax_status, 'unconfigured');
  assert.equal(plans[0].payment_terms_days, 30);
  assert.equal(plans[0].billing_cycle, 'month_end');
  assert.equal(plans[0].commercial_revision_id, revision);
  assert.equal((await queryDocs('financial_events')).filter((event) => event.action === 'deal.activated').length, 1);
  const changedReplay = await action(ctx, accepted, 'activate', ctx.issuer.token, { extra: 'changed' });
  assert.equal(changedReplay.status, 409);
  const editWon = await call(ctx.baseUrl, `/api/v1/crm/deals/${deal.data.id}`, {
    method: 'PATCH', token: ctx.issuer.token, body: { amount_minor: 1 },
    headers: { 'If-Match': attempts[0].headers.get('etag') }
  });
  assert.equal(editWon.status, 409);
  const deletion = await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}`, { method: 'DELETE', token: ctx.issuer.token });
  assert.equal(deletion.status, 409, 'finance-linked projects must not be purged after 30 days');
  assert.equal((await getDoc('projects', ctx.project.id)).expires_at, null);
});

test('CRM: edits invalidate proposals; stale versions, mismatched tenants and invalid terms fail', async (t) => {
  const ctx = await setup(t);
  assert.equal((await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}/deals`, {
    method: 'POST', token: ctx.issuer.token, body: { ...terms, end_date: '2026-02-31', amount_minor: 1.5 }
  })).status, 400);
  assert.equal((await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}/deals`, {
    method: 'POST', token: ctx.issuer.token, body: { ...terms, client_id: 'another-workspace' }
  })).status, 400);
  const deal = await createDeal(ctx);
  const published = await action(ctx, deal, 'publish');
  const changed = await call(ctx.baseUrl, `/api/v1/crm/deals/${deal.data.id}`, {
    method: 'PATCH', token: ctx.issuer.token, body: { scope: 'New agreed scope' },
    headers: { 'If-Match': published.headers.get('etag') }
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.current_revision_id, null);
  assert.equal((await action(ctx, published, 'accept', ctx.owner.token, { revision_id: published.data.current_revision_id })).status, 412);
  assert.equal((await action(ctx, changed, 'activate')).status, 409);
  const republished = await action(ctx, changed, 'publish', ctx.issuer.token, {}, 'publish-2');
  assert.notEqual(republished.data.current_revision_id, published.data.current_revision_id);
  assert.equal((await queryDocs('commercial_revisions')).length, 2);
  const page = await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/crm/deals?page_size=1`, { token: ctx.owner.token });
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.next_cursor, null);
});

test('CRM: issuer assignment audited; revocation blocks preparation immediately', async (t) => {
  const ctx = await setup(t);
  const deal = await createDeal(ctx);
  assert.equal((await call(ctx.baseUrl, `/api/v1/crm/issuer-operators/${ctx.owner.user.id}`, {
    method: 'PUT', token: ctx.owner.token, body: { active: true, reason: 'Self-grant' }
  })).status, 403);
  const revoked = await call(ctx.baseUrl, `/api/v1/crm/issuer-operators/${ctx.issuer.user.id}`, {
    method: 'PUT', token: ctx.issuer.token, body: { active: false, reason: 'Billing operator reassigned' }
  });
  assert.equal(revoked.status, 200);
  assert.equal((await action(ctx, deal, 'publish')).status, 403);
  assert.equal((await queryDocs('issuer_operator_events')).length, 2);
  const caps = await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/crm/capabilities`, { token: ctx.issuer.token });
  assert.equal(caps.data.can_accept, false, 'revoking issuer authority cannot turn SGS staff into a customer approver');
  const listed = await call(ctx.baseUrl, '/api/v1/crm/issuer-operators', { token: ctx.issuer.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.items[0].active, false);
});

test('CRM: hourly proposals, cursor filters, tenant boundaries and finance-event privacy', async (t) => {
  const ctx = await setup(t);
  const one = await createDeal(ctx, { ...terms, billing_method: 'hourly', hourly_rate_minor: 100000, planned_minutes: 7200 });
  await createDeal(ctx, { ...terms, name: 'Another project phase', stage: 'discovery' });
  const first = await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/crm/deals?page_size=1`, { token: ctx.owner.token });
  assert.ok(first.data.next_cursor);
  const next = await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/crm/deals?page_size=1&cursor=${first.data.next_cursor}`, { token: ctx.owner.token });
  assert.equal(next.data.items.length, 1);
  assert.notEqual(first.data.items[0].id, next.data.items[0].id);
  assert.equal(next.data.next_cursor, null);
  const filtered = await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/crm/deals?stage=discovery&project_id=${ctx.project.id}`, { token: ctx.owner.token });
  assert.equal(filtered.data.items.length, 1);
  assert.equal(filtered.data.items[0].stage, 'discovery');
  const otherClient = (await call(ctx.baseUrl, '/api/v1/clients', {
    method: 'POST', token: ctx.issuer.token, body: { name: 'Second customer', primary_sector: 'business' }
  })).data;
  assert.equal((await call(ctx.baseUrl, `/api/v1/clients/${otherClient.id}/crm/deals`, { token: ctx.owner.token })).status, 404);
  assert.equal((await call(ctx.baseUrl, `/api/v1/clients/${otherClient.id}/crm/deals?project_id=${ctx.project.id}`, { token: ctx.issuer.token })).status, 404);
  const published = await action(ctx, one, 'publish');
  const accepted = await action(ctx, published, 'accept', ctx.owner.token, { revision_id: published.data.current_revision_id });
  const activated = await action(ctx, accepted, 'activate');
  assert.equal(activated.status, 200);
  const plan = (await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}/billing-plan`, { token: ctx.owner.token })).data.plan;
  assert.equal(plan.hourly_rate_minor, 100000);
  assert.equal(plan.planned_minutes, 7200);
  const events = await call(ctx.baseUrl, `/api/v1/projects/${ctx.project.id}/finance-events`, { token: ctx.owner.token });
  assert.equal(events.data.items.length, 5);
  const audit = await call(ctx.baseUrl, '/api/v1/audit', { token: ctx.issuer.token });
  assert.ok(audit.data.items.every((event) => !event.action.startsWith('deal.')));
  const customerMembership = `${ctx.client.id}__${ctx.owner.user.id}`;
  await setDoc('memberships', customerMembership, { ...(await getDoc('memberships', customerMembership)), status: 'removed' });
  assert.equal((await call(ctx.baseUrl, `/api/v1/crm/deals/${one.data.id}`, { token: ctx.owner.token })).status, 404);
});

test('CRM: support cannot self-grant owner through members or invitations', async (t) => {
  const ctx = await setup(t);
  const support = await account(ctx.baseUrl, 'support@sgs.test', { role: 'admin' });
  assert.equal((await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/members`, {
    method: 'POST', token: support.token, body: { email: support.user.email, role: 'owner' }
  })).status, 404);
  assert.equal((await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/members/${ctx.owner.user.id}`, {
    method: 'PATCH', token: support.token, body: { role: 'member' }
  })).status, 404);
  assert.equal((await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/invites`, {
    method: 'POST', token: support.token, body: { email: 'another@sgs.test', role: 'owner' }
  })).status, 404);
  const invited = await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/invites`, {
    method: 'POST', token: ctx.issuer.token, body: { email: support.user.email, role: 'owner' }
  });
  const token = tokenFrom(ctx.mail.at(-1), '/workspace/join/');
  assert.equal((await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/invites/${invited.data.id}/resend`, {
    method: 'POST', token: support.token
  })).status, 404);
  await call(ctx.baseUrl, `/api/v1/clients/${ctx.client.id}/members/${ctx.issuer.user.id}`, {
    method: 'DELETE', token: ctx.owner.token
  });
  assert.equal((await call(ctx.baseUrl, '/api/v1/invites/accept', {
    method: 'POST', token: support.token, body: { token }
  })).status, 409, 'owner invitation loses authority when its grantor is removed');
});
