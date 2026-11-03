import { HttpError, log } from '../http.mjs';
import { getDoc, newId, queryPage } from '../db.mjs';
import { Checker } from '../validation.mjs';
import { commitFinance, financeAccess, financeProject, ref, write } from '../crm.mjs';
import {
  COLLECTIONS, allProjectRecords, dateField, exactFields, fail, financeCommand,
  hourlyAmount, idsField, invoiceView, matchVersion, moneyField, own, requireIssuance, requirePlan, totals, versionOf
} from '../finance.mjs';
import { renderInvoicePdf, validateDocumentText } from '../invoice-pdf.mjs';
import { siteOrigin } from '../mail.mjs';
import { verifyCrmWorker } from '../github-crm.mjs';

const headers = { 'Cache-Control': 'no-store' };
const basePlanId = (project) => `${project.id}__base`;
const profileId = (project) => `${project.client_id}__billing`;
const send = (ctx, status, record) => ctx.send(status, record, { ...headers, ...(record?.version !== undefined ? { ETag: versionOf(record) } : {}) });
const nextRecord = (record, values, now) => ({ ...record, ...values, version: (record?.version ?? 0) + 1, updated_at: now });
function seed(id, project, now) {
  return { id, client_id: project.client_id, project_id: project.id, currency: 'INR', version: 1, created_at: now, updated_at: now };
}
function params(ctx) {
  const raw = ctx.query.get('page_size') ?? '25';
  if (!/^\d+$/.test(raw)) fail('BAD_REQUEST', 'Invalid page_size.', 400);
  return { pageSize: Number(raw), after: ctx.query.get('cursor') };
}
function calendar(check) {
  dateField(check, 'start_date');
  dateField(check, 'end_date');
  if (check.output.end_date < check.output.start_date) check.fail('end_date', 'End date cannot precede start date.');
}
function readResource(input, current = {}) {
  const merged = { ...current, ...input };
  const check = new Checker(merged);
  for (const key of Object.keys(input)) if (!['name', 'role', 'planned_minutes', 'weekly_capacity_minutes', 'start_date', 'end_date'].includes(key)) check.fail(key, 'This field cannot be changed here.');
  check.text('name', { required: true, min: 1, max: 120 });
  check.text('role', { required: true, min: 1, max: 120 });
  for (const key of ['planned_minutes', 'weekly_capacity_minutes']) {
    check.integer(key, { min: 1, max: key === 'weekly_capacity_minutes' ? 10080 : 60_000_000 });
    if (!check.has(key)) check.fail(key, 'This field is required.');
  }
  calendar(check);
  return check.done();
}
function readTime(input, current = {}) {
  const check = new Checker({ ...current, ...input });
  for (const key of Object.keys(input)) if (!['resource_id', 'work_date', 'minutes', 'description'].includes(key)) check.fail(key, 'This field cannot be changed here.');
  check.text('resource_id', { required: true, max: 100 });
  check.text('description', { required: true, min: 1, max: 500 });
  check.integer('minutes', { min: 1, max: 1440 });
  if (!check.has('minutes')) check.fail('minutes', 'This field is required.');
  dateField(check, 'work_date');
  return check.done();
}

