import { getDoc, queryPage } from '../db.mjs';
import { requireActualOwner } from '../authz.mjs';
import { Checker } from '../validation.mjs';
import { dateField, fail, invoiceView } from '../finance.mjs';
import { PROJECT_STATUSES } from './projects.mjs';

const collections = ['invoices', 'credit_notes', 'payments', 'refunds', 'vendor_bills', 'project_expenses'];
const metrics = ['contract_minor', 'unbilled_contract_minor', 'net_revenue_minor', 'approved_cost_minor', 'margin_minor', 'receivable_minor', 'payable_minor', 'cash_in_minor', 'cash_out_minor', 'cash_net_minor', 'unallocated_minor'];
const sections = ['overview', 'projects', 'receivables', 'payables', 'categories', 'cash', 'approvals'];
const buckets = () => ({ current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 });
const zeroMetrics = () => Object.fromEntries(metrics.map((key) => [key, 0]));
const add = (target, key, amount) => {
  const next = (target[key] ?? 0) + amount;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(next)) fail('REPORT_AMOUNT_RANGE', 'Report amounts exceed the supported integer range or need reconciliation.', 503);
  target[key] = next;
};

async function pages(collection, where, budget) {
  const items = [];
  let after = null;
  do {
    const page = await queryPage(collection, { where, after, pageSize: 50, documentIdOrder: collection === 'memberships' });
    budget.count += page.items.length;
    if (budget.count > 50000) fail('REPORT_TOO_LARGE', 'This report exceeds 50,000 source records. Select a workspace or project.', 413);
    items.push(...page.items);
    after = page.next_cursor;
  } while (after);
  return items;
}

function filters(ctx, today) {
  const check = new Checker(Object.fromEntries(ctx.query));
  for (const key of ctx.query.keys()) {
    if (!['client_id', 'project_id', 'project_status', 'from', 'to', 'section'].includes(key) || ctx.query.getAll(key).length !== 1) check.fail(key, 'Unknown or repeated report filter.');
  }
  for (const key of ['client_id', 'project_id']) {
    const value = check.text(key, { max: 160 });
    if (value !== undefined && !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) check.fail(key, 'Choose a valid record ID.');
  }
  check.oneOf('project_status', PROJECT_STATUSES);
  check.oneOf('section', sections);
  dateField(check, 'from', false);
  dateField(check, 'to', false);
  const values = check.done();
  const fiscalYear = Number(today.slice(0, 4)) - (today.slice(5, 7) < '04' ? 1 : 0);
  values.from ??= `${fiscalYear}-04-01`;
  values.to ??= today;
  if (values.from > values.to || !/^20\d{2}-/.test(values.from) || !/^20\d{2}-/.test(values.to) || Date.parse(values.to) - Date.parse(values.from) > 3660 * 86400000) {
    fail('BAD_REQUEST', 'Use an ordered date range in 2000-2099, no longer than ten years.', 400);
  }
  return values;
}

function age(due, today) {
  const days = Math.max(0, Math.floor((Date.parse(today) - Date.parse(due)) / 86400000));
  return { days_overdue: days, bucket: days === 0 ? 'current' : days <= 30 ? 'days_1_30' : days <= 60 ? 'days_31_60' : days <= 90 ? 'days_61_90' : 'days_90_plus' };
}

