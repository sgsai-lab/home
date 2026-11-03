import test from 'node:test';
import assert from 'node:assert/strict';
import { account, call, start } from './helpers.mjs';
import { getDoc, queryDocs, setDoc } from '../src/server/db.mjs';
import { hourlyAmount, totals } from '../src/server/finance.mjs';
import { validateDocumentText } from '../src/server/invoice-pdf.mjs';

const profile = {
  customer_name: 'Customer Limited', customer_address: 'Bengaluru, Karnataka, India', customer_state_code: '29', customer_gstin: '29ABCDE1234F1Z5',
  issuer_name: 'SGS Test Entity', issuer_address: 'Bengaluru, Karnataka, India', issuer_state_code: '29', issuer_gstin: '29ABCDE1234F1Z5',
  bank_details: 'Test bank account for fixtures only', sac_code: '998314', gst_rate_bps: 1800,
  legal_approved: true, legal_approval_reference: 'Qualified reviewer approved test configuration'
};

async function setup(t, { hourly = false, enabled = true, sendEmail, worker = false } = {}) {
  const workerEnv = { GITHUB_CRM_WORKER_AUDIENCE: 'https://worker.test', GITHUB_CRM_WORKER_SERVICE_ACCOUNT: 'worker@project.iam.gserviceaccount.com' };
  const ctx = await start(t, {
    env: { CRM_INVOICE_ISSUANCE_ENABLED: enabled ? 'true' : 'false', ...(worker ? workerEnv : {}) },
    ...(sendEmail ? { sendEmail } : {}),
    ...(worker ? { verifyGithubWorkerIdentity: async (token) => {
      if (token !== 'test-service-token') throw new Error('Invalid test service identity');
      return { aud: workerEnv.GITHUB_CRM_WORKER_AUDIENCE, iss: 'https://accounts.google.com', sub: 'service-fixture', email: workerEnv.GITHUB_CRM_WORKER_SERVICE_ACCOUNT, email_verified: true };
    } } : {})
  });
  const issuer = await account(ctx.baseUrl, 'issuer@sgs.test', { role: 'admin' });
  const owner = await account(ctx.baseUrl, 'owner@customer.test');
  const client = (await call(ctx.baseUrl, '/api/v1/clients', { method: 'POST', token: issuer.token, body: { name: 'Customer', primary_sector: 'business' } })).data;
  await setDoc('memberships', `${client.id}__${owner.user.id}`, { client_id: client.id, user_id: owner.user.id, role: 'owner', status: 'active' });
  await setDoc('issuer_operators', issuer.user.id, { id: issuer.user.id, active: true });
  const project = (await call(ctx.baseUrl, '/api/v1/projects', { method: 'POST', token: issuer.token, body: { client_id: client.id, name: 'Portal' } })).data;
  await setDoc('billing_plans', `${project.id}__base`, {
    id: `${project.id}__base`, client_id: client.id, project_id: project.id, status: 'active', version: 1,
    amount_minor: 120000, billing_method: hourly ? 'hourly' : 'fixed', currency: 'INR', hourly_rate_minor: 6000, planned_minutes: 1200
  });
  return { ...ctx, issuer, owner, client, project, prefix: `/api/v1/projects/${project.id}/finance` };
}