async function getProfile(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  return send(ctx, 200, await getDoc('billing_profiles', profileId(project)) ?? { id: profileId(project), version: 0 });
}
async function putProfile(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const input = await ctx.body();
  const check = new Checker(input);
  const texts = ['customer_name', 'customer_address', 'customer_state_code', 'customer_gstin', 'issuer_name', 'issuer_address', 'issuer_state_code', 'issuer_gstin', 'bank_details', 'sac_code', 'legal_approval_reference'];
  exactFields(check, [...texts, 'gst_rate_bps', 'legal_approved']);
  for (const field of texts) check.text(field, { required: !['customer_gstin', 'legal_approval_reference'].includes(field), min: 0, max: field.endsWith('address') || field === 'bank_details' ? 1000 : 200 });
  check.integer('gst_rate_bps', { min: 0, max: 2800 });
  check.boolean('legal_approved');
  if (!check.has('gst_rate_bps') || ![0, 500, 1200, 1800, 2800].includes(input.gst_rate_bps)) check.fail('gst_rate_bps', 'Use a reviewed GST rate: 0, 500, 1200, 1800 or 2800 basis points.');
  for (const field of ['customer_state_code', 'issuer_state_code']) {
    if (!/^(0[1-9]|[12]\d|3[0-8])$/.test(input[field] ?? '')) check.fail(field, 'Use an Indian state/territory code 01-38.');
  }
  for (const field of ['issuer_gstin', 'customer_gstin']) {
    if ((input[field] || field === 'issuer_gstin') && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(input[field] ?? '')) check.fail(field, 'Enter a GSTIN in the expected format.');
    if (input[field] && !input[field].startsWith(input[field.replace('_gstin', '_state_code')] ?? 'invalid')) check.fail(field, 'GSTIN and state code must agree.');
  }
  if (!/^\d{6}$/.test(input.sac_code ?? '')) check.fail('sac_code', 'Use the reviewed six-digit SAC.');
  if (input.legal_approved && !input.legal_approval_reference?.trim()) check.fail('legal_approval_reference', 'Record the qualified reviewer approval reference.');
  const values = check.done();
  const result = await financeCommand(ctx, project, 'profile', input, [ref('billing_profiles', profileId(project))], 'issuer', 'billing.profile_updated', ([current], { now, user }) => {
    matchVersion(ctx, current);
    const updated = nextRecord(current ?? { id: profileId(project), client_id: project.client_id }, { ...values, approved_by: values.legal_approved ? user.id : null }, now);
    return { writes: [write('billing_profiles', updated.id, updated)], result: updated };
  });
  return send(ctx, 200, result);
}
async function list(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const collection = COLLECTIONS[ctx.params.kind];
  if (!collection) fail('NOT_FOUND', 'Unknown finance list.', 404);
  const page = await queryPage(collection, { where: [['client_id', '==', project.client_id], ['project_id', '==', project.id]], ...params(ctx) });
  if (collection === 'invoices') page.items = page.items.map(invoiceView);
  return send(ctx, 200, page);
}
async function detail(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const collection = COLLECTIONS[ctx.params.kind];
  if (!collection) fail('NOT_FOUND', 'Record not found.', 404);
  const record = own(await getDoc(collection, ctx.params.id), project);
  return send(ctx, 200, collection === 'invoices' ? invoiceView(record) : record);
}
async function createResource(ctx, project, input) {
  const values = readResource(input);
  const id = newId('res');
  return financeCommand(ctx, project, 'resource.create', input, [ref('crm_resources', id)], 'issuer', 'resource.created', ([_current], { now }) => {
    const record = { ...seed(id, project, now), ...values };
    return { writes: [write('crm_resources', id, record)], result: record };
  });
}
async function createBillingItem(ctx, project, input) {
  const check = new Checker(input);
  exactFields(check, ['title', 'amount_minor', 'due_date', 'requires_acceptance']);
  check.text('title', { required: true, min: 1, max: 200 });
  moneyField(check, 'amount_minor');
  dateField(check, 'due_date');
  check.boolean('requires_acceptance');
  const values = check.done();
  const id = newId('bit');
  return financeCommand(ctx, project, 'billing_item.create', input, [ref('billing_items', id), ref('billing_plans', basePlanId(project))], 'issuer', 'billing.item_created', ([_existing, plan], { now }) => {
    requirePlan(plan, project, 'fixed');
    const allocated = (plan.scheduled_minor ?? 0) + values.amount_minor;
    if (allocated > plan.amount_minor) fail('CONTRACT_CAP', 'Billing schedule would exceed the accepted contract.');
    const record = { ...seed(id, project, now), ...values, requires_acceptance: values.requires_acceptance ?? true, accepted_at: null, accepted_by: null, billed_invoice_id: null };
    return {
      writes: [write('billing_items', id, record), write('billing_plans', plan.id, nextRecord(plan, { scheduled_minor: allocated }, now))],
      result: record
    };
  });
}
async function createTime(ctx, project, input) {
  const values = readTime(input);
  const id = newId('tim');
  return financeCommand(ctx, project, 'time.create', input, [ref('time_entries', id), ref('crm_resources', values.resource_id), ref('billing_plans', basePlanId(project))], 'issuer', 'time.created', ([_current, resource, plan], { now }) => {
    own(resource, project);
    requirePlan(plan, project, 'hourly');
    if (values.work_date < resource.start_date || values.work_date > resource.end_date) fail('RESOURCE_DATES', 'Work date must be within the resource assignment.');
    if (values.work_date > new Date().toISOString().slice(0, 10)) fail('FUTURE_TIME', 'Actual time cannot be logged in the future.');
    const record = { ...seed(id, project, now), ...values, resource_name: resource.name, hourly_rate_minor: plan.hourly_rate_minor, amount_minor: hourlyAmount(values.minutes, plan.hourly_rate_minor), statement_id: null, approved_at: null, billed_invoice_id: null };
    return { writes: [write('time_entries', id, record)], result: record };
  });
}
async function createStatement(ctx, project, input) {
  const check = new Checker(input);
  exactFields(check, ['entry_ids']);
  const ids = idsField(check, 'entry_ids');
  check.done();
  const id = newId('tst');
  return financeCommand(ctx, project, 'statement.create', input, [ref('time_statements', id), ...ids.map((entryId) => ref('time_entries', entryId))], 'issuer', 'time.statement_created', ([_existing, ...entries], { now }) => {
    for (const entry of entries) {
      own(entry, project);
      if (entry.statement_id || entry.billed_invoice_id || entry.approved_at) fail('TIME_LOCKED', 'Time is already submitted, approved or billed.');
    }
    const record = { ...seed(id, project, now), entry_ids: ids, entry_versions: entries.map((entry) => entry.version + 1), status: 'submitted', total_minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0), amount_minor: entries.reduce((sum, entry) => sum + entry.amount_minor, 0) };
    return { writes: [write('time_statements', id, record), ...entries.map((entry) => write('time_entries', entry.id, nextRecord(entry, { statement_id: id }, now)))], result: record };
  });
}
function invoiceLines(records, sourceType, project, { issueDate, issuing = false } = {}) {
  return records.map((record) => {
    own(record, project);
    if (record.billed_invoice_id) fail('ALREADY_BILLED', 'A selected source has already been billed.');
    if (record.status === 'cancelled') fail('BILLING_CANCELLED', 'A selected billing source was cancelled.');
    if (sourceType === 'time_entry' && !record.approved_at) fail('TIME_APPROVAL_REQUIRED', 'Only customer-approved time can be invoiced.');
    if (sourceType === 'time_entry' && issuing && record.work_date > issueDate) fail('WORK_NOT_COMPLETED', 'Work cannot be billed before its recorded work date.');
    if (sourceType === 'billing_item') {
      if (record.requires_acceptance && !record.accepted_at) fail('ACCEPTANCE_REQUIRED', 'Customer milestone acceptance is required.');
      if (issuing && record.due_date > issueDate) fail('BILLING_NOT_DUE', 'This billing item is not yet due.');
    }
    return { source_id: record.id, source_version: record.version, description: record.title ?? record.description, amount_minor: record.amount_minor, ...(record.minutes ? { minutes: record.minutes, hourly_rate_minor: record.hourly_rate_minor } : {}) };
  });
}
function monthEnd(value) {
  if (typeof value !== 'string' || !/^(20\d{2})-(0[1-9]|1[0-2])$/.test(value)) fail('BAD_REQUEST', 'Use a billing month in YYYY-MM format (2000-2099).', 400);
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0)).toISOString().slice(0, 10);
}
async function monthlyCandidates(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const month = ctx.query.get('month');
  const cutoff = monthEnd(month);
  const plan = await getDoc('billing_plans', basePlanId(project));
  requirePlan(plan, project);
  const fixed = plan.billing_method === 'fixed';
  const records = await allProjectRecords(fixed ? 'billing_items' : 'time_entries', project);
  return send(ctx, 200, {
    month, cutoff, source_type: fixed ? 'billing_item' : 'time_entry',
    items: records.filter((record) => !record.billed_invoice_id && record.status !== 'cancelled' &&
      (fixed ? record.due_date <= cutoff && (!record.requires_acceptance || record.accepted_at) : record.work_date <= cutoff && record.approved_at))
  });
}
async function createInvoice(ctx, project, input) {
  const check = new Checker(input);
  exactFields(check, ['source_ids', 'source_type', 'issue_date', 'billing_month']);
  const ids = idsField(check, 'source_ids');
  check.oneOf('source_type', ['billing_item', 'time_entry'], { required: true });
  dateField(check, 'issue_date');
  const values = check.done();
  const cutoff = input.billing_month === undefined ? null : monthEnd(input.billing_month);
  if (cutoff && values.issue_date < cutoff) fail('MONTH_NOT_CLOSED', 'Monthly invoices must be dated at or after month end.');
  if (cutoff) values.billing_month = input.billing_month;
  const id = newId('inv');
  const sourceCollection = values.source_type === 'billing_item' ? 'billing_items' : 'time_entries';
  return financeCommand(ctx, project, 'invoice.create', input, [
    ref('invoices', id), ref('billing_plans', basePlanId(project)), ref('billing_profiles', profileId(project)),
    ...ids.map((sourceId) => ref(sourceCollection, sourceId))
  ], 'issuer', 'invoice.drafted', ([_current, plan, profile, ...sources], { now }) => {
    requirePlan(plan, project, values.source_type === 'billing_item' ? 'fixed' : 'hourly');
    if (cutoff && sources.some((source) => own(source, project)[values.source_type === 'billing_item' ? 'due_date' : 'work_date'] > cutoff)) fail('OUTSIDE_BILLING_PERIOD', 'A source falls after this billing month.');
    const lines = invoiceLines(sources, values.source_type, project);
    const record = {
      ...seed(id, project, now), ...values, project_name: project.name, source_ids: ids,
      lines, ...totals(lines, profile), profile_snapshot: profile ?? null, plan_version: plan.version,
      document_state: 'draft', number: null, paid_minor: 0, credited_minor: 0, credited_net_minor: 0,
      due_date: null, delivery_state: 'not_requested'
    };
    return { writes: [write('invoices', id, record)], result: record };
  });
}

