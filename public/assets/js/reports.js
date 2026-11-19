import { api, describeError, h, requireUser, showStatus } from '/assets/js/auth.js?v=__ASSET_VERSION__';
import { PROJECT_STATUS, setupTabs } from '/assets/js/hub.js?v=__ASSET_VERSION__';

const $ = (id) => document.getElementById(id);
const form = $('report-filters');
const state = { epoch: 0, loadingEpoch: null, data: null, section: 'overview', query: null };
const urls = new Set();
const outputIds = ['overview-metrics', 'project-health', 'trends-table', 'projects-table', 'receivables-aging',
  'receivables-table', 'payables-aging', 'payables-table', 'categories-table', 'cash-table', 'approvals-table',
  'workspace-pnl-table', 'invoices-table', 'costs-table'];
const human = (value) => String(value ?? 'Not set').replaceAll('_', ' ');
const enumColumns = new Set(['document_state', 'approval_status', 'settlement_state', 'source_type', 'status', 'kind', 'direction']);
const marginPercent = (row) => row.margin_bps === null ? 'Not applicable' : `${(row.margin_bps / 100).toFixed(2)}%`;
function money(value) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}₹${(absolute / 100n).toLocaleString('en-IN')}.${String(absolute % 100n).padStart(2, '0')}`;
}
function clearResults() {
  state.epoch++;
  state.data = null;
  state.query = null;
  $('export-report').disabled = true;
  $('report-content').hidden = true;
  $('report-period').textContent = '';
  outputIds.forEach((id) => $(id).replaceChildren());
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.clear();
}
function clearPrivateView() {
  clearResults();
  $('report-access').textContent = '';
  $('report-client').replaceChildren(h('option', { value: '', text: 'All authorized workspaces' }));
  $('report-project').replaceChildren(h('option', { value: '', text: 'All projects' }));
}
function recordLink(record) {
  if (!record.can_open_billing) return 'Read-only report';
  const query = new URLSearchParams({ client: record.client_id, project: record.project_id, kind: record.kind, record: record.id });
  return h('a', { href: `/workspace/billing/?${query}`, text: 'Open record' });
}
function projectLink(record) {
  return h('a', { href: `/workspace/project/?id=${encodeURIComponent(record.project_id)}`, text: record.project_name });
}
function table(id, caption, columns, rows) {
  const head = h('thead', {}, h('tr', {}, ...columns.map(([label]) => h('th', { scope: 'col', text: label }))));
  const body = h('tbody');
  const prev = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Previous', 'aria-label': `Previous ${caption}` });
  const next = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Next', 'aria-label': `Next ${caption}` });
  const count = h('span', { className: 'hint', role: 'status' });
  let page = 0;
  function render() {
    const subset = rows.slice(page * 25, (page + 1) * 25);
    body.replaceChildren(...(subset.length ? subset.map((record) => h('tr', {}, ...columns.map(([, key]) => {
      const value = typeof key === 'function' ? key(record) : key.endsWith('_minor') ? money(record[key]) : enumColumns.has(key) ? human(record[key]) : String(record[key] ?? 'Not set');
      return h('td', {}, value);
    }))) : [h('tr', {}, h('td', { colspan: columns.length, text: 'No matching records.' }))]));
    prev.disabled = page === 0;
    next.disabled = (page + 1) * 25 >= rows.length;
    count.textContent = rows.length ? `${page * 25 + 1}-${Math.min((page + 1) * 25, rows.length)} of ${rows.length} records` : '0 records';
  }
  prev.addEventListener('click', () => { page--; render(); });
  next.addEventListener('click', () => { page++; render(); });
  $(id).replaceChildren(h('div', { className: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': caption },
    h('table', { className: 'data-table' }, h('caption', { text: caption }), head, body)),
  h('div', { className: 'pager' }, prev, count, next));
  render();
}
function metrics(id, record, fields) {
  $(id).replaceChildren(...fields.map(([label, key]) => h('div', {}, h('dt', { text: label }), h('dd', { text: money(record[key]) }))));
}
function render(report) {
  $('report-access').textContent = report.access === 'organization_admin'
    ? 'Organization-wide reports for platform administrators. Record mutations still require actual workspace ownership and issuer authority.'
    : 'Reports for your actual owner workspaces only.';
  $('report-period').textContent = `Activity: ${report.filters.from} to ${report.filters.to}. Current balances and approvals: ${report.balance_date}. Generated ${report.generated_at}. INR only.`;
  metrics('overview-metrics', report.overview, [
    ['Period net revenue (excl. GST)', 'net_revenue_minor'], ['Period approved costs (incl. tax)', 'approved_cost_minor'],
    ['Period margin estimate', 'margin_minor'], ['Current receivables', 'receivable_minor'],
    ['Current unpaid costs', 'payable_minor'], ['Current contracted value', 'contract_minor'],
    ['Current unbilled contract', 'unbilled_contract_minor'], ['Current unallocated receipts', 'unallocated_minor'],
    ['Period cash in', 'cash_in_minor'], ['Period cash out', 'cash_out_minor'], ['Period net cash movement', 'cash_net_minor']
  ]);
  $('project-health').replaceChildren(...[
    ['Projects', report.overview.projects_count], ['Active projects', report.overview.active_projects_count],
    ['Deadline / milestone risks', report.overview.at_risk_projects_count], ['Awaiting approval', report.overview.pending_approval_count]
  ].map(([label, count]) => h('li', {}, h('strong', { text: String(count) }), h('span', { text: label }))));
  table('trends-table', 'Monthly activity (selected period)', [
    ['Month', 'month'], ['Net revenue', 'net_revenue_minor'], ['Approved costs', 'approved_cost_minor'],
    ['Cash in', 'cash_in_minor'], ['Cash out', 'cash_out_minor'], ['Net cash', 'cash_net_minor']
  ], report.trends);
  table('workspace-pnl-table', 'Workspace profit and loss (management estimate)', [
    ['Workspace', (r) => h('a', { href: `/workspace/?client=${encodeURIComponent(r.client_id)}`, text: r.client_name })],
    ['Projects', 'projects_count'], ['Invoiced net (excl. GST)', 'invoiced_net_minor'], ['Credits net', 'credit_net_minor'],
    ['Net revenue', 'net_revenue_minor'], ['Approved bills (incl. tax)', 'bill_cost_minor'], ['Approved expenses (incl. tax)', 'expense_cost_minor'],
    ['Total approved costs', 'approved_cost_minor'], ['Profit / loss estimate', 'margin_minor'], ['Margin %', marginPercent],
    ['Current receivables', 'receivable_minor'], ['Current payables', 'payable_minor'], ['Period net cash', 'cash_net_minor'],
    ['Awaiting approval', 'pending_approval_count']
  ], report.workspace_pnl);
  table('projects-table', 'Project portfolio and profitability', [
    ['Workspace', 'client_name'], ['Project', projectLink], ['Status', (r) => PROJECT_STATUS[r.status] ?? human(r.status)],
    ['Contract', 'contract_minor'], ['Period net revenue', 'net_revenue_minor'], ['Period costs', 'approved_cost_minor'],
    ['Period margin', 'margin_minor'], ['Margin %', marginPercent],
    ['Current receivables', 'receivable_minor'], ['Current payables', 'payable_minor'], ['Period net cash', 'cash_net_minor'],
    ['Milestones', (r) => `${r.milestones_done}/${r.milestones_total}`], ['Overdue milestones', 'overdue_milestones'],
    ['End date', 'end_date'], ['Risk', (r) => r.at_risk ? 'Needs attention' : 'No deadline risk']
  ], report.projects);
  const aging = [['Current / not overdue', 'current'], ['1-30 days overdue', 'days_1_30'], ['31-60 days overdue', 'days_31_60'], ['61-90 days overdue', 'days_61_90'], ['Over 90 days', 'days_90_plus']];
  for (const kind of ['receivables', 'payables']) metrics(`${kind}-aging`, report.aging[kind], aging);
  const context = [['Workspace', 'client_name'], ['Project', projectLink]];
  table('invoices-table', 'Customer invoice register (issue dates in period)', [
    ...context, ['Invoice / draft', 'reference'], ['Document state', 'document_state'], ['Approval', 'approval_status'],
    ['Issue date', 'issue_date'], ['Due', 'due_date'], ['Source', 'source_type'], ['Net', 'net_minor'], ['Tax', 'tax_minor'],
    ['Total', 'total_minor'], ['Paid', 'paid_minor'], ['Credited', 'credited_minor'], ['Current outstanding', 'outstanding_minor'],
    ['Settlement', 'settlement_state'], ['Action', recordLink]
  ], report.invoices);
  table('costs-table', 'Bill and expense register (incurred dates in period)', [
    ...context, ['Type', 'kind'], ['Payee', 'payee'], ['Reference', 'reference'], ['Category', 'category'],
    ['Description', 'description'], ['State', 'status'], ['Approval', 'approval_status'], ['Incurred', 'incurred_date'],
    ['Due', 'due_date'], ['Total', 'amount_minor'], ['Paid', 'paid_minor'], ['Current payable', 'outstanding_minor'], ['Action', recordLink]
  ], report.costs);
  table('receivables-table', 'Current receivables', [...context, ['Invoice', 'reference'], ['Issue date', 'issue_date'], ['Due', 'due_date'], ['Invoice total', 'total_minor'], ['Outstanding', 'outstanding_minor'], ['Days overdue', 'days_overdue'], ['Action', recordLink]], report.receivables);
  table('payables-table', 'Current payables and expenses', [...context, ['Type', 'kind'], ['Payee', 'payee'], ['Reference', 'reference'], ['Category', 'category'], ['Due / incurred', 'due_date'], ['Total', 'amount_minor'], ['Paid', 'paid_minor'], ['Outstanding', 'outstanding_minor'], ['Days overdue', 'days_overdue'], ['Action', recordLink]], report.payables);
  table('categories-table', 'Period cost categories', [['Category', 'category'], ['Bills', 'bill_minor'], ['Expenses', 'expense_minor'], ['Total', 'amount_minor'], ['Records', 'count']], report.categories);
  table('cash-table', 'Period cash movements', [...context, ['Date', 'date'], ['Type', 'kind'], ['Reference', 'reference'], ['Direction', 'direction'], ['Amount', 'amount_minor'], ['Action', recordLink]], report.cash);
  table('approvals-table', 'Current pending approvals', [...context, ['Type', 'kind'], ['Reference', 'reference'], ['Amount', 'amount_minor'], ['Submitted', 'submitted_at'], ['Action', recordLink]], report.approvals);
}
async function loadReport(query) {
  clearResults();
  const epoch = state.epoch;
  state.loadingEpoch = epoch;
  showStatus($('page-status'), 'Loading reports...');
  const controls = [...form.elements];
  controls.forEach((control) => { control.disabled = true; });
  try {
    const report = await api(`/reports/finance?${query}`, { cache: 'no-store' });
    if (epoch !== state.epoch) return;
    state.data = report;
    state.query = new URLSearchParams(query);
    const client = report.filters.client_id ?? '';
    $('report-client').replaceChildren(h('option', { value: '', text: 'All authorized workspaces' }),
      ...report.workspaces.map((item) => h('option', { value: item.id, text: item.name })));
    $('report-client').value = client;
    $('report-project').replaceChildren(h('option', { value: '', text: 'All projects' }),
      ...report.project_options.map((item) => h('option', { value: item.id, text: item.name })));
    $('report-project').value = report.filters.project_id ?? '';
    for (const key of ['from', 'to', 'project_status']) form.elements.namedItem(key).value = report.filters[key] ?? '';
    render(report);
    $('report-content').hidden = false;
    $('export-report').disabled = false;
    const next = new URLSearchParams(query);
    next.set('from', report.filters.from);
    next.set('to', report.filters.to);
    state.query = next;
    history.replaceState(null, '', `${location.pathname}?${next}${location.hash}`);
    showStatus($('page-status'), '');
  } catch (error) {
    if (epoch !== state.epoch) return;
    if ([401, 403, 404].includes(error.status)) clearPrivateView();
    showStatus($('page-status'), describeError(error));
  } finally {
    if (state.loadingEpoch === epoch) controls.forEach((control) => { control.disabled = false; });
  }
}
function formQuery() {
  return new URLSearchParams([...new FormData(form)].filter(([, value]) => value !== ''));
}
async function exportReport() {
  if (!state.data || !state.query) return;
  const epoch = state.epoch;
  const query = new URLSearchParams(state.query);
  query.set('section', state.section);
  $('export-report').disabled = true;
  try {
    const file = await api(`/reports/finance/export?${query}`, { cache: 'no-store' });
    if (epoch !== state.epoch) return;
    if (file.content_type !== 'text/csv' || typeof file.content !== 'string') throw new Error('The server did not return a CSV report.');
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/csv;charset=utf-8' }));
    urls.add(url);
    const link = h('a', { href: url, download: file.filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 30000);
    showStatus($('page-status'), 'CSV exported using current data and the applied filters.', 'success');
  } catch (error) {
    if (epoch !== state.epoch) return;
    if ([401, 403, 404].includes(error.status)) clearPrivateView();
    showStatus($('page-status'), describeError(error));
  } finally {
    if (epoch === state.epoch) $('export-report').disabled = !state.data;
  }
}
async function main() {
  clearPrivateView();
  const epoch = state.epoch;
  await requireUser();
  if (epoch !== state.epoch) return;
  const query = new URLSearchParams();
  const initial = new URLSearchParams(location.search);
  for (const key of ['client_id', 'project_id', 'project_status', 'from', 'to']) if (initial.has(key)) query.set(key, initial.get(key));
  await loadReport(query);
}
setupTabs($('report-tabs'), { onSelect: (tab) => { state.section = tab.dataset.hash; } });
form.addEventListener('submit', (event) => {
  event.preventDefault();
  loadReport(formQuery()).catch((error) => showStatus($('page-status'), describeError(error)));
});
form.addEventListener('change', (event) => {
  if (event.target.name === 'client_id') {
    $('report-project').value = '';
    loadReport(formQuery()).catch((error) => showStatus($('page-status'), describeError(error)));
  } else {
    clearResults();
    showStatus($('page-status'), 'Filters changed. Apply filters to load the report.');
  }
});
$('export-report').addEventListener('click', exportReport);
window.addEventListener('pagehide', clearPrivateView);
window.addEventListener('pageshow', (event) => { if (event.persisted) main().catch((error) => showStatus($('page-status'), describeError(error))); });
main().catch((error) => showStatus($('page-status'), describeError(error)));
