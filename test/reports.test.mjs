import test from 'node:test';
import assert from 'node:assert/strict';
import { account, call, start } from './helpers.mjs';
import { setDoc } from '../src/server/db.mjs';

async function setup(t) {
  const ctx = await start(t);
  const admin = await account(ctx.baseUrl, 'report-admin@sgs.test', { role: 'admin' });
  const owner = await account(ctx.baseUrl, 'report-owner@customer.test');
  for (const id of ['one', 'two']) {
    await setDoc('clients', id, { id, name: `Customer ${id}`, status: 'active' });
    await setDoc('projects', `project_${id}`, {
      id: `project_${id}`, client_id: id, name: `Project ${id}`, status: 'in_progress',
      end_date: '2026-01-01', milestones: [{ title: 'Launch', due: '2026-01-01', done: false }]
    });
    await setDoc('billing_plans', `project_${id}__base`, {
      id: `project_${id}__base`, project_id: `project_${id}`, client_id: id, currency: 'INR', status: 'active', amount_minor: 100000, billed_minor: 10000
    });
  }
  await setDoc('memberships', `one__${owner.user.id}`, { client_id: 'one', user_id: owner.user.id, role: 'owner', status: 'active' });
  const seed = async (collection, id, fields, clientId = 'one') => setDoc(collection, id, {
    id, client_id: clientId, project_id: `project_${clientId}`, currency: 'INR', version: 1, created_at: '2026-02-01T10:00:00Z', ...fields
  });
  await seed('invoices', 'invoice_one', { number: 'INV-1', document_state: 'issued', issue_date: '2026-02-01', due_date: '2026-03-01', net_minor: 10000, total_minor: 11800, paid_minor: 1000, credited_minor: 1180 });
  await seed('invoices', 'invoice_two', { number: 'INV-2', document_state: 'issued', issue_date: '2026-02-01', due_date: '2026-03-01', net_minor: 20000, total_minor: 23600, paid_minor: 0, credited_minor: 0 }, 'two');
  await seed('invoices', 'draft', { document_state: 'draft', approval_status: 'submitted', issue_date: '2026-02-01', net_minor: 999999, total_minor: 999999 });
  await seed('invoices', 'void', { document_state: 'void', issue_date: '2026-02-01', net_minor: 999999, total_minor: 999999 });
  await seed('credit_notes', 'credit', { invoice_id: 'invoice_one', net_minor: 1000, total_minor: 1180, invoice_date: '2026-02-02' });
  await seed('vendor_bills', 'bill', {
    payee: '=HYPERLINK("https://example.test")', reference: 'BILL-1', category: 'Hosting', amount_minor: 5000,
    incurred_date: '2026-02-01', due_date: '2026-03-01', status: 'open', approval_status: 'approved', paid_minor: 1000,
    payment_history: [{ id: 'cost_payment', amount_minor: 1000, paid_date: '2026-02-02', reference: 'BANK-1' }]
  });
  await seed('project_expenses', 'expense', { payee: 'Consultant', reference: 'EXP-1', category: 'Travel', amount_minor: 2000, incurred_date: '2026-02-02', status: 'open', approval_status: 'submitted', paid_minor: 0, payment_history: [] });
  await seed('project_expenses', 'void_expense', { amount_minor: 7777, incurred_date: '2026-02-02', status: 'void', approval_status: 'approved', paid_minor: 0, payment_history: [] });
  await seed('payments', 'receipt', { amount_minor: 3000, received_date: '2026-02-02', reference: 'RECEIPT-1', status: 'confirmed', unallocated_minor: 2000 });
  await seed('refunds', 'refund', { amount_minor: 500, payment_id: 'receipt', reason: 'Return advance', created_at: '2026-02-03T10:00:00Z' });
  const get = (query = '', person = admin) => call(ctx.baseUrl, `/api/v1/reports/finance${query}`, { token: person?.token });
  return { ...ctx, admin, owner, seed, get };
}