async function create(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const input = await ctx.body();
  const handlers = { resources: createResource, 'billing-items': createBillingItem, 'time-entries': createTime, 'time-statements': createStatement, invoices: createInvoice, payments: createPayment, 'credit-notes': createCredit, refunds: createRefund };
  const handler = handlers[ctx.params.kind];
  if (!handler) fail('NOT_FOUND', 'Unknown finance operation.', 404);
  const record = await handler(ctx, project, input);
  if (ctx.params.kind === 'credit-notes') await persistDocument(ctx, project, record, 'credit_notes');
  return send(ctx, 201, record);
}

async function edit(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const input = await ctx.body();
  const kind = ctx.params.kind;
  if (!['resources', 'time-entries', 'invoices'].includes(kind)) fail('IMMUTABLE_RECORD', 'This record cannot be edited.');
  const collection = COLLECTIONS[kind];
  const before = own(await getDoc(collection, ctx.params.id), project);
  const values = kind === 'resources' ? readResource(input, before) : kind === 'time-entries' ? readTime(input, before) : (() => {
    const check = new Checker(input);
    exactFields(check, ['issue_date']);
    dateField(check, 'issue_date');
    return check.done();
  })();
  const refs = [ref(collection, before.id)];
  if (kind === 'time-entries') refs.push(ref('crm_resources', values.resource_id));
  const result = await financeCommand(ctx, project, `${kind}.${before.id}.edit`, input, refs, 'issuer', `${kind.replaceAll('-', '_')}.updated`, ([current, resource], { now }) => {
    own(current, project);
    matchVersion(ctx, current);
    if (kind === 'time-entries') {
      if (current.statement_id || current.approved_at || current.billed_invoice_id) fail('TIME_LOCKED', 'Submitted/approved/billed time cannot be edited.');
      own(resource, project);
      if (values.work_date < resource.start_date || values.work_date > resource.end_date || values.work_date > now.slice(0, 10)) fail('RESOURCE_DATES', 'Work date is outside the actual assignment period.');
      values.amount_minor = hourlyAmount(values.minutes, current.hourly_rate_minor);
      values.resource_name = resource.name;
    }
    if (kind === 'invoices' && current.document_state !== 'draft') fail('IMMUTABLE_INVOICE', 'Issued invoice terms cannot be edited.');
    const record = nextRecord(current, values, now);
    return { writes: [write(collection, current.id, record)], result: record };
  });
  return send(ctx, 200, result);
}

