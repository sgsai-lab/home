import { HttpError } from './http.mjs';
import { queryPage } from './db.mjs';
import { sha256 } from './security.mjs';
import { commitFinance, ref, write } from './crm.mjs';

export const MAX_MONEY = 1_000_000_000_000;
export const COLLECTIONS = {
  resources: 'crm_resources', 'billing-items': 'billing_items', 'time-entries': 'time_entries',
  'time-statements': 'time_statements', invoices: 'invoices', payments: 'payments',
  'credit-notes': 'credit_notes', refunds: 'refunds'
};
export const fail = (code, message, status = 409) => { throw new HttpError(status, code, message); };
export const versionOf = (record) => `"v${record?.version ?? 0}"`;
export function matchVersion(ctx, record) {
  const value = ctx.request.headers['if-match'];
  if (!value) fail('PRECONDITION_REQUIRED', 'Send the current If-Match record version.', 428);
  if (value !== versionOf(record)) fail('PRECONDITION_FAILED', 'The record changed. Reload it before continuing.', 412);
}
export function own(record, project) {
  if (!record || record.client_id !== project.client_id || record.project_id !== project.id) fail('NOT_FOUND', 'Record not found.', 404);
  return record;
}
export function exactFields(check, allowed) {
  for (const key of Object.keys(check.input)) if (!allowed.includes(key)) check.fail(key, 'This field cannot be set here.');
}
export function moneyField(check, key, required = true) {
  const value = check.integer(key, { min: 1, max: MAX_MONEY });
  if (required && !check.has(key)) check.fail(key, 'This field is required.');
  return value;
}
export function dateField(check, key, required = true) {
  const value = check.date(key);
  if (!value && required) check.fail(key, 'A date is required.');
  if (value && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) check.fail(key, 'Enter a real calendar date.');
  return value;
}
export function idsField(check, key) {
  const value = check.input[key];
  if (!Array.isArray(value) || !value.length || value.length > 20 || value.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) || new Set(value).size !== value.length) {
    check.fail(key, 'Choose 1 to 20 distinct records.');
    return [];
  }
  return value;
}
export function roundedRatio(numerator, denominator) {
  const value = (BigInt(numerator) + BigInt(denominator) / 2n) / BigInt(denominator);
  if (value < 0n || value > BigInt(MAX_MONEY)) fail('AMOUNT_RANGE', 'Calculated amount is outside the supported range.', 400);
  return Number(value);
}
export const hourlyAmount = (minutes, rate) => roundedRatio(BigInt(minutes) * BigInt(rate), 60);
export function totals(lines, profile) {
  const net = lines.reduce((sum, line) => sum + line.amount_minor, 0);
  if (!Number.isSafeInteger(net) || net < 1 || net > MAX_MONEY) fail('AMOUNT_RANGE', 'Invoice amount is outside the supported range.', 400);
  const tax = roundedRatio(BigInt(net) * BigInt(profile?.gst_rate_bps ?? 0), 10000);
  const intra = profile?.issuer_state_code === profile?.customer_state_code;
  const cgst = intra ? Math.floor(tax / 2) : 0;
  return { net_minor: net, tax_minor: tax, total_minor: net + tax, tax_components: { cgst_minor: cgst, sgst_minor: intra ? tax - cgst : 0, igst_minor: intra ? 0 : tax } };
}
export function invoiceView(invoice) {
  if (!invoice) return invoice;
  const outstanding = invoice.document_state === 'void' ? 0 : Math.max(0, invoice.total_minor - (invoice.paid_minor ?? 0) - (invoice.credited_minor ?? 0));
  return {
    ...invoice, outstanding_minor: outstanding,
    settlement_state: outstanding === 0 ? 'paid' : invoice.paid_minor ? 'partially_paid' : 'unpaid',
    overdue: invoice.document_state === 'issued' && outstanding > 0 && invoice.due_date < new Date().toISOString().slice(0, 10)
  };
}
export function requirePlan(plan, project, method) {
  own(plan, project);
  if (plan.status !== 'active') fail('PLAN_REQUIRED', 'Activate an accepted billing plan first.');
  if (method && plan.billing_method !== method) fail('BILLING_METHOD', `This action requires a ${method} billing plan.`);
}
export function requireIssuance(ctx, profile) {
  if (ctx.env.CRM_INVOICE_ISSUANCE_ENABLED !== 'true') fail('ISSUANCE_DISABLED', 'Invoice issuance is disabled. Configure and approve legal/tax requirements before enabling it.', 503);
  if (!profile?.legal_approved || !profile.legal_approval_reference) fail('LEGAL_CONFIGURATION_REQUIRED', 'An approved legal billing profile is required.', 503);
}

/** Replays are still authorized; command identity is tenant/actor/operation scoped. */
export async function financeCommand(ctx, project, operation, input, refs, mode, action, mutate) {
  const { user } = await ctx.auth();
  const key = ctx.request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(key)) fail('IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key.', 400);
  const commandId = sha256(`${user.id}:${project.id}:${operation}:${key}`);
  const hash = sha256(JSON.stringify(input));
  return commitFinance(ctx, project, [...refs, ref('idempotency_records', commandId)], mode, action, (docs, context) => {
    const replay = docs.at(-1);
    if (replay) {
      if (replay.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'This command key was already used with different input.');
      return { replayed: true, writes: [], result: replay.result };
    }
    const outcome = mutate(docs.slice(0, -1), context);
    outcome.writes.push(write('idempotency_records', commandId, {
      id: commandId, client_id: project.client_id, project_id: project.id, actor_id: user.id,
      request_hash: hash, result: outcome.result, created_at: context.now
    }));
    return outcome;
  });
}

export async function allProjectRecords(collection, project) {
  const records = [];
  let after = null;
  do {
    const page = await queryPage(collection, { where: [['client_id', '==', project.client_id], ['project_id', '==', project.id]], pageSize: 50, after });
    records.push(...page.items);
    after = page.next_cursor;
  } while (after);
  return records;
}