async function request(ctx, path, body, { person = ctx.issuer, method = 'POST', record, key = crypto.randomUUID() } = {}) {
  return call(ctx.baseUrl, `${ctx.prefix}/${path}`, {
    method, token: person.token, ...(body === undefined ? {} : { body }),
    headers: { 'Idempotency-Key': key, ...(record ? { 'If-Match': `"v${record.version}"` } : {}) }
  });
}
async function create(ctx, kind, body) {
  const result = await request(ctx, kind, body);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function configure(ctx) {
  const result = await request(ctx, 'profile', profile, { method: 'PUT', record: { version: 0 } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
async function fixedInvoice(ctx, { amount = 100000, accept = false } = {}) {
  const item = await create(ctx, 'billing-items', { title: 'Build milestone', amount_minor: amount, due_date: '2026-01-01', requires_acceptance: accept });
  if (accept) assert.equal((await request(ctx, `billing-items/${item.id}/accept`, {}, { person: ctx.owner, record: item })).status, 200);
  return create(ctx, 'invoices', { source_ids: [item.id], source_type: 'billing_item', issue_date: '2026-11-03' });
}
async function issue(ctx, invoice, key) {
  return request(ctx, `invoices/${invoice.id}/issue`, {}, { record: invoice, key });
}

test('finance fixed billing: issue once, GST snapshots, private PDF, payment/credit/refund reconciliation', async (t) => {
  const ctx = await setup(t);
  await configure(ctx);
  const draft = await fixedInvoice(ctx, { accept: true });
  const results = await Promise.all(Array.from({ length: 10 }, () => issue(ctx, draft, 'issue-once')));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results));
  let invoice = results[0].data;
  assert.equal(invoice.net_minor, 100000);
  assert.equal(invoice.tax_minor, 18000);
  assert.equal(invoice.total_minor, 118000);
  assert.equal(invoice.tax_components.cgst_minor, 9000);
  assert.equal(invoice.due_date, '2026-12-03');
  assert.equal((await queryDocs('invoice_counters')).length, 1);
  const document = await request(ctx, `invoices/${invoice.id}/document`, undefined, { method: 'GET', person: ctx.owner });
  assert.equal(document.status, 200, JSON.stringify(document.data));
  assert.ok(Buffer.from(document.data.content_base64, 'base64').subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal(document.headers.get('cache-control'), 'no-store');
  const archive = await getDoc('finance_documents', invoice.id);
  assert.equal(archive.checksum, document.data.checksum);
  const originalProfile = await getDoc('billing_profiles', `${ctx.client.id}__billing`);
  const profileChange = await request(ctx, 'profile', { ...profile, customer_name: 'Updated customer legal name' }, { method: 'PUT', record: originalProfile });
  assert.equal(profileChange.status, 200);
  const originalDocument = await request(ctx, `invoices/${invoice.id}/document`, undefined, { method: 'GET', person: ctx.owner });
  assert.equal(originalDocument.data.content_base64, document.data.content_base64, 'Issued PDF stays byte-for-byte unchanged after profile changes');
  const payment = await create(ctx, 'payments', { invoice_id: invoice.id, amount_minor: 60000, received_date: '2026-11-03', reference: 'BANK-001' });
  assert.equal(payment.unallocated_minor, 0);
  const credit = await create(ctx, 'credit-notes', { invoice_id: invoice.id, net_minor: 10000, reason: 'Agreed scope correction' });
  assert.equal(credit.total_minor, 11800);
  const creditPdf = await request(ctx, `credit-notes/${credit.id}/document`, undefined, { method: 'GET', person: ctx.owner });
  assert.equal(creditPdf.status, 200);
  assert.equal(Buffer.from(creditPdf.data.content_base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  const refreshed = await request(ctx, `invoices/${invoice.id}`, undefined, { method: 'GET' });
  invoice = refreshed.data;
  assert.equal(invoice.outstanding_minor, 46200);
  assert.equal(invoice.settlement_state, 'partially_paid');
  const reversed = await request(ctx, `payments/${payment.id}/reverse`, { reason: 'Bank transfer reversed' }, { record: payment });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.data));
  const advance = await create(ctx, 'payments', { amount_minor: 50000, received_date: '2026-11-03', reference: 'ADVANCE-001' });
  const refund = await create(ctx, 'refunds', { payment_id: advance.id, amount_minor: 15000, reason: 'Return unused advance' });
  assert.equal(refund.amount_minor, 15000);
  const summary = await request(ctx, 'summary', undefined, { method: 'GET' });
  assert.equal(summary.data.outstanding_minor, 106200);
  assert.equal(summary.data.unallocated_minor, 35000);
  assert.equal(summary.data.refunded_minor, 15000);
  assert.equal(summary.data.paid_minor, 0);
});

test('finance hourly: resource deadline, versioned time approval and no duplicate billing', async (t) => {
  const ctx = await setup(t, { hourly: true });
  await configure(ctx);
  const resource = await create(ctx, 'resources', { name: 'Engineer', role: 'Development', planned_minutes: 1200, weekly_capacity_minutes: 300, start_date: '2026-11-01', end_date: '2026-11-03' });
  const entry = await create(ctx, 'time-entries', { resource_id: resource.id, work_date: '2026-11-02', minutes: 61, description: 'Portal work' });
  const statement = await create(ctx, 'time-statements', { entry_ids: [entry.id] });
  const submittedEntry = (await request(ctx, `time-entries/${entry.id}`, undefined, { method: 'GET' })).data;
  assert.equal((await request(ctx, `time-entries/${entry.id}`, { description: 'Changed work' }, { method: 'PATCH', record: submittedEntry })).status, 409);
  const approved = await request(ctx, `time-statements/${statement.id}/approve`, {}, { record: statement, person: ctx.owner });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const draft = await create(ctx, 'invoices', { source_type: 'time_entry', source_ids: [entry.id], issue_date: '2026-11-03' });
  const competing = await create(ctx, 'invoices', { source_type: 'time_entry', source_ids: [entry.id], issue_date: '2026-11-03' });
  const results = await Promise.all([issue(ctx, draft), issue(ctx, competing)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(results.find((r) => r.status === 200).data.net_minor, 6100);
  const summary = await request(ctx, 'summary', undefined, { method: 'GET' });
  assert.equal(summary.data.at_risk_resources.length, 1);
});

test('finance gates, stale versions, overpayments and tenant isolation fail closed', async (t) => {
  const ctx = await setup(t, { enabled: false });
  const draft = await fixedInvoice(ctx);
  assert.equal((await issue(ctx, draft)).status, 503);
  await configure(ctx);
  assert.equal((await issue(ctx, draft)).status, 503, 'legal approval alone never overrides deployment gate');
  const outsider = await account(ctx.baseUrl, 'support@sgs.test', { role: 'admin' });
  for (const kind of ['resources', 'invoices', 'summary', 'profile']) {
    assert.equal((await request(ctx, kind, undefined, { method: 'GET', person: outsider })).status, 404);
  }
  assert.equal((await request(ctx, 'profile', profile, { method: 'PUT', record: { version: 0 }, person: ctx.owner })).status, 403);
  const edit = await request(ctx, `invoices/${draft.id}`, { issue_date: '2026-11-04' }, { method: 'PATCH', record: draft });
  assert.equal(edit.status, 200);
  assert.equal((await request(ctx, `invoices/${draft.id}`, { issue_date: '2026-11-05' }, { method: 'PATCH', record: draft })).status, 412);
  const invalid = await request(ctx, 'payments', { amount_minor: -1, received_date: '2026-02-31', reference: 'bad' });
  assert.equal(invalid.status, 400);
});

test('finance notification failure remains visible without rolling back issued invoice', async (t) => {
  const ctx = await setup(t, { sendEmail: async () => { throw new Error('test mail unavailable'); } });
  await configure(ctx);
  const draft = await fixedInvoice(ctx);
  const issued = (await issue(ctx, draft)).data;
  const notification = await request(ctx, `invoices/${issued.id}/notify`, {}, { record: issued });
  assert.equal(notification.status, 503);
  const current = await getDoc('invoices', issued.id);
  assert.equal(current.document_state, 'issued');
  assert.equal(current.delivery_state, 'failed');
});

test('finance arithmetic is integer exact and unsupported PDF text cannot be silently lost', () => {
  assert.equal(hourlyAmount(1, 100), 2);
  assert.equal(hourlyAmount(61, 100001), 101668);
  const intra = totals([{ amount_minor: 101 }], { gst_rate_bps: 1800, issuer_state_code: '29', customer_state_code: '29' });
  assert.deepEqual(intra, { net_minor: 101, tax_minor: 18, total_minor: 119, tax_components: { cgst_minor: 9, sgst_minor: 9, igst_minor: 0 } });
  const inter = totals([{ amount_minor: 101 }], { gst_rate_bps: 1800, issuer_state_code: '29', customer_state_code: '27' });
  assert.equal(inter.tax_components.igst_minor, 18);
  assert.equal(inter.tax_components.cgst_minor, 0);
  assert.doesNotThrow(() => validateDocumentText(['Café delivery']));
  assert.throws(() => validateDocumentText(['Invoice 🚀']), { code: 'UNSUPPORTED_DOCUMENT_TEXT' });
});

test('finance month-end candidates carry over unbilled approved sources and cancellation releases cap', async (t) => {
  const ctx = await setup(t);
  const item = await create(ctx, 'billing-items', { title: 'October milestone', amount_minor: 60000, due_date: '2026-10-15', requires_acceptance: false });
  const later = await create(ctx, 'billing-items', { title: 'November milestone', amount_minor: 60000, due_date: '2026-11-15', requires_acceptance: false });
  const candidates = await request(ctx, 'monthly-candidates?month=2026-10', undefined, { method: 'GET', person: ctx.owner });
  assert.deepEqual(candidates.data.items.map((row) => row.id), [item.id]);
  assert.equal(candidates.data.cutoff, '2026-10-31');
  assert.equal((await request(ctx, 'invoices', { source_ids: [item.id], source_type: 'billing_item', billing_month: '2026-10', issue_date: '2026-10-30' })).status, 409);
  assert.equal((await request(ctx, 'invoices', { source_ids: [later.id], source_type: 'billing_item', billing_month: '2026-10', issue_date: '2026-10-31' })).status, 409);
  const cancelled = await request(ctx, `billing-items/${later.id}/cancel`, { reason: 'Incorrect schedule' }, { record: later });
  assert.equal(cancelled.status, 200);
  const replacement = await create(ctx, 'billing-items', { title: 'Corrected milestone', amount_minor: 60000, due_date: '2026-11-01', requires_acceptance: false });
  assert.ok(replacement.id);
  assert.equal((await request(ctx, 'invoices', { source_ids: [later.id], source_type: 'billing_item', issue_date: '2026-11-30' })).status, 409);
});

test('finance rejects over-cap schedules, unaccepted sources, double credits and excess refunds', async (t) => {
  const ctx = await setup(t);
  await configure(ctx);
  const item = await create(ctx, 'billing-items', { title: 'Milestone', amount_minor: 120000, due_date: '2026-01-01', requires_acceptance: true });
  assert.equal((await request(ctx, 'billing-items', { title: 'Excess', amount_minor: 1, due_date: '2026-01-01', requires_acceptance: false })).status, 409);
  assert.equal((await request(ctx, 'invoices', { source_ids: [item.id], source_type: 'billing_item', issue_date: '2026-11-03' })).status, 409);
  assert.equal((await request(ctx, `billing-items/${item.id}/accept`, {}, { person: ctx.issuer, record: item })).status, 403);
  await request(ctx, `billing-items/${item.id}/accept`, {}, { person: ctx.owner, record: item });
  const draft = await create(ctx, 'invoices', { source_ids: [item.id], source_type: 'billing_item', issue_date: '2026-11-03' });
  const issued = (await issue(ctx, draft)).data;
  const creditKey = 'single-credit';
  const creditBody = { invoice_id: issued.id, net_minor: 120000, reason: 'Full correction' };
  const credits = await Promise.all(Array.from({ length: 10 }, () => request(ctx, 'credit-notes', creditBody, { key: creditKey })));
  assert.ok(credits.every((r) => r.status === 201), JSON.stringify(credits));
  assert.equal((await queryDocs('credit_notes')).length, 1);
  assert.equal((await request(ctx, 'credit-notes', { ...creditBody, net_minor: 1 })).status, 409);
  const payment = await create(ctx, 'payments', { amount_minor: 10000, received_date: '2026-11-03', reference: 'Unallocated credit' });
  assert.equal((await request(ctx, 'refunds', { payment_id: payment.id, amount_minor: 10001, reason: 'Too much' })).status, 409);
  const summary = await request(ctx, 'summary', undefined, { method: 'GET' });
  assert.equal(summary.data.outstanding_minor, 0);
});

test('finance notification retries remain durable and send no financial amounts or bearer URLs', async (t) => {
  let attempts = 0;
  const messages = [];
  const ctx = await setup(t, { sendEmail: async (message) => {
    attempts++;
    if (attempts === 1) throw new Error('test temporary failure');
    messages.push(message);
  } });
  await configure(ctx);
  const draft = await fixedInvoice(ctx);
  const issued = (await issue(ctx, draft)).data;
  assert.equal((await request(ctx, `invoices/${issued.id}/notify`, {}, { record: issued })).status, 503);
  const current = (await request(ctx, `invoices/${issued.id}`, undefined, { method: 'GET' })).data;
  const sent = await request(ctx, `invoices/${issued.id}/notify`, {}, { record: current });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.delivery_state, 'sent');
  assert.equal(messages.length, 1);
  assert.ok(!/118000|signature|token=/.test(messages[0].text));
});

test('finance service worker requires OIDC and rechecks the original issuer before retrying', async (t) => {
  let failing = true;
  const ctx = await setup(t, { worker: true, sendEmail: async () => { if (failing) throw new Error('Mail unavailable'); } });
  await configure(ctx);
  const issued = (await issue(ctx, await fixedInvoice(ctx))).data;
  await request(ctx, `invoices/${issued.id}/notify`, {}, { record: issued });
  const jobId = `${issued.id}__notification`;
  const job = await getDoc('finance_jobs', jobId);
  await setDoc('finance_jobs', jobId, { ...job, next_attempt_at: 0 });
  const endpoint = '/api/v1/crm/finance-worker/retry';
  const invoke = (token) => call(ctx.baseUrl, endpoint, { method: 'POST', token, body: { project_id: ctx.project.id } });
  assert.equal((await invoke(ctx.issuer.token)).status, 401);
  failing = false;
  await setDoc('issuer_operators', ctx.issuer.user.id, { id: ctx.issuer.user.id, active: false });
  const revoked = await invoke('test-service-token');
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal(revoked.data.results[0].error, 'FORBIDDEN');
  await setDoc('issuer_operators', ctx.issuer.user.id, { id: ctx.issuer.user.id, active: true });
  const completed = await invoke('test-service-token');
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  assert.equal(completed.data.results[0].state, 'sent');
  assert.equal((await getDoc('finance_jobs', jobId)).state, 'sent');
});

test('concurrent cash receipts cannot overallocate an invoice', async (t) => {
  const ctx = await setup(t);
  await configure(ctx);
  const invoice = (await issue(ctx, await fixedInvoice(ctx))).data;
  const receipts = await Promise.all(Array.from({ length: 10 }, (_, index) => create(ctx, 'payments', {
    invoice_id: invoice.id, amount_minor: 20000, received_date: '2026-11-03', reference: `BANK-${index}`
  })));
  assert.equal(receipts.reduce((sum, receipt) => sum + receipt.unallocated_minor, 0), 82000);
  const current = (await request(ctx, `invoices/${invoice.id}`, undefined, { method: 'GET' })).data;
  assert.equal(current.paid_minor, 118000);
  assert.equal(current.outstanding_minor, 0);
});