async function sourceAction(ctx, project, kind, before, input) {
  const action = ctx.params.action;
  if (kind === 'billing-items' && action === 'cancel') {
    const check = new Checker(input);
    exactFields(check, ['reason']);
    check.text('reason', { required: true, min: 1, max: 500 });
    const values = check.done();
    return financeCommand(ctx, project, `billing-item.${before.id}.cancel`, input,
      [ref('billing_items', before.id), ref('billing_plans', basePlanId(project))], 'issuer', 'billing.item_cancelled',
      ([current, plan], { now }) => {
        own(current, project);
        requirePlan(plan, project, 'fixed');
        matchVersion(ctx, current);
        if (current.billed_invoice_id || current.status === 'cancelled') fail('BILLING_LOCKED', 'Billed or cancelled items cannot be cancelled.');
        const record = nextRecord(current, { status: 'cancelled', cancellation_reason: values.reason, cancelled_at: now }, now);
        return { writes: [
          write('billing_items', current.id, record),
          write('billing_plans', plan.id, nextRecord(plan, { scheduled_minor: plan.scheduled_minor - current.amount_minor }, now))
        ], result: record };
      });
  }
  const check = new Checker(input);
  exactFields(check, action === 'reject' ? ['reason'] : []);
  if (action === 'reject') check.text('reason', { required: true, min: 1, max: 500 });
  check.done();
  const isStatement = kind === 'time-statements';
  if (!(isStatement ? ['approve', 'reject'] : ['accept']).includes(action)) fail('NOT_FOUND', 'Unknown approval action.', 404);
  const refs = [ref(COLLECTIONS[kind], before.id), ...(isStatement ? before.entry_ids.map((id) => ref('time_entries', id)) : [])];
  return financeCommand(ctx, project, `${kind}.${before.id}.${action}`, input, refs, 'customer', `billing.${action}`, ([current, ...entries], { now, user }) => {
    own(current, project);
    matchVersion(ctx, current);
    const writes = [];
    if (isStatement) {
      if (current.status !== 'submitted') fail('STATEMENT_FINAL', 'This statement is no longer awaiting approval.');
      entries.forEach((entry, index) => {
        own(entry, project);
        if (entry.version !== current.entry_versions[index] || entry.statement_id !== current.id || entry.billed_invoice_id) fail('TIME_CHANGED', 'The submitted time changed.');
        writes.push(write('time_entries', entry.id, nextRecord(entry, action === 'approve' ? { approved_at: now, approved_by: user.id } : { statement_id: null, approved_at: null, approved_by: null }, now)));
      });
    } else if (current.accepted_at || current.billed_invoice_id || current.status === 'cancelled') fail('ALREADY_ACCEPTED', 'This billing item has already been accepted, billed or cancelled.');
    const record = nextRecord(current, isStatement ? { status: action === 'approve' ? 'approved' : 'rejected', approved_by: user.id, approved_at: now, rejection_reason: input.reason ?? null } : { accepted_by: user.id, accepted_at: now }, now);
    writes.push(write(COLLECTIONS[kind], current.id, record));
    return { writes, result: record };
  });
}