test('reports grant admins organization-wide read-only access and isolate actual customer owners', async (t) => {
  const ctx = await setup(t);
  const report = await ctx.get('?from=2026-02-01&to=2026-02-28');
  assert.equal(report.status, 200, JSON.stringify(report.data));
  assert.equal(report.headers.get('cache-control'), 'no-store');
  assert.equal(report.data.access, 'organization_admin');
  assert.equal(report.data.projects.length, 2);
  assert.equal(report.data.overview.net_revenue_minor, 29000);
  assert.equal(report.data.overview.approved_cost_minor, 5000);
  assert.equal(report.data.overview.margin_minor, 24000);
  assert.equal(report.data.overview.receivable_minor, 33220);
  assert.equal(report.data.overview.payable_minor, 4000);
  assert.equal(report.data.overview.pending_approval_count, 2);
  assert.equal(report.data.projects[0].can_open_billing, false);
  const ownerReport = await ctx.get('?from=2026-02-01&to=2026-02-28', ctx.owner);
  assert.equal(ownerReport.data.projects.length, 1);
  assert.equal(ownerReport.data.workspaces.length, 1);
  assert.equal(ownerReport.data.overview.net_revenue_minor, 9000);
  assert.equal(ownerReport.data.projects[0].can_open_billing, true);
  assert.equal((await ctx.get('?client_id=two', ctx.owner)).status, 404);
  assert.equal((await ctx.get('?project_id=project_two', ctx.owner)).status, 404);
  const member = await account(ctx.baseUrl, 'member@customer.test');
  await setDoc('memberships', `one__${member.user.id}`, { client_id: 'one', user_id: member.user.id, role: 'admin', status: 'active' });
  assert.equal((await ctx.get('', member)).status, 403);
  assert.equal((await ctx.get('', null)).status, 401);
  assert.equal((await call(ctx.baseUrl, '/api/v1/projects/project_one/finance/summary', { token: ctx.admin.token })).status, 404);
  assert.equal((await call(ctx.baseUrl, '/api/v1/projects/project_one/finance/bills', { method: 'POST', token: ctx.admin.token, body: {} })).status, 404);
});

test('report periods apply to activity while balances and approvals remain current', async (t) => {
  const ctx = await setup(t);
  let report = (await ctx.get('?client_id=one&from=2026-04-01&to=2026-04-30')).data;
  assert.equal(report.overview.net_revenue_minor, 0);
  assert.equal(report.overview.approved_cost_minor, 0);
  assert.equal(report.overview.receivable_minor, 9620);
  assert.equal(report.overview.payable_minor, 4000);
  assert.equal(report.approvals.length, 2);
  assert.equal(report.receivables.length, 1);
  assert.equal(report.payables.length, 1);
  report = (await ctx.get('?project_id=project_one&from=2026-02-01&to=2026-02-28')).data;
  assert.equal(report.projects.length, 1);
  assert.equal(report.categories[0].amount_minor, 5000);
  assert.equal(report.projects[0].overdue_milestones, 1);
  assert.equal(report.aging.receivables.days_90_plus, 9620);
  for (const query of ['?from=2026-02-30', '?from=2026-03-01&to=2026-02-01', '?project_status=bad', '?unknown=yes', '?client_id=one&project_id=project_two']) {
    assert.ok([400, 404].includes((await ctx.get(query)).status), query);
  }
});

test('cash report includes receipts, refunds, cost payments and reversals on their own dates', async (t) => {
  const ctx = await setup(t);
  await ctx.seed('payments', 'reversed', { amount_minor: 4000, received_date: '2026-01-10', status: 'reversed', reversed_at: '2026-02-05T10:00:00Z', reference: 'Returned' });
  await ctx.seed('project_expenses', 'reversed_cost', {
    amount_minor: 600, incurred_date: '2026-01-01', status: 'void', approval_status: 'approved', paid_minor: 0,
    payment_history: [{ id: 'cp', amount_minor: 600, paid_date: '2026-01-02', reversed_at: '2026-02-06T10:00:00Z', reference: 'Returned cost' }]
  });
  const report = (await ctx.get('?client_id=one&from=2026-02-01&to=2026-02-28')).data;
  assert.equal(report.overview.cash_in_minor, 3600);
  assert.equal(report.overview.cash_out_minor, 5500);
  assert.equal(report.overview.cash_net_minor, -1900);
  assert.equal(report.cash.length, 5);
  assert.equal(report.trends[0].cash_net_minor, -1900);
});

