import { api, ApiError, describeError, h, showStatus } from '/assets/js/auth.js?v=__ASSET_VERSION__';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const projectId = params.get('project');
const clientId = params.get('client');
const encode = encodeURIComponent;
const base = `/projects/${encode(projectId ?? '')}/finance`;
const state = {
  generation: 0, listEpoch: 0, detailEpoch: 0, editorEpoch: 0,
  capabilities: null, profile: null, resource: 'resources',
  cursor: null, next: null, selected: null, githubCleanup: null, issuanceEnabled: null
};
const operationKeys = new Map();
const urls = new Set();
const titles = {
  resources: 'Resources and deadlines', 'billing-items': 'Fixed billing items',
  'time-entries': 'Time entries', 'time-statements': 'Time statements',
  invoices: 'Invoices', payments: 'Payments', 'credit-notes': 'Credit notes', refunds: 'Refunds'
};
const hints = {
  resources: 'Plan effort and weekly capacity; record a start date and delivery deadline.',
  'billing-items': 'Fixed-plan charges. Customer acceptance is recorded explicitly when required.',
  'time-entries': 'Record minutes against a resource. The accepted plan supplies the hourly rate.',
  'time-statements': 'Select multiple time entries for customer approval. Rejection requires a reason.',
  invoices: 'Create a draft from multiple fixed items or time entries. Optionally select a billing month and explicitly load eligible month-end candidates, including prior-month carryover. Review snapshots before issuing. Delivery and settlement are separate states.',
  payments: 'Record receipts, allocate against invoices, or reverse with a reason. Choosing an invoice applies the receipt up to its outstanding balance; any remainder stays unallocated. Unallocated credit is shown in the overview.',
  'credit-notes': 'Issue a net-value credit against an invoice; tax is calculated by the server.',
  refunds: 'Refund only available unallocated payment credit. This records the refund, not a bank transfer.'
};

function validation(message) {
  return new ApiError(400, 'VALIDATION', message);
}

function stale() {
  return new ApiError(0, 'STALE_VIEW', 'This view has changed. Refresh to continue.');
}

function clearPrivateView() {
  state.generation++;
  state.listEpoch++;
  state.detailEpoch++;
  state.editorEpoch++;
  const githubCleanup = state.githubCleanup;
  state.githubCleanup = null;
  state.capabilities = null;
  state.profile = null;
  state.selected = null;
  state.issuanceEnabled = null;
  state.cursor = null;
  state.next = null;
  operationKeys.clear();
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.clear();
  $('billing-content').hidden = true;
  $('record-detail').hidden = true;
  $('record-editor').hidden = true;
  for (const id of ['finance-summary', 'finance-aging', 'resource-risks', 'records-head', 'records-body',
    'detail-fields', 'detail-lines', 'record-actions', 'editor-body', 'profile-fields', 'github-delivery']) {
    $(id).replaceChildren();
  }
  for (const id of ['billing-project', 'detail-heading', 'editor-heading', 'editor-hint', 'list-hint', 'issuance-gate']) $(id).textContent = '';
  $('record-filter').reset();
  $('new-record').hidden = true;
  $('edit-profile').hidden = true;
  $('refresh-billing').disabled = false;
  showStatus($('page-status'), '');
  // Isolate a pending integration mount from a new page lifecycle.
  $('github-delivery').replaceWith(h('div', { id: 'github-delivery' }));
  githubCleanup?.();
}

async function request(path, options = {}) {
  const generation = state.generation;
  try {
    const data = await api(path, {
      ...options, cache: 'no-store',
      headers: { 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache', ...options.headers }
    });
    if (generation !== state.generation) throw stale();
    return data;
  } catch (error) {
    if (generation !== state.generation) throw stale();
    if ([401, 403, 404].includes(error.status)) clearPrivateView();
    throw error;
  }
}

function report(error) {
  if (error.code !== 'STALE_VIEW') showStatus($('page-status'), describeError(error));
}

function button(text, handler, primary = false) {
  const element = h('button', {
    type: 'button', className: `button button-${primary ? 'primary' : 'secondary'} button-small`, text
  });
  element.addEventListener('click', async () => {
    element.disabled = true;
    showStatus($('page-status'), '');
    try { await handler(); } catch (error) { report(error); }
    finally { element.disabled = false; }
  });
  return element;
}

function minor(value) {
  if (!/^\d{1,14}(?:\.\d{1,2})?$/.test(value)) throw validation('Enter INR with up to two decimal places, without commas.');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result < 1n || result > 1_000_000_000_000n) throw validation('Enter a positive amount no greater than INR 10,000,000,000.00.');
  return Number(result);
}