async function issueInvoice(ctx, project, before, input) {
  if (Object.keys(input).length) fail('BAD_REQUEST', 'Issuance uses saved invoice terms.', 400);
  const fiscalStart = Number(before.issue_date.slice(5, 7)) >= 4 ? Number(before.issue_date.slice(0, 4)) : Number(before.issue_date.slice(0, 4)) - 1;
  const counterId = `invoice_${fiscalStart}`;
  const sourceCollection = before.source_type === 'billing_item' ? 'billing_items' : 'time_entries';
  const result = await financeCommand(ctx, project, `invoice.${before.id}.issue`, input, [
    ref('invoices', before.id), ref('billing_profiles', profileId(project)), ref('billing_plans', basePlanId(project)),
    ref('invoice_counters', counterId), ...before.source_ids.map((id) => ref(sourceCollection, id))
  ], 'issuer', 'invoice.issued', ([current, profile, plan, counter, ...sources], { now, user }) => {
    own(current, project);
    matchVersion(ctx, current);
    requireIssuance(ctx, profile);
    requirePlan(plan, project, before.source_type === 'billing_item' ? 'fixed' : 'hourly');
    if (current.document_state !== 'draft') fail('ALREADY_ISSUED', 'Invoice has already been issued.');
    if (current.issue_date !== before.issue_date) fail('INVOICE_CHANGED', 'Reload the invoice date.');
    if (current.issue_date > now.slice(0, 10)) fail('FUTURE_ISSUE_DATE', 'Cannot issue a future-dated invoice.');
    if (current.billing_month && current.issue_date < monthEnd(current.billing_month)) fail('MONTH_NOT_CLOSED', 'A monthly invoice cannot be issued before month end.');
    const lines = invoiceLines(sources, current.source_type, project, { issuing: true, issueDate: current.issue_date });
    if (lines.some((line, index) => line.source_version !== current.lines[index].source_version)) fail('SOURCE_CHANGED', 'A billing source changed. Create a fresh draft.');
    const calculated = totals(lines, profile);
    validateDocumentText([...Object.values(profile).filter((value) => typeof value === 'string'), current.project_name, ...lines.map((line) => line.description)]);
    const billed = (plan.billed_minor ?? 0) + calculated.net_minor;
    if (billed > plan.amount_minor) fail('CONTRACT_CAP', 'Invoice would exceed the accepted contract cap.');
    const sequence = (counter?.sequence ?? 0) + 1;
    if (sequence > 999999) fail('NUMBER_SERIES_EXHAUSTED', 'Invoice number series exhausted.');
    const number = `S${String(fiscalStart).slice(-2)}${String(fiscalStart + 1).slice(-2)}/${String(sequence).padStart(6, '0')}`;
    const due = new Date(`${current.issue_date}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 30);
    const record = nextRecord(current, {
      ...calculated, lines, profile_snapshot: profile, number, issued_at: now, issued_by: user.id,
      document_state: 'issued', due_date: due.toISOString().slice(0, 10), delivery_state: 'not_requested'
    }, now);
    return {
      writes: [
        write('invoices', current.id, record), write('invoice_counters', counterId, { id: counterId, sequence }),
        write('billing_plans', plan.id, nextRecord(plan, { billed_minor: billed }, now)),
        ...sources.map((source) => write(sourceCollection, source.id, nextRecord(source, { billed_invoice_id: current.id }, now)))
      ], result: invoiceView(record)
    };
  });
  await persistDocument(ctx, project, result, 'invoices');
  return result;
}

async function createPayment(ctx, project, input) {
  const check = new Checker(input);
  exactFields(check, ['invoice_id', 'amount_minor', 'received_date', 'reference']);
  moneyField(check, 'amount_minor');
  dateField(check, 'received_date');
  check.text('reference', { required: true, min: 1, max: 200 });
  check.text('invoice_id', { max: 100 });
  const values = check.done();
  const id = newId('pay');
  return financeCommand(ctx, project, 'payment.create', input, [ref('payments', id), ...(values.invoice_id ? [ref('invoices', values.invoice_id)] : [])], 'issuer', 'payment.received', ([_existing, invoice], { now, user }) => {
    if (values.received_date > now.slice(0, 10)) fail('FUTURE_PAYMENT', 'A receipt cannot be in the future.');
    const writes = [];
    let allocated = 0;
    if (values.invoice_id) {
      own(invoice, project);
      if (invoice.document_state !== 'issued') fail('ISSUED_INVOICE_REQUIRED', 'Payments apply only to issued invoices.');
      allocated = Math.min(values.amount_minor, invoiceView(invoice).outstanding_minor);
      writes.push(write('invoices', invoice.id, nextRecord(invoice, { paid_minor: invoice.paid_minor + allocated }, now)));
    }
    const record = {
      ...seed(id, project, now), ...values, confirmed_by: user.id, status: 'confirmed', refunded_minor: 0,
      unallocated_minor: values.amount_minor - allocated,
      allocations: allocated ? [{ invoice_id: invoice.id, amount_minor: allocated, allocated_at: now }] : []
    };
    return { writes: [...writes, write('payments', id, record)], result: record };
  });
}
async function createCredit(ctx, project, input) {
  const check = new Checker(input);
  exactFields(check, ['invoice_id', 'net_minor', 'reason']);
  check.text('invoice_id', { required: true, max: 100 });
  check.text('reason', { required: true, min: 1, max: 500 });
  moneyField(check, 'net_minor');
  const values = check.done();
  validateDocumentText([values.reason]);
  const id = newId('crn');
  return financeCommand(ctx, project, 'credit.create', input, [ref('credit_notes', id), ref('invoices', values.invoice_id), ref('invoice_counters', 'credit')], 'issuer', 'invoice.credited', ([_existing, invoice, counter], { now, user }) => {
    own(invoice, project);
    requireIssuance(ctx, invoice.profile_snapshot);
    if (invoice.document_state !== 'issued') fail('ISSUED_INVOICE_REQUIRED', 'Only issued invoices can be credited.');
    const netTotal = (invoice.credited_net_minor ?? 0) + values.net_minor;
    if (netTotal > invoice.net_minor) fail('EXCESS_CREDIT', 'Credit exceeds the original net invoice.');
    const targetTax = roundedCreditTax(invoice, netTotal);
    const tax = targetTax - ((invoice.credited_minor ?? 0) - (invoice.credited_net_minor ?? 0));
    const total = values.net_minor + tax;
    const cumulativeCgst = invoice.tax_minor ? Number(BigInt(targetTax) * BigInt(invoice.tax_components.cgst_minor) / BigInt(invoice.tax_minor)) : 0;
    const cumulativeTax = {
      cgst_minor: cumulativeCgst,
      sgst_minor: invoice.tax_components.igst_minor ? 0 : targetTax - cumulativeCgst,
      igst_minor: invoice.tax_components.igst_minor ? targetTax : 0
    };
    const taxComponents = Object.fromEntries(Object.entries(cumulativeTax).map(([component, amount]) => [component, amount - (invoice.credited_tax_components?.[component] ?? 0)]));
    if (total > invoiceView(invoice).outstanding_minor) fail('CREDIT_EXCEEDS_BALANCE', 'Reverse the relevant payment allocation before crediting a paid amount.');
    const sequence = (counter?.sequence ?? 0) + 1;
    const record = {
      ...seed(id, project, now), ...values, number: `CN/${sequence}`, tax_minor: tax, total_minor: total,
      issued_by: user.id, invoice_number: invoice.number, profile_snapshot: invoice.profile_snapshot,
      invoice_issue_date: invoice.issue_date, invoice_date: now.slice(0, 10), tax_components: taxComponents,
      project_name: invoice.project_name
    };
    return {
      writes: [
        write('credit_notes', id, record), write('invoice_counters', 'credit', { id: 'credit', sequence }),
        write('invoices', invoice.id, nextRecord(invoice, {
          credited_minor: (invoice.credited_minor ?? 0) + total, credited_net_minor: netTotal,
          credited_tax_components: Object.fromEntries(Object.entries(taxComponents).map(([component, amount]) => [component, (invoice.credited_tax_components?.[component] ?? 0) + amount]))
        }, now))
      ], result: record
    };
  });
}
function roundedCreditTax(invoice, creditedNet) {
  return Number((BigInt(creditedNet) * BigInt(invoice.tax_minor) + BigInt(invoice.net_minor) / 2n) / BigInt(invoice.net_minor));
}
async function createRefund(ctx, project, input) {
  const check = new Checker(input);
  exactFields(check, ['payment_id', 'amount_minor', 'reason']);
  check.text('payment_id', { required: true, max: 100 });
  check.text('reason', { required: true, min: 1, max: 500 });
  moneyField(check, 'amount_minor');
  const values = check.done();
  const id = newId('rfd');
  return financeCommand(ctx, project, 'refund.create', input, [ref('refunds', id), ref('payments', values.payment_id)], 'issuer', 'payment.refunded', ([_existing, payment], { now, user }) => {
    own(payment, project);
    if (payment.status !== 'confirmed' || values.amount_minor > payment.unallocated_minor) fail('EXCESS_REFUND', 'Only available unallocated receipt credit can be refunded.');
    const record = { ...seed(id, project, now), ...values, recorded_by: user.id };
    return {
      writes: [write('refunds', id, record), write('payments', payment.id, nextRecord(payment, {
        unallocated_minor: payment.unallocated_minor - values.amount_minor, refunded_minor: payment.refunded_minor + values.amount_minor
      }, now))], result: record
    };
  });
}

async function paymentAction(ctx, project, before, input) {
  const action = ctx.params.action;
  const check = new Checker(input);
  exactFields(check, action === 'allocate' ? ['invoice_id', 'amount_minor'] : ['reason']);
  if (action === 'allocate') {
    check.text('invoice_id', { required: true, max: 100 });
    moneyField(check, 'amount_minor');
  } else if (action === 'reverse') check.text('reason', { required: true, min: 1, max: 500 });
  else fail('NOT_FOUND', 'Unknown payment action.', 404);
  const values = check.done();
  const invoiceIds = action === 'allocate' ? [values.invoice_id] : [...new Set(before.allocations.map((allocation) => allocation.invoice_id))];
  return financeCommand(ctx, project, `payment.${before.id}.${action}`, input, [ref('payments', before.id), ...invoiceIds.map((id) => ref('invoices', id))], 'issuer', `payment.${action}`, ([current, ...invoices], { now }) => {
    own(current, project);
    matchVersion(ctx, current);
    if (current.status !== 'confirmed') fail('PAYMENT_REVERSED', 'This payment was already reversed.');
    const writes = [];
    let valuesToSave;
    if (action === 'allocate') {
      const invoice = own(invoices[0], project);
      if (current.allocations.length >= 20) fail('ALLOCATION_LIMIT', 'At most 20 allocations per receipt.');
      if (invoice.document_state !== 'issued' || values.amount_minor > invoiceView(invoice).outstanding_minor || values.amount_minor > current.unallocated_minor) fail('EXCESS_ALLOCATION', 'Allocation exceeds the available receipt credit or invoice balance.');
      writes.push(write('invoices', invoice.id, nextRecord(invoice, { paid_minor: invoice.paid_minor + values.amount_minor }, now)));
      valuesToSave = { allocations: [...current.allocations, { invoice_id: invoice.id, amount_minor: values.amount_minor, allocated_at: now }], unallocated_minor: current.unallocated_minor - values.amount_minor };
    } else {
      if (current.refunded_minor) fail('REFUNDED_PAYMENT', 'A refunded receipt cannot be reversed. Record an explicit correcting receipt.');
      for (const invoice of invoices) {
        own(invoice, project);
        const allocated = current.allocations.filter((allocation) => allocation.invoice_id === invoice.id).reduce((sum, allocation) => sum + allocation.amount_minor, 0);
        if (invoice.paid_minor < allocated) fail('RECONCILIATION_REQUIRED', 'Payment allocations require reconciliation.');
        writes.push(write('invoices', invoice.id, nextRecord(invoice, { paid_minor: invoice.paid_minor - allocated }, now)));
      }
      valuesToSave = { status: 'reversed', reversed_at: now, reversal_reason: values.reason, unallocated_minor: 0 };
    }
    const record = nextRecord(current, valuesToSave, now);
    return { writes: [...writes, write('payments', current.id, record)], result: record };
  });
}
async function voidInvoice(ctx, project, before, input) {
  const check = new Checker(input);
  exactFields(check, ['reason']);
  check.text('reason', { required: true, min: 1, max: 500 });
  const values = check.done();
  return financeCommand(ctx, project, `invoice.${before.id}.void`, input, [ref('invoices', before.id)], 'issuer', 'invoice.voided', ([current], { now }) => {
    own(current, project);
    matchVersion(ctx, current);
    if (ctx.env.CRM_INVOICE_VOID_ALLOWED !== 'true') fail('VOID_DISABLED', 'Voiding requires separate legal approval. Use credit notes where appropriate.', 503);
    if (current.document_state !== 'issued' || current.paid_minor || current.credited_minor) fail('CANNOT_VOID', 'Only an unpaid, uncredited issued invoice can be voided.');
    const record = nextRecord(current, { document_state: 'void', void_reason: values.reason, voided_at: now }, now);
    return { writes: [write('invoices', current.id, record)], result: invoiceView(record) };
  });
}

async function notifyInvoice(ctx, project, before, input) {
  if (Object.keys(input).length) fail('BAD_REQUEST', 'Notification uses workspace owners, not arbitrary recipients.', 400);
  const jobId = `${before.id}__notification`;
  const queued = await financeCommand(ctx, project, `invoice.${before.id}.notify`, input, [ref('invoices', before.id), ref('finance_jobs', jobId)], 'issuer', 'invoice.notification_requested', ([current, job], { now, user }) => {
    own(current, project);
    matchVersion(ctx, current);
    if (current.document_state !== 'issued') fail('ISSUED_INVOICE_REQUIRED', 'Issue the invoice before notifying owners.');
    if (job?.state === 'sending' && job.lease_until > Date.now()) fail('NOTIFICATION_PENDING', 'This notification is already being sent.');
    const record = nextRecord(current, { delivery_state: 'pending' }, now);
    return {
      writes: [write('invoices', current.id, record), write('finance_jobs', jobId, {
        id: jobId, client_id: project.client_id, project_id: project.id, invoice_id: current.id,
        actor_id: user.id, state: 'pending', attempts: job?.attempts >= 10 ? 0 : job?.attempts ?? 0,
        total_attempts: job?.total_attempts ?? job?.attempts ?? 0, created_at: job?.created_at ?? now, updated_at: now, version: (job?.version ?? 0) + 1
      })], result: record
    };
  });
  // The job is persisted before mail starts; caller retry or scheduled worker can recover failures.
  return deliverNotification(ctx, project, queued, jobId);
}

export async function deliverNotification(ctx, project, invoice, jobId = `${invoice.id}__notification`) {
  const { issuer } = await financeAccess(ctx, project.client_id);
  if (!issuer) fail('FORBIDDEN', 'An assigned SGS issuer is required.', 403);
  const lease = newId('lease');
  const claimed = await financeCommand(ctx, project, `notification.${jobId}.${lease}.claim`, { lease }, [ref('finance_jobs', jobId), ref('invoices', invoice.id)], 'issuer', 'invoice.notification_started', ([job, current], { now }) => {
    own(job, project);
    own(current, project);
    if (current.document_state !== 'issued') fail('ISSUED_INVOICE_REQUIRED', 'Only issued invoices can be sent.');
    if (job.state === 'sent') return { writes: [], result: current };
    if (job.attempts >= 10) fail('JOB_EXHAUSTED', 'Notification retry limit reached. SGS must review the delivery record before explicitly requesting another notification.');
    if (job.state === 'sending' && job.lease_until > Date.now()) fail('JOB_LEASED', 'Notification is already running.');
    const updated = nextRecord(job, { state: 'sending', lease, lease_until: Date.now() + 120000, attempts: job.attempts + 1, total_attempts: (job.total_attempts ?? job.attempts) + 1 }, now);
    return { writes: [write('finance_jobs', job.id, updated)], result: { ...current, notification_lease: lease } };
  });
  if (!claimed.notification_lease) return claimed;
  let success = false;
  try {
    const memberships = [];
    let after = null;
    do {
      const page = await queryPage('memberships', {
        where: [['client_id', '==', project.client_id], ['role', '==', 'owner'], ['status', '==', 'active']],
        documentIdOrder: true, pageSize: 50, after
      });
      for (const member of page.items) {
        const user = await getDoc('users', member.user_id);
        if (user?.status === 'active' && user.role !== 'admin') memberships.push(user);
      }
      after = page.next_cursor;
    } while (after);
    if (!memberships.length) fail('NO_CUSTOMER_OWNER', 'No active customer owner is available for notification.', 503);
    for (const owner of memberships) {
      await ctx.deps.sendEmail({
        to: owner.email, subject: 'A project invoice is available',
        text: `Sign in to your SGS AI workspace to review your invoice:\n${siteOrigin(ctx.env)}/workspace/billing/?client=${encodeURIComponent(project.client_id)}&project=${encodeURIComponent(project.id)}\n\nNo payment details are included in this message.`
      }, ctx.env);
    }
    success = true;
  } catch (error) {
    log('ERROR', 'Invoice notification failed', { request_id: ctx.requestId, invoice_id: invoice.id, code: error.code ?? 'MAIL_UNAVAILABLE' });
  }
  const final = await financeCommand(ctx, project, `notification.${jobId}.${lease}.finish`, { lease, success }, [ref('finance_jobs', jobId), ref('invoices', invoice.id)], 'issuer', 'invoice.notification_completed', ([job, current], { now }) => {
    if (job?.lease !== lease) fail('JOB_LEASE_LOST', 'The notification job lease changed.');
    const record = nextRecord(current, { delivery_state: success ? 'sent' : 'failed' }, now);
    return { writes: [write('invoices', current.id, record), write('finance_jobs', job.id, nextRecord(job, { state: success ? 'sent' : 'failed', lease_until: 0, last_error: success ? null : 'MAIL_DELIVERY_FAILED', next_attempt_at: Date.now() + 60000 }, now))], result: record };
  });
  if (!success) throw new HttpError(503, 'NOTIFICATION_FAILED', 'Invoice remains issued, but notification failed. Retry from the invoice.');
  return final;
}

async function action(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const collection = COLLECTIONS[ctx.params.kind];
  if (!collection) fail('NOT_FOUND', 'Record not found.', 404);
  const before = own(await getDoc(collection, ctx.params.id), project);
  const input = await ctx.body();
  let result;
  if (['billing-items', 'time-statements'].includes(ctx.params.kind)) result = await sourceAction(ctx, project, ctx.params.kind, before, input);
  else if (ctx.params.kind === 'payments') result = await paymentAction(ctx, project, before, input);
  else if (ctx.params.kind === 'invoices') {
    const handler = { issue: issueInvoice, void: voidInvoice, notify: notifyInvoice }[ctx.params.action];
    if (!handler) fail('NOT_FOUND', 'Unknown invoice action.', 404);
    result = await handler(ctx, project, before, input);
  } else fail('NOT_FOUND', 'Unknown finance action.', 404);
  return send(ctx, 200, result);
}

async function persistDocument(ctx, project, record, collection) {
  const stored = await getDoc('finance_documents', record.id);
  if (stored) {
    own(stored, project);
    await financeAccess(ctx, project.client_id);
    return stored;
  }
  const snapshot = collection === 'invoices' ? record : {
    ...record, document_title: 'CREDIT NOTE', original_number: record.invoice_number,
    issue_date: record.invoice_date, due_date: 'Not applicable', lines: [{ description: record.reason, amount_minor: record.net_minor }]
  };
  const pdf = await renderInvoicePdf(snapshot);
  if (pdf.buffer.length > 600000) fail('DOCUMENT_TOO_LARGE', 'Document exceeds private archive capacity. Contact SGS support; its issued financial record is retained.', 503);
  return commitFinance(ctx, project, [ref(collection, record.id), ref('finance_documents', record.id)], 'owner', 'document.archived', ([current, existing], { now }) => {
    own(current, project);
    if (existing) return { replayed: true, writes: [], result: own(existing, project) };
    if (collection === 'invoices' && !['issued', 'void'].includes(current.document_state)) fail('DOCUMENT_UNAVAILABLE', 'Only issued invoices have an original tax document.');
    const document = {
      id: record.id, client_id: project.client_id, project_id: project.id, version: 1, renderer_version: 1, created_at: now,
      filename: `${record.number.replaceAll('/', '-')}.pdf`, content_type: 'application/pdf', content_base64: pdf.buffer.toString('base64'), checksum: pdf.checksum
    };
    return { writes: [write('finance_documents', record.id, document)], result: document };
  });
}
async function document(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const invoice = own(await getDoc('invoices', ctx.params.id), project);
  if (!['issued', 'void'].includes(invoice.document_state)) fail('DOCUMENT_UNAVAILABLE', 'Only issued invoices have a tax document. Voided documents remain available as historical originals.');
  return send(ctx, 200, { ...await persistDocument(ctx, project, invoice, 'invoices'), document_state: invoice.document_state });
}
async function creditDocument(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const credit = own(await getDoc('credit_notes', ctx.params.id), project);
  return send(ctx, 200, await persistDocument(ctx, project, credit, 'credit_notes'));
}
async function summary(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const [plan, invoiceRecords, payments, credits, refunds, resources] = await Promise.all([
    getDoc('billing_plans', basePlanId(project)), allProjectRecords('invoices', project), allProjectRecords('payments', project),
    allProjectRecords('credit_notes', project), allProjectRecords('refunds', project), allProjectRecords('crm_resources', project)
  ]);
  const invoices = invoiceRecords.filter((invoice) => invoice.document_state === 'issued').map(invoiceView);
  const sum = (records, field) => records.reduce((total, record) => total + (record[field] ?? 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const atRisk = resources.filter((resource) => {
    const days = Math.max(0, (Date.parse(resource.end_date) - Date.parse(resource.start_date)) / 86400000 + 1);
    return resource.planned_minutes > Math.floor(days / 7 * resource.weekly_capacity_minutes) || resource.end_date < today;
  });
  const aging = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 };
  for (const invoice of invoices) {
    const days = Math.floor((Date.parse(today) - Date.parse(invoice.due_date)) / 86400000);
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'days_1_30' : days <= 60 ? 'days_31_60' : days <= 90 ? 'days_61_90' : 'days_90_plus';
    aging[bucket] += invoice.outstanding_minor;
  }
  return send(ctx, 200, {
    currency: 'INR', contract_minor: plan?.amount_minor ?? 0, invoiced_minor: sum(invoices, 'total_minor'),
    credited_minor: sum(credits, 'total_minor'), paid_minor: sum(invoices, 'paid_minor'),
    outstanding_minor: sum(invoices, 'outstanding_minor'), unallocated_minor: sum(payments.filter((payment) => payment.status === 'confirmed'), 'unallocated_minor'),
    refunded_minor: sum(refunds, 'amount_minor'), overdue_minor: sum(invoices.filter((invoice) => invoice.overdue), 'outstanding_minor'),
    at_risk_resources: atRisk, aging,
    invoice_issuance_enabled: ctx.env.CRM_INVOICE_ISSUANCE_ENABLED === 'true'
  });
}

export const financeRoutes = [
  ['GET', '/api/v1/projects/:project_id/finance/profile', getProfile],
  ['PUT', '/api/v1/projects/:project_id/finance/profile', putProfile],
  ['GET', '/api/v1/projects/:project_id/finance/summary', summary],
  ['GET', '/api/v1/projects/:project_id/finance/monthly-candidates', monthlyCandidates],
  ['GET', '/api/v1/projects/:project_id/finance/invoices/:id/document', document],
  ['GET', '/api/v1/projects/:project_id/finance/credit-notes/:id/document', creditDocument],
  ['GET', '/api/v1/projects/:project_id/finance/:kind', list],
  ['POST', '/api/v1/projects/:project_id/finance/:kind', create],
  ['GET', '/api/v1/projects/:project_id/finance/:kind/:id', detail],
  ['PATCH', '/api/v1/projects/:project_id/finance/:kind/:id', edit],
  ['POST', '/api/v1/projects/:project_id/finance/:kind/:id/:action', action]
];

export function createFinanceWorkerRoutes({ env, verifyServiceIdentity } = {}) {
  return [['POST', '/api/v1/crm/finance-worker/retry', async (ctx) => {
    await verifyCrmWorker(ctx, { env, verifyServiceIdentity });
    const input = await ctx.body();
    const check = new Checker(input);
    exactFields(check, ['project_id', 'cursor']);
    check.text('project_id', { required: true, min: 1, max: 160 });
    check.text('cursor', { max: 160 });
    const values = check.done();
    const project = await getDoc('projects', values.project_id);
    if (!project || project.deleted_at) fail('NOT_FOUND', 'Project not found.', 404);
    const page = await queryPage('finance_jobs', {
      where: [['client_id', '==', project.client_id], ['project_id', '==', project.id]],
      after: values.cursor || null, pageSize: 10
    });
    const results = [];
    for (const job of page.items) {
      if (job.state === 'sent' || job.attempts >= 10 || (job.state === 'sending' && job.lease_until > Date.now()) || (job.state === 'failed' && job.next_attempt_at > Date.now())) continue;
      try {
        const user = await getDoc('users', job.actor_id);
        const workerCtx = {
          ...ctx, auth: async () => ({ user }),
          request: { ...ctx.request, headers: { ...ctx.request.headers, 'idempotency-key': newId('worker') } }
        };
        if (!user || user.status !== 'active') fail('ACTOR_REVOKED', 'The requesting account is no longer active.', 403);
        const invoice = own(await getDoc('invoices', job.invoice_id), project);
        const record = await deliverNotification(workerCtx, project, invoice, job.id);
        results.push({ id: job.id, state: record.delivery_state });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        log('WARNING', 'Finance worker job failed', { request_id: ctx.requestId, job_id: job.id, code: error.code });
        results.push({ id: job.id, state: 'failed', error: error.code });
      }
    }
    return send(ctx, 200, { results, next_cursor: page.next_cursor });
  }]];
}