test('reports traverse every finance page and CSV is scoped, decimal-exact and spreadsheet-safe', async (t) => {
  const ctx = await setup(t);
  for (let index = 0; index < 1001; index++) await ctx.seed('invoices', `extra_${String(index).padStart(4, '0')}`, {
    document_state: 'issued', issue_date: '2026-02-01', due_date: '2026-03-01', net_minor: 1, total_minor: 1, paid_minor: 0, credited_minor: 0
  });
  const report = (await ctx.get('?client_id=one&from=2026-02-01&to=2026-02-28')).data;
  assert.equal(report.receivables.length, 1002);
  assert.equal(report.overview.net_revenue_minor, 10001);
  const csv = await call(ctx.baseUrl, '/api/v1/reports/finance/export?section=payables&client_id=one&from=2026-02-01&to=2026-02-28', { token: ctx.owner.token });
  assert.equal(csv.status, 200);
  assert.equal(csv.data.content_type, 'text/csv');
  assert.match(csv.data.content, /'\=HYPERLINK/);
  assert.match(csv.data.content, /50\.00/);
  assert.match(csv.data.content, /40\.00/);
  assert.ok(!csv.data.content.includes('Customer two'));
  assert.equal((await call(ctx.baseUrl, '/api/v1/reports/finance/export?section=bad', { token: ctx.admin.token })).status, 400);
  await ctx.seed('project_expenses', 'negative_margin', { amount_minor: 301, incurred_date: '2026-04-02', paid_minor: 0, approval_status: 'approved', status: 'open', payment_history: [] });
  const overviewCsv = await call(ctx.baseUrl, '/api/v1/reports/finance/export?section=overview&client_id=one&from=2026-04-01&to=2026-04-30', { token: ctx.admin.token });
  assert.match(overviewCsv.data.content, /"-3\.01"/);
  assert.ok(!overviewCsv.data.content.includes(`"'-`), 'Trusted monetary negatives must not become spreadsheet text');
});

test('reports include archived projects, enforce scope/row limits and reject unsupported currencies', async (t) => {
  const ctx = await setup(t);
  await setDoc('projects', 'archived', { id: 'archived', client_id: 'one', name: 'Archived project', status: 'archived', milestones: [] });
  await ctx.seed('project_expenses', 'archived_cost', { project_id: 'archived', amount_minor: 700, paid_minor: 0, approval_status: 'approved', status: 'open', incurred_date: '2026-02-01', payment_history: [] });
  const archived = await ctx.get('?client_id=one&project_status=archived&from=2026-02-01&to=2026-02-28');
  assert.equal(archived.data.projects.length, 1);
  assert.equal(archived.data.overview.approved_cost_minor, 700);
  await ctx.seed('invoices', 'foreign', { currency: 'USD', document_state: 'draft' });
  assert.equal((await ctx.get('?project_id=project_one')).status, 409);
  for (let index = 0; index < 500; index++) await setDoc('projects', `extra_project_${index}`, { id: `extra_project_${index}`, client_id: 'two', name: `Extra ${index}`, status: 'draft' });
  const oversized = await ctx.get('?client_id=two');
  assert.equal(oversized.status, 413);
  assert.equal(oversized.data.error.code, 'REPORT_TOO_LARGE');
  assert.equal((await ctx.get('?project_id=project_two')).status, 200, 'A project filter narrows oversized scope');
});

test('workspace profit and loss reconciles multiple projects, credits, approved costs and losses', async (t) => {
  const ctx = await setup(t);
  await setDoc('projects', 'second_one', { id: 'second_one', client_id: 'one', name: 'Second project', status: 'delivered', milestones: [] });
  await ctx.seed('invoices', 'extra_revenue', { project_id: 'second_one', document_state: 'issued', net_minor: 3000, total_minor: 3000, paid_minor: 3000, credited_minor: 0, issue_date: '2026-02-01', due_date: '2026-02-10' });
  await ctx.seed('project_expenses', 'extra_cost', { project_id: 'second_one', approval_status: 'approved', status: 'open', amount_minor: 500, paid_minor: 500, incurred_date: '2026-02-02' });
  await ctx.seed('project_expenses', 'loss_cost', { approval_status: 'approved', status: 'open', amount_minor: 40000, paid_minor: 5000, incurred_date: '2026-02-02' }, 'two');
  const report = (await ctx.get('?from=2026-02-01&to=2026-02-28')).data;
  assert.equal(report.workspace_pnl.length, 2);
  const [one, two] = report.workspace_pnl;
  assert.equal(one.projects_count, 2);
  assert.equal(one.net_revenue_minor, 12000);
  assert.equal(one.invoiced_net_minor, 13000);
  assert.equal(one.credit_net_minor, 1000);
  assert.equal(one.bill_cost_minor, 5000);
  assert.equal(one.expense_cost_minor, 500);
  assert.equal(one.approved_cost_minor, 5500);
  assert.equal(one.margin_minor, 6500);
  assert.equal(one.pending_approval_count, 2);
  assert.equal(two.margin_minor, -20000);
  assert.equal(report.workspace_pnl.reduce((total, row) => total + row.margin_minor, 0), report.overview.margin_minor);
  const owner = (await ctx.get('?from=2026-02-01&to=2026-02-28', ctx.owner)).data;
  assert.equal(owner.workspace_pnl.length, 1);
  assert.equal(owner.workspace_pnl[0].client_id, 'one');
  const project = (await ctx.get('?project_id=second_one&from=2026-02-01&to=2026-02-28')).data;
  assert.equal(project.workspace_pnl.length, 1);
  assert.equal(project.workspace_pnl[0].margin_minor, 2500);
  const april = (await ctx.get('?client_id=two&from=2026-04-01&to=2026-04-30')).data.workspace_pnl[0];
  assert.equal(april.margin_minor, 0);
  assert.equal(april.payable_minor, 35000, 'Current balances are not historical period activity');
});

test('invoice and cost registers include paid, draft, rejected and void records without double-counting profit', async (t) => {
  const ctx = await setup(t);
  await ctx.seed('invoices', 'paid_invoice', { number: 'INV-PAID', document_state: 'issued', issue_date: '2026-02-01', due_date: '2026-03-01', net_minor: 5000, total_minor: 5900, paid_minor: 5900, credited_minor: 0 });
  await ctx.seed('project_expenses', 'paid_expense', { payee: 'Paid supplier', reference: 'PAID-EXP', amount_minor: 1432, incurred_date: '2026-02-03', approval_status: 'approved', status: 'open', paid_minor: 1432 });
  await ctx.seed('project_expenses', 'rejected_expense', { payee: 'Rejected supplier', reference: 'REJECT-EXP', amount_minor: 9000, incurred_date: '2026-02-03', approval_status: 'rejected', status: 'open', paid_minor: 0 });
  const report = (await ctx.get('?from=2026-02-01&to=2026-02-28', ctx.owner)).data;
  assert.equal(report.invoices.length, 4);
  assert.equal(report.invoices.find((row) => row.id === 'paid_invoice').settlement_state, 'paid');
  assert.equal(report.invoices.find((row) => row.id === 'paid_invoice').outstanding_minor, 0);
  assert.equal(report.invoices.find((row) => row.id === 'draft').outstanding_minor, 0);
  assert.equal(report.invoices.find((row) => row.id === 'void').outstanding_minor, 0);
  assert.equal(report.costs.length, 5);
  assert.equal(report.costs.find((row) => row.id === 'paid_expense').paid_minor, 1432);
  assert.equal(report.costs.find((row) => row.id === 'rejected_expense').outstanding_minor, 0);
  assert.equal(report.overview.approved_cost_minor, 6432);
  assert.equal(report.overview.net_revenue_minor, 14000);
  const outside = (await ctx.get('?from=2026-04-01&to=2026-04-30')).data;
  assert.equal(outside.invoices.length, 0);
  assert.equal(outside.costs.length, 0);
  assert.ok(outside.receivables.length > 0);
  for (const section of ['workspace_pnl', 'invoices', 'costs']) {
    const csv = await call(ctx.baseUrl, `/api/v1/reports/finance/export?section=${section}&from=2026-02-01&to=2026-02-28`, { token: ctx.owner.token });
    assert.equal(csv.status, 200);
    assert.ok(!csv.data.content.includes('Customer two'));
    if (section === 'costs') {
      assert.match(csv.data.content, /"14\.32"/);
      assert.match(csv.data.content, /'\=HYPERLINK/);
    }
  }
});