function decimal(value) {
  const amount = BigInt(value ?? 0);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

function money(value) {
  if (value === undefined || value === null) return 'Not available';
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '−' : ''}₹${(absolute / 100n).toLocaleString('en-IN')}.${String(absolute % 100n).padStart(2, '0')}`;
}

function integer(value, label) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw validation(`${label} must be a whole number.`);
  return Number(value);
}

const text = (value) => value === undefined || value === null || value === '' ? 'Not set' : String(value);
const human = (value) => text(value).replaceAll('_', ' ');
const labelOf = (record) => record.name || record.title || record.number || record.reference || record.id;
const version = (record) => {
  if (!Number.isSafeInteger(record.version) || record.version < 0) throw validation('The record version is missing. Refresh before making changes.');
  return `"v${record.version}"`;
};
const pair = (label, value) => [h('dt', { text: label }), h('dd', { text: text(value) })];

async function write(path, method, body, record) {
  const headers = {};
  if (record) headers['If-Match'] = version(record);
  const operation = JSON.stringify([path, method, body, headers['If-Match']]);
  if (['POST', 'PATCH', 'PUT'].includes(method)) {
    if (!operationKeys.has(operation)) operationKeys.set(operation, crypto.randomUUID());
    headers['Idempotency-Key'] = operationKeys.get(operation);
  }
  const result = await request(path, { method, body, headers });
  operationKeys.delete(operation);
  return result;
}

const columns = {
  resources: [['Name', 'name'], ['Role', 'role'], ['Planned minutes', 'planned_minutes'], ['Weekly capacity (min)', 'weekly_capacity_minutes'], ['Start', 'start_date'], ['Deadline', 'end_date']],
  'billing-items': [['Title', 'title'], ['Amount', 'amount_minor'], ['Due', 'due_date'], ['Acceptance', (r) => r.accepted_at ? 'Accepted' : r.requires_acceptance ? 'Required' : 'Not required'], ['State', 'status']],
  'time-entries': [['Work date', 'work_date'], ['Resource', (r) => r.resource_name ?? r.resource_id], ['Minutes', 'minutes'], ['Amount', 'amount_minor'], ['Description', 'description'], ['State', (r) => r.billed_invoice_id ? 'invoiced' : r.approved_at ? 'approved' : r.statement_id ? 'submitted' : 'unsubmitted']],
  'time-statements': [['Statement', 'id'], ['State', (r) => r.status ?? r.state], ['Minutes', 'total_minutes'], ['Amount', 'amount_minor'], ['Submitted', 'created_at'], ['Rejection reason', 'rejection_reason']],
  invoices: [['Invoice', (r) => r.number || 'Draft'], ['Issued', 'issue_date'], ['Due', 'due_date'], ['Total', 'total_minor'], ['Outstanding', 'outstanding_minor'], ['Document', 'document_state'], ['Delivery', 'delivery_state'], ['Settlement', 'settlement_state']],
  payments: [['Reference', 'reference'], ['Received', 'received_date'], ['Amount', 'amount_minor'], ['Unallocated', 'unallocated_minor'], ['State', (r) => r.status ?? (r.reversed_at ? 'Reversed' : 'Recorded')]],
  'credit-notes': [['Credit note', (r) => r.number || r.id], ['Invoice', 'invoice_id'], ['Net credit', 'net_minor'], ['Total credit', 'total_minor'], ['Reason', 'reason']],
  refunds: [['Refund', 'id'], ['Payment', 'payment_id'], ['Amount', 'amount_minor'], ['Reason', 'reason'], ['Recorded', 'created_at']]
};

function cellValue(record, key) {
  if (typeof key === 'function') return text(key(record));
  if (key.endsWith('_minor')) return money(record[key]);
  return human(record[key]);
}

async function loadList(cursor = null) {
  const epoch = ++state.listEpoch;
  const resource = state.resource;
  state.cursor = cursor;
  state.next = null;
  $('records-body').replaceChildren();
  $('next-page').disabled = true;
  $('first-page').disabled = true;
  $('records-caption').textContent = titles[resource];
  $('list-hint').textContent = hints[resource];
  const fields = columns[resource];
  $('records-head').replaceChildren(h('tr', {}, ...[...fields.map(([name]) => name), 'Action'].map((name) => h('th', { scope: 'col', text: name }))));
  const query = new URLSearchParams({ page_size: '25' });
  if (cursor) query.set('cursor', cursor);
  const result = await request(`${base}/${resource}?${query}`);
  if (epoch !== state.listEpoch) return;
  state.next = result.next_cursor;
  $('records-body').replaceChildren(...(result.items.length ? result.items.map((record) =>
    h('tr', {}, ...fields.map(([, key]) => h('td', { text: cellValue(record, key) })),
      h('td', {}, button(`View ${labelOf(record)}`, () => selectRecord(resource, record)))))
    : [h('tr', {}, h('td', { colspan: fields.length + 1, text: 'No records yet.' }))]));
  $('next-page').disabled = !state.next;
  $('first-page').disabled = !cursor;
  $('new-record').textContent = `Create ${titles[resource].toLowerCase()}`;
  $('new-record').hidden = !state.capabilities?.can_prepare;
}

async function loadSummary() {
  const summary = await request(`${base}/summary`);
  state.issuanceEnabled = summary.invoice_issuance_enabled ?? null;
  $('issuance-gate').textContent = summary.invoice_issuance_enabled === false
    ? 'Invoice issuance is disabled by server configuration. Draft preparation is available; legal approval alone does not enable issuance.'
    : summary.invoice_issuance_enabled === true
      ? 'Server issuance gate is enabled. Approved legal/tax configuration is still required before issuing invoices.'
      : 'Issuance availability must be confirmed by the server; approved legal/tax configuration is required.';
  const totals = [
    ['Contract', 'contract_minor'], ['Invoiced', 'invoiced_minor'], ['Credited', 'credited_minor'],
    ['Paid', 'paid_minor'], ['Outstanding', 'outstanding_minor'], ['Unallocated credit', 'unallocated_minor'],
    ['Refunded', 'refunded_minor'], ['Overdue', 'overdue_minor']
  ];
  $('finance-summary').replaceChildren(...totals.map(([label, key]) => h('div', {}, ...pair(label, money(summary[key])))));
  const aging = [['Current / not overdue', 'current'], ['1–30 days', 'days_1_30'], ['31–60 days', 'days_31_60'], ['61–90 days', 'days_61_90'], ['Over 90 days', 'days_90_plus']];
  $('finance-aging').replaceChildren(...aging.map(([label, key]) => h('div', {}, ...pair(label, money(summary.aging?.[key])))));
  $('resource-risks').replaceChildren(...(summary.at_risk_resources?.length
    ? summary.at_risk_resources.map((r) => h('li', {
      text: typeof r === 'string' ? r : `${labelOf(r)} · Deadline: ${text(r.end_date)} · ${text(r.reason ?? r.risk ?? 'Capacity or deadline at risk')}`
    }))
    : [h('li', { text: 'No resource risks reported by the server.' })]));
}

const profileFields = [
  ['Customer legal name', 'customer_name'], ['Customer address', 'customer_address'],
  ['Customer state code', 'customer_state_code'], ['Customer GSTIN', 'customer_gstin'],
  ['Issuer legal name', 'issuer_name'], ['Issuer address', 'issuer_address'],
  ['Issuer state code', 'issuer_state_code'], ['Issuer GSTIN', 'issuer_gstin'],
  ['Bank details', 'bank_details'], ['SAC code', 'sac_code'],
  ['GST rate (basis points; 1800 = 18%)', 'gst_rate_bps'],
  ['Legal approval reference', 'legal_approval_reference']
];

function bankText(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).map(([key, item]) => `${human(key)}: ${text(item)}`).join('\n');
}

async function loadProfile() {
  const profile = await request(`${base}/profile`);
  state.profile = profile;
  $('profile-fields').replaceChildren(...[
    ...profileFields.map(([label, key]) => pair(label, key === 'bank_details' ? bankText(profile[key]) : profile[key])).flat(),
    ...pair('Legal approved', profile.legal_approved ? 'Yes — server issuance gate still applies' : 'No — invoice issuance blocked'),
    ...pair('Configuration version', profile.version)
  ]);
  $('edit-profile').hidden = !state.capabilities?.can_prepare;
}

function closeEditor() {
  state.editorEpoch++;
  $('record-editor').hidden = true;
  $('editor-body').replaceChildren();
  $('editor-heading').textContent = '';
  $('editor-hint').textContent = '';
}

function closeDetail() {
  state.detailEpoch++;
  state.selected = null;
  $('record-detail').hidden = true;
  $('detail-fields').replaceChildren();
  $('detail-lines').replaceChildren();
  $('record-actions').replaceChildren();
  $('detail-heading').textContent = '';
}

function invoiceLines(invoice) {
  const lines = invoice.lines ?? invoice.snapshot?.lines ?? [];
  if (!lines.length) return h('p', { className: 'hint', text: 'No line snapshots returned.' });
  return h('div', { className: 'table-scroll' }, h('table', { className: 'data-table' },
    h('caption', { text: 'Invoice line snapshots' }),
    h('thead', {}, h('tr', {}, ...['Description', 'Quantity', 'Net', 'Tax', 'Total'].map((name) => h('th', { scope: 'col', text: name })))),
    h('tbody', {}, ...lines.map((line) => h('tr', {},
      h('td', { text: line.description ?? line.title ?? line.name ?? line.source_id }),
      h('td', { text: text(line.quantity ?? line.minutes) }),
      h('td', { text: money(line.net_minor ?? line.amount_minor) }),
      h('td', { text: money(line.tax_minor) }),
      h('td', { text: money(line.total_minor) }))))));
}

async function selectRecord(resource, record) {
  const epoch = ++state.detailEpoch;
  closeEditor();
  $('record-detail').hidden = true;
  if (resource === 'invoices') record = await request(`${base}/invoices/${encode(record.id)}`);
  if (epoch !== state.detailEpoch) return;
  state.selected = { resource, record };
  $('detail-heading').textContent = `${titles[resource]} · ${labelOf(record)}`;
  const extra = [
    ['Record ID', 'id'], ['Version', 'version'], ['State', 'status'], ['Created', 'created_at'],
    ['Start', 'start_date'], ['Deadline', 'end_date'], ['Reason', 'reason'], ['Invoice', 'invoice_id'],
    ['Payment', 'payment_id'], ['Billed invoice', 'billed_invoice_id'], ['Submitted statement', 'statement_id'], ['Accepted', 'accepted_at'],
    ['Approved', 'approved_at'], ['Rejected', 'rejected_at'], ['Rejection reason', 'rejection_reason'],
    ['Net', 'net_minor'], ['Tax', 'tax_minor'], ['Paid', 'paid_minor'], ['Credited', 'credited_minor'],
    ['Overdue', (r) => r.overdue === undefined ? undefined : r.overdue ? 'Yes' : 'No'],
    ['Mail delivery error', 'delivery_error'], ['Reversal reason', 'reversal_reason'],
    ['Cancelled', 'cancelled_at'], ['Cancellation reason', 'cancellation_reason'],
    ['Invoice number', 'invoice_number'], ['Refunded', 'refunded_minor']
  ];
  const seen = new Set();
  const fields = [...columns[resource], ...extra].filter(([, key]) => {
    if (typeof key === 'function') return true;
    if (seen.has(key) || record[key] === undefined || record[key] === null) return false;
    seen.add(key);
    return true;
  });
  $('detail-fields').replaceChildren(...fields.map(([label, key]) => pair(label, cellValue(record, key))).flat());
  $('detail-lines').replaceChildren();
  if (resource === 'invoices') {
    $('detail-lines').append(invoiceLines(record));
    const snapshot = record.profile_snapshot ?? record.legal_snapshot ?? record.snapshot?.profile;
    if (snapshot) $('detail-lines').append(h('h3', { text: 'Legal snapshot' }),
      h('dl', { className: 'crm-record' }, ...profileFields.filter(([, key]) => snapshot[key] !== undefined)
        .map(([label, key]) => pair(label, key === 'bank_details' ? bankText(snapshot[key]) : snapshot[key])).flat()));
  }
  if (Array.isArray(record.entry_ids)) {
    const ids = new Set(record.entry_ids);
    const entries = (await allRecords('time-entries')).filter((entry) => ids.has(entry.id));
    if (epoch !== state.detailEpoch) return;
    $('detail-lines').append(h('div', { className: 'table-scroll' }, h('table', { className: 'data-table' },
      h('caption', { text: 'Submitted work for review' }),
      h('thead', {}, h('tr', {}, ...columns['time-entries'].map(([label]) => h('th', { scope: 'col', text: label })))),
      h('tbody', {}, ...entries.map((entry) => h('tr', {},
        ...columns['time-entries'].map(([, key]) => h('td', { text: cellValue(entry, key) }))))))));
    if (entries.length !== ids.size) $('detail-lines').append(h('p', {
      className: 'hint', text: 'Some referenced entries were not returned. Refresh and verify all submitted work before approving.'
    }));
  }
  if (Array.isArray(record.allocations)) $('detail-lines').append(h('h3', { text: 'Invoice allocations' }),
    h('ul', {}, ...record.allocations.map((item) => h('li', { text: `${item.invoice_id}: ${money(item.amount_minor)}` }))));
  renderActions(resource, record);
  $('record-detail').hidden = false;
  $('detail-heading').focus();
}

function renderActions(resource, record) {
  const actions = $('record-actions');
  actions.replaceChildren();
  const issuer = state.capabilities?.can_prepare;
  const customer = state.capabilities?.can_accept;
  const status = record.status ?? record.state;
  if (issuer && (resource === 'resources' || (resource === 'time-entries' && !record.statement_id && !record.submitted_at && !record.approved_at && !record.billed_invoice_id && (!status || ['draft', 'unsubmitted'].includes(status)))
    || (resource === 'invoices' && record.document_state === 'draft'))) {
    actions.append(button('Edit record', () => openRecordForm(resource, record)));
  }
  const action = (label, name, fields, hint) => {
    const control = button(label, () => openActionForm(resource, record, label, name, fields, hint));
    actions.append(control);
    return control;
  };
  if (issuer && resource === 'billing-items' && record.status !== 'cancelled' && !record.billed_invoice_id) {
    action('Cancel billing item', 'cancel', [reasonField()], 'Cancel this unbilled item with an audit reason. The record is preserved and its scheduled contract cap is released.');
  }
  if (customer && resource === 'billing-items' && record.requires_acceptance && !record.accepted_at && record.status !== 'cancelled' && !record.billed_invoice_id) {
    action('Accept billing item', 'accept', [], 'Confirm acceptance of this fixed billing item.');
  }
  if (customer && resource === 'time-statements' && !record.approved_at && !record.rejected_at && !['approved', 'rejected'].includes(status)) {
    action('Approve statement', 'approve', [], 'Confirm approval of all entries in this time statement.');
    action('Reject statement', 'reject', [reasonField()], 'Provide a reason so the issuer can correct the entries.');
  }
  if (issuer && resource === 'invoices') {
    if (record.document_state === 'draft') {
      const issue = action('Issue invoice', 'issue', [], 'Issuing creates a legal snapshot and invoice number. Legal configuration and the external server issuance gate must both allow issuance.');
      if (state.issuanceEnabled === false) {
        issue.disabled = true;
        actions.append(h('p', { className: 'hint', text: 'Issuance disabled by server configuration. This invoice remains a draft.' }));
      }
    }
    if (record.document_state === 'issued') {
      action('Send / retry invoice email', 'notify', [], `Current delivery state: ${human(record.delivery_state)}. This explicitly requests email delivery; success does not mean payment received.`);
      if (record.paid_minor === 0 && record.credited_minor === 0) action('Void invoice', 'void', [reasonField()], 'Void only when legally permitted and there are no payments or credits. The server verifies eligibility.');
    }
  }
  if (resource === 'invoices' && record.document_state === 'void') {
    actions.append(h('p', { className: 'form-status', role: 'status', 'data-kind': 'error', text: `VOID INVOICE — not payable.${record.void_reason ? ` Reason: ${record.void_reason}` : ''}` }));
  }
  if (resource === 'invoices' && ['issued', 'void'].includes(record.document_state)) {
    actions.append(button(record.document_state === 'void' ? 'Download original PDF (VOID invoice)' : 'Download invoice PDF', () => downloadDocument(resource, record)));
  }
  if (resource === 'credit-notes') actions.append(button('Download credit note PDF', () => downloadDocument(resource, record)));
  if (issuer && resource === 'payments' && !record.reversed_at && status !== 'reversed') {
    action('Allocate payment', 'allocate', [invoiceField(), amountField()], 'Allocate available payment credit to an invoice. The server checks both balances.');
    action('Reverse payment', 'reverse', [reasonField()], 'Reverse this receipt with an audit reason. This does not move money at a bank.');
  }
}

async function downloadDocument(resource, record) {
  const generation = state.generation;
  const file = await request(`${base}/${resource}/${encode(record.id)}/document`);
  if (file.content_type !== 'application/pdf' || typeof file.content_base64 !== 'string') throw validation('The server did not return a PDF document.');
  const bytes = Uint8Array.from(atob(file.content_base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  urls.add(url);
  if (generation !== state.generation) { URL.revokeObjectURL(url); urls.delete(url); return; }
  const link = h('a', { href: url, download: String(file.filename || `${resource === 'credit-notes' ? 'credit-note' : 'invoice'}.pdf`).replace(/[/\\]/g, '_') });
  document.body.append(link);
  link.click();
  link.remove();
  // Give slower download handlers (including automation) time to read the Blob; pagehide revokes sooner.
  setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 30000);
}

const amountField = (name = 'amount_minor', label = 'Amount (INR)') => ({ name, label, type: 'money' });
const reasonField = () => ({ name: 'reason', label: 'Reason', type: 'textarea', max: 500 });
const invoiceField = (optional = false) => ({ name: 'invoice_id', label: optional ? 'Invoice (optional; leave unallocated)' : 'Invoice', type: 'record', resource: 'invoices', optional });
const resourceFields = [
  { name: 'name', label: 'Resource name', max: 120 },
  { name: 'role', label: 'Role', max: 120 },
  { name: 'planned_minutes', label: 'Planned effort (minutes)', type: 'integer', min: 1 },
  { name: 'weekly_capacity_minutes', label: 'Weekly capacity (minutes)', type: 'integer', min: 1 },
  { name: 'start_date', label: 'Start date', type: 'date' },
  { name: 'end_date', label: 'Delivery deadline', type: 'date' }
];
const entryFields = [
  { name: 'resource_id', label: 'Resource', type: 'record', resource: 'resources' },
  { name: 'work_date', label: 'Work date', type: 'date' },
  { name: 'minutes', label: 'Minutes worked', type: 'integer', min: 1 },
  { name: 'description', label: 'Work description', type: 'textarea', max: 500 }
];

function createField(spec, record = {}) {
  const value = record[spec.name] ?? spec.default ?? '';
  let input;
  if (spec.type === 'checkbox') {
    input = h('input', { name: spec.name, type: 'checkbox', checked: Boolean(value) });
  } else if (spec.type === 'record' || spec.type === 'select') {
    input = h('select', { name: spec.name, required: !spec.optional },
      h('option', { value: '', text: spec.optional ? 'None — keep unallocated' : 'Choose a record' }),
      ...(spec.options ?? []).map(([id, label]) => h('option', { value: id, text: label })));
    if (spec.type === 'select') input.value = value;
  } else if (spec.type === 'textarea') {
    input = h('textarea', { name: spec.name, rows: 3, required: !spec.optional, maxlength: spec.max ?? 2000 });
    input.value = typeof value === 'object' ? bankText(value) : value;
  } else {
    input = h('input', {
      name: spec.name, type: ['money', 'integer'].includes(spec.type) ? 'text' : spec.type ?? 'text',
      required: !spec.optional, maxlength: spec.max ?? (spec.type === 'money' ? 18 : 200),
      inputmode: spec.type === 'money' ? 'decimal' : spec.type === 'integer' ? 'numeric' : undefined,
      pattern: spec.type === 'money' ? '[0-9]+(\\.[0-9]{1,2})?' : spec.type === 'integer' ? '[0-9]+' : undefined
    });
    input.value = spec.type === 'money' && value !== '' ? decimal(value) : String(value);
  }
  const label = h('label', { className: spec.type === 'checkbox' ? 'billing-choice' : 'field' }, spec.type === 'checkbox' ? input : null,
    h('span', { text: spec.label }), spec.type !== 'checkbox' ? input : null);
  return { label, input, spec };
}

async function allRecords(resource) {
  const items = [];
  const cursors = new Set();
  let cursor;
  do {
    // Finance list endpoints accept page_size 1-50; follow next_cursor for complete choices.
    const query = new URLSearchParams({ page_size: '50' });
    if (cursor) query.set('cursor', cursor);
    const result = await request(`${base}/${resource}?${query}`);
    items.push(...result.items);
    cursor = result.next_cursor;
    if (cursor && cursors.has(cursor)) throw validation('The server returned a repeated pagination cursor. Refresh and retry.');
    cursors.add(cursor);
  } while (cursor);
  return items;
}

async function populateChoices(fields, record, epoch) {
  await Promise.all(fields.filter(({ spec }) => spec.type === 'record').map(async ({ input, spec }) => {
    const items = await allRecords(spec.resource);
    if (epoch !== state.editorEpoch) return;
    input.append(...items.map((item) => h('option', {
      value: item.id,
      text: `${labelOf(item)}${spec.resource === 'invoices' ? ` · Outstanding ${money(item.outstanding_minor)} · ${human(item.document_state)}`
        : spec.resource === 'payments' ? ` · Unallocated ${money(item.unallocated_minor)} · ${human(item.status)}` : ''}`
    })));
    input.value = record[spec.name] ?? '';
  }));
}

function valuesFrom(fields) {
  const result = {};
  for (const { spec, input } of fields) {
    if (spec.type === 'checkbox') { result[spec.name] = input.checked; continue; }
    const value = input.value.trim();
    if (!value && spec.optional) continue;
    result[spec.name] = spec.type === 'money' ? minor(value)
      : spec.type === 'integer' ? integer(value, spec.label) : value;
    if (spec.type === 'integer' && result[spec.name] < (spec.min ?? 0)) throw validation(`${spec.label} must be at least ${spec.min ?? 0}.`);
  }
  return result;
}

function editor(title, hint, specs, record, save, extra) {
  closeEditor();
  const epoch = state.editorEpoch;
  const generation = state.generation;
  $('editor-heading').textContent = title;
  $('editor-hint').textContent = hint;
  const fields = specs.map((spec) => createField(spec, record));
  const status = h('p', { className: 'form-status', role: 'status', hidden: true });
  const submit = h('button', { type: 'submit', className: 'button button-primary', text: 'Save / confirm' });
  const form = h('form', {},
    h('div', { className: 'billing-fields' }, ...fields.map(({ label }) => label)),
    extra?.element,
    h('div', { className: 'row-actions' }, submit, button('Cancel', closeEditor)),
    status);
  $('editor-body').replaceChildren(form);
  $('record-editor').hidden = false;
  $('editor-heading').focus();
  const ready = populateChoices(fields, record, epoch);
  submit.disabled = true;
  ready.then(() => { if (epoch === state.editorEpoch) submit.disabled = false; }).catch((error) => {
    if (epoch === state.editorEpoch) showStatus(status, describeError(error));
    report(error);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (epoch !== state.editorEpoch || generation !== state.generation) return;
    const controls = [...form.querySelectorAll('input, select, textarea, button')];
    const disabled = controls.map((control) => control.disabled);
    try {
      await ready;
      const body = valuesFrom(fields);
      extra?.read(body);
      controls.forEach((control) => { control.disabled = true; });
      showStatus(status, '');
      await save(body);
      if (generation !== state.generation || epoch !== state.editorEpoch) return;
      closeEditor();
      closeDetail();
      await Promise.all([loadSummary(), loadList(), loadProfile()]);
      if (generation === state.generation) showStatus($('page-status'), 'Saved. Review the refreshed record for document, delivery and settlement status.', 'success');
    } catch (error) {
      if (epoch === state.editorEpoch && generation === state.generation) showStatus(status, describeError(error));
      report(error);
    } finally {
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
    }
  });
  return { epoch, form };
}

function sourcePicker(kind, allowTypeSwitch) {
  const selections = new Map();
  let resource = kind;
  let cursor = null;
  let loading = false;
  let epoch = 0;
  const editorEpoch = state.editorEpoch + 1;
  const generation = state.generation;
  const list = h('ul', { className: 'team-list' });
  const count = h('p', { className: 'hint', text: '0 selected. Selections are kept across pages.' });
  const status = h('p', { className: 'form-status', role: 'status', hidden: true });
  const more = button('More sources', () => load(true));
  more.hidden = true;
  const select = h('select', { name: 'source_type' },
    h('option', { value: 'billing-items', text: 'Fixed billing items' }),
    h('option', { value: 'time-entries', text: 'Time entries' }));
  select.value = resource;
  const element = h('fieldset', { className: 'billing-picker' },
    h('legend', { text: 'Select source records' }),
    allowTypeSwitch ? h('label', { className: 'field' }, h('span', { text: 'Source type (changing clears selections)' }), select) : null,
    allowTypeSwitch ? button('Load month-end candidates', loadCandidates) : null,
    h('p', { className: 'hint', text: 'Select up to 20 eligible, accepted or approved, uninvoiced sources. The server validates eligibility.' }),
    count, list, status, h('div', { className: 'pager' }, more));
  function renderChoices(items, append = false) {
    const choices = items.map((record) => {
      const ineligible = Boolean(record.billed_invoice_id || record.invoice_id || record.status === 'cancelled'
        || (!allowTypeSwitch && (record.statement_id || record.approved_at))
        || (allowTypeSwitch && resource === 'billing-items' && record.requires_acceptance && !record.accepted_at)
        || (allowTypeSwitch && resource === 'time-entries' && !record.approved_at));
      const checkbox = h('input', { type: 'checkbox', value: record.id, checked: selections.has(record.id), disabled: ineligible });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selections.set(record.id, record);
        else selections.delete(record.id);
        count.textContent = `${selections.size} selected. Selections are kept across pages.`;
      });
      return h('li', {}, h('label', { className: 'billing-choice' }, checkbox,
        h('span', { text: `${labelOf(record)} · ${resource === 'billing-items' ? `${money(record.amount_minor)} · due ${text(record.due_date)}` : `${text(record.work_date)} · ${text(record.minutes)} minutes · ${text(record.description)}`}${ineligible ? ' · not eligible for this selection' : ''}` })));
    });
    if (append) list.append(...choices);
    else list.replaceChildren(...(choices.length ? choices : [h('li', { text: 'No eligible source records found for this view.' })]));
  }
  async function loadCandidates() {
    const month = element.closest('form').elements.namedItem('billing_month').value;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw validation('Choose a billing month before loading month-end candidates.');
    const current = ++epoch;
    loading = true;
    more.hidden = true;
    try {
      const result = await request(`${base}/monthly-candidates?${new URLSearchParams({ month })}`);
      if (generation !== state.generation || editorEpoch !== state.editorEpoch || current !== epoch) return;
      const source = result.source_type === 'billing_item' ? 'billing-items' : result.source_type === 'time_entry' ? 'time-entries' : '';
      if (!source) throw validation('The server returned an unsupported monthly source type.');
      resource = source;
      select.value = resource;
      cursor = null;
      selections.clear();
      count.textContent = '0 selected. Choose 1–20 sources to prepare a draft; nothing is charged automatically.';
      renderChoices(result.items);
      showStatus(status, `Candidates for ${result.month}, cutoff ${result.cutoff}, including eligible carryover. Review and select sources explicitly.`, 'success');
    } catch (error) {
      if (current === epoch && editorEpoch === state.editorEpoch) showStatus(status, describeError(error));
      throw error;
    } finally {
      if (current === epoch) loading = false;
    }
  }
  async function load(append = false) {
    const current = ++epoch;
    loading = true;
    more.disabled = true;
    const query = new URLSearchParams({ page_size: '25' });
    if (append && cursor) query.set('cursor', cursor);
    try {
      const result = await request(`${base}/${resource}?${query}`);
      if (generation !== state.generation || editorEpoch !== state.editorEpoch || current !== epoch) return;
      cursor = result.next_cursor;
      renderChoices(result.items, append);
      more.hidden = !cursor;
      showStatus(status, '');
    } catch (error) {
      if (current === epoch && editorEpoch === state.editorEpoch) showStatus(status, describeError(error));
      throw error;
    } finally {
      if (current === epoch) { loading = false; more.disabled = false; }
    }
  }
  select.addEventListener('change', () => {
    resource = select.value;
    selections.clear();
    count.textContent = '0 selected. Selections are kept across pages.';
    cursor = null;
    list.replaceChildren();
    load().catch(report);
  });
  return {
    element,
    load: () => load(),
    read(body) {
      if (loading) throw validation('Wait for the sources to finish loading.');
      if (!selections.size) throw validation('Select at least one source record.');
      if (selections.size > 20) throw validation('Choose no more than 20 source records per invoice or statement.');
      if (allowTypeSwitch) {
        body.source_type = resource === 'billing-items' ? 'billing_item' : 'time_entry';
        body.source_ids = [...selections.keys()];
      } else body.entry_ids = [...selections.keys()];
    }
  };
}

function openRecordForm(resource, record = {}) {
  if (!state.capabilities?.can_prepare) throw validation('Only the issuer can prepare finance records.');
  const editing = Boolean(record.id);
  let specs;
  let picker;
  if (resource === 'resources') specs = resourceFields;
  if (resource === 'billing-items') specs = [
    { name: 'title', label: 'Billing item title', max: 200 }, amountField(),
    { name: 'due_date', label: 'Due date', type: 'date' },
    { name: 'requires_acceptance', label: 'Require customer acceptance', type: 'checkbox', default: true }
  ];
  if (resource === 'time-entries') specs = entryFields;
  if (resource === 'time-statements') { specs = []; picker = sourcePicker('time-entries', false); }
  if (resource === 'invoices') {
    specs = [{ name: 'issue_date', label: 'Issue date', type: 'date' }];
    if (!editing) {
      specs.push({ name: 'billing_month', label: 'Billing month (optional; load month-end candidates below)', type: 'month', optional: true });
      picker = sourcePicker('billing-items', true);
    }
  }
  if (resource === 'payments') specs = [
    invoiceField(true), amountField(), { name: 'received_date', label: 'Date received', type: 'date' },
    { name: 'reference', label: 'Bank / receipt reference', max: 200 }
  ];
  if (resource === 'credit-notes') specs = [invoiceField(), amountField('net_minor', 'Net credit (INR, before GST)'), reasonField()];
  if (resource === 'refunds') specs = [
    { name: 'payment_id', label: 'Payment with unallocated credit', type: 'record', resource: 'payments' },
    amountField(), reasonField()
  ];
  if (!specs) throw validation('This record cannot be edited here.');
  editor(`${editing ? 'Edit' : 'Create'} ${titles[resource].toLowerCase()}`,
    hints[resource], specs, record, async (body) => {
      if (resource === 'resources' && body.end_date < body.start_date) throw validation('The delivery deadline must not be before the start date.');
      if (resource === 'invoices' && body.billing_month) {
        const [year, month] = body.billing_month.split('-').map(Number);
        const cutoff = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
        if (body.issue_date < cutoff) throw validation(`A ${body.billing_month} invoice must be dated ${cutoff} or later.`);
      }
      await write(`${base}/${resource}${editing ? `/${encode(record.id)}` : ''}`, editing ? 'PATCH' : 'POST', body, editing ? record : null);
    }, picker);
  picker?.load().catch(report);
}

function openActionForm(resource, record, title, action, specs, hint) {
  const epoch = state.editorEpoch + 1;
  const generation = state.generation;
  editor(`${title} · ${labelOf(record)}`, hint, specs, {}, async (body) => {
    try {
      await write(`${base}/${resource}/${encode(record.id)}/${action}`, 'POST', body, record);
    } catch (error) {
      if (action === 'notify' && error.status === 503 && epoch === state.editorEpoch && generation === state.generation) {
        await selectRecord(resource, record);
        await Promise.all([loadList(), loadSummary()]);
      }
      throw error;
    }
  });
}

function openProfileForm() {
  if (!state.capabilities?.can_prepare || !state.profile) throw validation('Issuer access is required.');
  const profile = state.profile;
  const specs = profileFields.map(([label, name]) => ({
    label, name,
    type: name === 'gst_rate_bps' ? 'integer' : ['customer_address', 'issuer_address', 'bank_details'].includes(name) ? 'textarea' : 'text',
    optional: ['customer_gstin', 'legal_approval_reference'].includes(name),
    max: ['customer_address', 'issuer_address', 'bank_details'].includes(name) ? 1000 : 200
  }));
  specs.push({ name: 'legal_approved', label: 'Legal and tax details reviewed and approved (server gate still applies)', type: 'checkbox' });
  editor('Edit legal and tax configuration',
    'GST rate is in basis points (1800 = 18%). Only mark legal approval after review. Issuance remains subject to server configuration.',
    specs, profile, (body) => write(`${base}/profile`, 'PUT', {
      ...body, customer_gstin: body.customer_gstin ?? '', issuer_gstin: body.issuer_gstin ?? '',
      legal_approval_reference: body.legal_approval_reference ?? ''
    }, profile));
}

async function mountGithub() {
  const generation = state.generation;
  const container = $('github-delivery');
  try {
    const github = await import('/assets/js/crm-github.js?v=__ASSET_VERSION__');
    if (generation !== state.generation) return;
    const cleanup = await github.mountGithub(container, { projectId, clientId, capabilities: state.capabilities });
    if (generation !== state.generation) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    state.githubCleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (error) {
    if (generation === state.generation) container.replaceChildren(h('p', {
      className: 'hint', text: `GitHub delivery unavailable. ${describeError(error)}`
    }));
  }
}

async function main() {
  clearPrivateView();
  const generation = state.generation;
  if (!projectId || !clientId) throw validation('Open billing from a project. Both client and project IDs are required.');
  $('refresh-billing').disabled = true;
  try {
    // Ordinary project authorization runs first; capability flags are never inferred from cached roles.
    const project = await request(`/projects/${encode(projectId)}`);
    if (project.client_id && project.client_id !== clientId) throw validation('The project does not belong to this workspace.');
    const capabilities = await request(`/clients/${encode(clientId)}/crm/capabilities`);
    if (!capabilities.can_prepare && !capabilities.can_accept) throw new ApiError(403, 'FORBIDDEN', 'Finance is available only to workspace owners.');
    if (generation !== state.generation) return;
    state.capabilities = capabilities;
    state.resource = 'resources';
    $('record-type').value = state.resource;
    $('billing-project').textContent = project.name ?? projectId;
    $('back-link').href = `/workspace/project/?id=${encode(projectId)}`;
    await Promise.all([loadSummary(), loadProfile(), loadList()]);
    if (generation !== state.generation) return;
    $('billing-content').hidden = false;
    mountGithub().catch(report);
  } catch (error) {
    if (generation === state.generation) clearPrivateView();
    throw error;
  } finally {
    if (generation === state.generation) $('refresh-billing').disabled = false;
  }
}

$('record-filter').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state.capabilities) return;
  state.resource = $('record-type').value;
  closeEditor();
  closeDetail();
  loadList().catch(report);
});
$('new-record').addEventListener('click', () => {
  try { openRecordForm(state.resource); } catch (error) { report(error); }
});
$('edit-profile').addEventListener('click', () => {
  try { openProfileForm(); } catch (error) { report(error); }
});
$('close-detail').addEventListener('click', closeDetail);
$('first-page').addEventListener('click', () => loadList().catch(report));
$('next-page').addEventListener('click', () => {
  if (state.next) loadList(state.next).catch(report);
});
$('refresh-billing').addEventListener('click', () => main().catch(report));
window.addEventListener('pagehide', clearPrivateView);
window.addEventListener('pageshow', () => main().catch(report));