async function financeReport(ctx) {
  const { user } = await ctx.auth();
  const today = new Date().toISOString().slice(0, 10);
  const filter = filters(ctx, today);
  const budget = { count: 0 };
  const admin = user.role === 'admin';
  let clients;
  if (admin) clients = await pages('clients', [], budget);
  else {
    const memberships = await pages('memberships', [['user_id', '==', user.id], ['status', '==', 'active']], budget);
    clients = (await Promise.all(memberships.filter((item) => item.role === 'owner').map((item) => getDoc('clients', item.client_id)))).filter(Boolean);
    if (!clients.length) fail('FORBIDDEN', 'Reports require actual workspace ownership or platform administrator access.', 403);
  }
  clients.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const selectedClients = filter.client_id ? clients.filter((client) => client.id === filter.client_id) : clients;
  if (filter.client_id && !selectedClients.length) fail('NOT_FOUND', 'Workspace not found.', 404);
  const options = [];
  for (const client of selectedClients) {
    options.push(...(await pages('projects', [['client_id', '==', client.id]], budget)).filter((project) => !project.deleted_at));
  }
  if (filter.project_id && !options.some((project) => project.id === filter.project_id)) fail('NOT_FOUND', 'Project not found.', 404);
  const projects = options.filter((project) => (!filter.project_id || project.id === filter.project_id) && (!filter.project_status || project.status === filter.project_status));
  if (projects.length > 500) fail('REPORT_TOO_LARGE', 'Choose a workspace or project to report on at most 500 projects.', 413);
  const report = {
    access: admin ? 'organization_admin' : 'workspace_owner', generated_at: new Date().toISOString(), balance_date: today,
    currency: 'INR', filters: filter, workspaces: clients.map(({ id, name }) => ({ id, name })),
    project_options: options.map(({ id, client_id, name }) => ({ id, client_id, name })),
    overview: { ...zeroMetrics(), projects_count: projects.length, active_projects_count: 0, at_risk_projects_count: 0, pending_approval_count: 0 },
    projects: [], receivables: [], payables: [], cash: [], approvals: [], categories: [], trends: [],
    aging: { receivables: buckets(), payables: buckets() }
  };
  const trends = new Map();
  for (let month = `${filter.from.slice(0, 7)}-01`; month <= filter.to;) {
    const key = month.slice(0, 7);
    trends.set(key, { month: key, net_revenue_minor: 0, approved_cost_minor: 0, cash_in_minor: 0, cash_out_minor: 0, cash_net_minor: 0 });
    const next = new Date(`${month}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    month = next.toISOString().slice(0, 10);
  }
  const inPeriod = (date) => typeof date === 'string' && date.slice(0, 10) >= filter.from && date.slice(0, 10) <= filter.to;
  const categoryTotals = new Map();
  for (const client of selectedClients) {
    const scopedProjects = projects.filter((project) => project.client_id === client.id);
    if (!scopedProjects.length) continue;
    const where = [['client_id', '==', client.id], ...(filter.project_id ? [['project_id', '==', filter.project_id]] : [])];
    const loaded = await Promise.all(collections.map((collection) => pages(collection, where, budget)));
    const membership = await getDoc('memberships', `${client.id}__${user.id}`);
    for (const project of scopedProjects) {
      const [invoices, credits, receipts, refunds, bills, expenses] = loaded.map((records) => records.filter((record) => record.project_id === project.id));
      const all = [...invoices, ...credits, ...receipts, ...refunds, ...bills, ...expenses];
      if (all.some((record) => record.currency && record.currency !== 'INR')) fail('REPORT_CURRENCY', 'This report supports INR only. Reconcile non-INR project records before reporting.', 409);
      const plan = await getDoc('billing_plans', `${project.id}__base`);
      if (plan?.currency && plan.currency !== 'INR') fail('REPORT_CURRENCY', 'This report supports INR only.', 409);
      const row = {
        ...zeroMetrics(), project_id: project.id, project_name: project.name, client_id: client.id, client_name: client.name,
        status: project.status, end_date: project.end_date ?? null,
        can_open_billing: membership?.role === 'owner' && membership.status === 'active',
        milestones_done: (project.milestones ?? []).filter((item) => item.done).length,
        milestones_total: project.milestones?.length ?? 0,
        overdue_milestones: (project.milestones ?? []).filter((item) => !item.done && item.due && item.due < today).length
      };
      const context = { project_id: project.id, project_name: project.name, client_id: client.id, client_name: client.name, can_open_billing: row.can_open_billing };
      const metric = (key, amount, date) => {
        add(row, key, amount);
        const month = trends.get(date?.slice(0, 7));
        if (month && Object.hasOwn(month, key)) add(month, key, amount);
      };
      const cash = (kind, record, date, direction, amount, reference) => {
        if (!inPeriod(date)) return;
        if (report.cash.length >= 50000) fail('REPORT_TOO_LARGE', 'This report exceeds 50,000 cash movements. Narrow the date range, workspace or project.', 413);
        const key = direction === 'in' ? 'cash_in_minor' : 'cash_out_minor';
        metric(key, amount, date);
        metric('cash_net_minor', direction === 'in' ? amount : -amount, date);
        report.cash.push({ ...context, id: record.id, kind, date: date.slice(0, 10), direction, amount_minor: amount, reference: reference ?? record.reference ?? record.id });
      };
      const pending = (kind, record) => {
        if (record.approval_status === 'submitted') report.approvals.push({
          ...context, id: record.id, kind, reference: record.number ?? record.reference ?? record.id,
          amount_minor: record.total_minor ?? record.amount_minor, submitted_at: record.approval_history?.findLast((event) => event.action === 'submit')?.at ?? record.updated_at ?? record.created_at
        });
      };
      row.contract_minor = plan?.amount_minor ?? 0;
      row.unbilled_contract_minor = Math.max(0, row.contract_minor - (plan?.billed_minor ?? 0));
      for (const invoice of invoices) {
        if (invoice.document_state === 'draft') pending('invoices', invoice);
        if (invoice.document_state !== 'issued') continue;
        if (inPeriod(invoice.issue_date)) metric('net_revenue_minor', invoice.net_minor, invoice.issue_date);
        const balance = invoiceView(invoice).outstanding_minor;
        if (balance > 0) {
          metric('receivable_minor', balance);
          const aging = age(invoice.due_date, today);
          add(report.aging.receivables, aging.bucket, balance);
          report.receivables.push({ ...context, id: invoice.id, kind: 'invoices', reference: invoice.number, issue_date: invoice.issue_date, due_date: invoice.due_date, total_minor: invoice.total_minor, outstanding_minor: balance, ...aging });
        }
      }
      for (const credit of credits) if (inPeriod(credit.invoice_date)) metric('net_revenue_minor', -credit.net_minor, credit.invoice_date);
      for (const [kind, costs] of [['bills', bills], ['expenses', expenses]]) {
        for (const cost of costs) {
          if (cost.status !== 'void') pending(kind, cost);
          if (cost.approval_status === 'approved' && cost.status !== 'void') {
            if (inPeriod(cost.incurred_date)) {
              metric('approved_cost_minor', cost.amount_minor, cost.incurred_date);
              const key = cost.category ?? 'Uncategorised';
              const category = categoryTotals.get(key) ?? { category: key, amount_minor: 0, bill_minor: 0, expense_minor: 0, count: 0 };
              add(category, 'amount_minor', cost.amount_minor);
              add(category, kind === 'bills' ? 'bill_minor' : 'expense_minor', cost.amount_minor);
              category.count++;
              categoryTotals.set(key, category);
            }
            const balance = cost.amount_minor - cost.paid_minor;
            if (balance > 0) {
              metric('payable_minor', balance);
              const aging = age(cost.due_date ?? cost.incurred_date, today);
              add(report.aging.payables, aging.bucket, balance);
              report.payables.push({ ...context, id: cost.id, kind, reference: cost.reference, payee: cost.payee, category: cost.category, incurred_date: cost.incurred_date, due_date: cost.due_date ?? cost.incurred_date, amount_minor: cost.amount_minor, paid_minor: cost.paid_minor, outstanding_minor: balance, ...aging });
            }
          }
          for (const payment of cost.payment_history ?? []) {
            cash(kind, cost, payment.paid_date, 'out', payment.amount_minor, payment.reference);
            if (payment.reversed_at) cash(kind, cost, payment.reversed_at, 'in', payment.amount_minor, `Reversal: ${payment.reference}`);
          }
        }
      }
      for (const receipt of receipts) {
        cash('payments', receipt, receipt.received_date, 'in', receipt.amount_minor);
        if (receipt.reversed_at) cash('payments', receipt, receipt.reversed_at, 'out', receipt.amount_minor, `Reversal: ${receipt.reference}`);
        if (receipt.status === 'confirmed') metric('unallocated_minor', receipt.unallocated_minor);
      }
      for (const refund of refunds) cash('refunds', refund, refund.created_at, 'out', refund.amount_minor, refund.reason);
      row.margin_minor = row.net_revenue_minor - row.approved_cost_minor;
      row.at_risk = !['delivered', 'archived'].includes(project.status) && Boolean(row.overdue_milestones || (project.end_date && project.end_date < today));
      row.margin_bps = row.net_revenue_minor > 0 ? Math.round(row.margin_minor / row.net_revenue_minor * 10000) : null;
      if (!['delivered', 'archived'].includes(project.status)) report.overview.active_projects_count++;
      if (row.at_risk) report.overview.at_risk_projects_count++;
      for (const key of metrics) add(report.overview, key, row[key]);
      report.projects.push(row);
    }
  }
  report.overview.pending_approval_count = report.approvals.length;
  report.projects.sort((a, b) => a.project_name.localeCompare(b.project_name) || a.project_id.localeCompare(b.project_id));
  for (const key of ['receivables', 'payables']) report[key].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
  report.cash.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  report.approvals.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id.localeCompare(b.id));
  report.categories = [...categoryTotals.values()].sort((a, b) => b.amount_minor - a.amount_minor || a.category.localeCompare(b.category));
  report.trends = [...trends.values()];
  const actor = await getDoc('users', user.id);
  if (actor?.status !== 'active' || actor.role !== user.role) fail('FORBIDDEN', 'Your reporting access changed. Sign in again.', 403);
  if (!admin) for (const client of selectedClients) await requireActualOwner(actor, client.id);
  return report;
}

const csvColumns = {
  overview: ['projects_count', ...metrics, 'pending_approval_count'],
  projects: ['client_name', 'project_name', 'status', ...metrics, 'milestones_done', 'milestones_total', 'overdue_milestones', 'at_risk'],
  receivables: ['client_name', 'project_name', 'reference', 'issue_date', 'due_date', 'total_minor', 'outstanding_minor', 'days_overdue'],
  payables: ['client_name', 'project_name', 'kind', 'payee', 'reference', 'category', 'incurred_date', 'due_date', 'amount_minor', 'paid_minor', 'outstanding_minor', 'days_overdue'],
  categories: ['category', 'bill_minor', 'expense_minor', 'amount_minor', 'count'],
  cash: ['client_name', 'project_name', 'kind', 'date', 'reference', 'direction', 'amount_minor'],
  approvals: ['client_name', 'project_name', 'kind', 'reference', 'amount_minor', 'submitted_at']
};
function csvCell(value, numeric = false) {
  let text = String(value ?? '');
  if (!numeric && typeof value === 'string' && /^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function decimal(value) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
async function exportReport(ctx) {
  const report = await financeReport(ctx);
  const section = report.filters.section ?? 'projects';
  const keys = csvColumns[section];
  const rows = section === 'overview' ? [report.overview] : report[section];
  const metadata = ['period_from', 'period_to', 'balance_date', 'currency', ...keys.map((key) => key.replace(/_minor$/, '_inr'))];
  const content = [
    metadata.map((value) => csvCell(value)).join(','),
    ...rows.map((row) => [
      ...[report.filters.from, report.filters.to, report.balance_date, report.currency].map((value) => csvCell(value)),
      ...keys.map((key) => {
        const numeric = key.endsWith('_minor');
        const value = row[key] === null || row[key] === undefined ? '' : numeric ? decimal(row[key]) : row[key];
        return csvCell(value, numeric);
      })
    ].join(','))
  ].join('\r\n') + '\r\n';
  return ctx.send(200, { filename: `finance-${section}-${report.filters.from}-${report.filters.to}.csv`, content_type: 'text/csv', content }, { 'Cache-Control': 'no-store' });
}

export const reportRoutes = [
  ['GET', '/api/v1/reports/finance', async (ctx) => ctx.send(200, await financeReport(ctx), { 'Cache-Control': 'no-store' })],
  ['GET', '/api/v1/reports/finance/export', exportReport]
];
