import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../public/assets/js/crm-billing.js', import.meta.url), 'utf8');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Keep these regressions dependency-free; browser integration is checked separately.
function harness(api) {
  const elements = new Map();
  const lifecycle = new Map();
  const element = (id) => ({
    id, textContent: 'private value', hidden: false, children: [],
    addEventListener() {},
    reset() { this.wasReset = true; },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.textContent = ''; this.children = []; },
    replaceWith(next) { elements.set(id, next); }
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    }
  };
  const context = {
    api, ApiError, document, URL, URLSearchParams, crypto: { randomUUID },
    location: { search: '?client=client&project=project' },
    window: { addEventListener: (name, callback) => lifecycle.set(name, callback) },
    h: (_tag, props) => ({ ...element(props.id), textContent: props.text ?? '' }),
    describeError: (error) => error.message,
    showStatus: (target, message) => { target.textContent = message; },
    setTimeout
  };
  vm.runInNewContext(`${source.replace(/^import[^\n]+\n/, '')}
    globalThis.billing = { minor, money, valuesFrom, request, write, clearPrivateView, renderActions, allRecords, state };
  `, context);
  return { ...context, elements, lifecycle };
}

test('billing uses exact INR decimal conversion and rejects invalid or out-of-range amounts', () => {
  const { billing } = harness(async () => ({}));
  assert.equal(billing.minor('0.01'), 1);
  assert.equal(billing.minor('1234567890.12'), 123456789012);
  assert.equal(billing.minor('10000000000.00'), 1_000_000_000_000);
  // Grouping follows the runtime's ICU data (small-ICU builds group en-IN differently).
  assert.equal(billing.money(123456789012), `₹${new Intl.NumberFormat('en-IN').format(1234567890n)}.12`);
  assert.equal(billing.money(1), '₹0.01');
  assert.equal(billing.money(-1050), '−₹10.50');
  for (const value of ['0', '-1', '1.001', '1,000.00', '1e3', '10000000000.01']) {
    assert.throws(() => billing.minor(value), { code: 'VALIDATION' });
  }
});

test('billing requests bypass caches and command retries reuse keys with version preconditions', async () => {
  const calls = [];
  let shouldFail = true;
  const { billing } = harness(async (path, options) => {
    calls.push({ path, options });
    if (shouldFail) {
      shouldFail = false;
      throw new ApiError(503, 'UNAVAILABLE', 'Retry');
    }
    return { id: 'payment' };
  });
  const body = { invoice_id: 'invoice', amount_minor: 101 };
  const record = { version: 3 };
  await assert.rejects(billing.write('/payments/p/allocate', 'POST', body, record), { status: 503 });
  await billing.write('/payments/p/allocate', 'POST', body, record);
  const first = calls[0].options;
  const second = calls[1].options;
  assert.equal(first.cache, 'no-store');
  assert.equal(first.headers['Cache-Control'], 'no-store, no-cache');
  assert.equal(first.headers['If-Match'], '"v3"');
  assert.match(first.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
  assert.equal(first.headers['Idempotency-Key'], second.headers['Idempotency-Key']);
  await billing.write('/profile', 'PUT', {}, { version: 0 });
  assert.equal(calls[2].options.headers['If-Match'], '"v0"');
  assert.ok(calls[2].options.headers['Idempotency-Key']);
  await billing.write('/resources/r', 'PATCH', {}, { version: 2 });
  assert.ok(calls[3].options.headers['Idempotency-Key']);
});

for (const status of [401, 403, 404]) {
  test(`billing clears rendered financial data and forms on ${status}`, async () => {
    const app = harness(async () => { throw new ApiError(status, 'DENIED', 'Denied'); });
    app.billing.state.capabilities = { can_prepare: true };
    app.billing.state.selected = { id: 'private-record' };
    await assert.rejects(app.billing.request('/summary'), { status });
    for (const id of ['finance-summary', 'finance-aging', 'records-body', 'detail-fields', 'editor-body', 'profile-fields']) {
      assert.equal(app.document.getElementById(id).textContent, '', id);
    }
    assert.equal(app.document.getElementById('billing-content').hidden, true);
    assert.equal(app.document.getElementById('record-filter').wasReset, true);
    assert.equal(app.billing.state.capabilities, null);
    assert.equal(app.billing.state.selected, null);
  });
}

test('pagehide clears immediately and pending requests cannot return data into a fresh lifecycle', async () => {
  let resolve;
  const app = harness(() => new Promise((done) => { resolve = done; }));
  const pending = app.billing.request('/invoices');
  assert.equal(typeof app.lifecycle.get('pageshow'), 'function');
  app.lifecycle.get('pagehide')();
  resolve({ items: [{ id: 'private-invoice' }] });
  await assert.rejects(pending, { code: 'STALE_VIEW' });
  assert.equal(app.document.getElementById('editor-body').textContent, '');
  assert.equal(app.document.getElementById('billing-content').hidden, true);
});

test('only issuers can cancel unbilled items; cancelled items cannot be accepted', () => {
  const app = harness(async () => ({}));
  const labels = () => app.document.getElementById('record-actions').children.map((child) => child.textContent);
  app.billing.state.capabilities = { can_prepare: true, can_accept: false };
  app.billing.renderActions('billing-items', { id: 'item', version: 1 });
  assert.deepEqual(labels(), ['Cancel billing item']);
  app.billing.renderActions('billing-items', { id: 'item', version: 2, status: 'cancelled' });
  assert.deepEqual(labels(), []);
  app.billing.renderActions('billing-items', { id: 'item', version: 2, billed_invoice_id: 'invoice' });
  assert.deepEqual(labels(), []);
  app.billing.state.capabilities = { can_prepare: false, can_accept: true };
  app.billing.renderActions('billing-items', { id: 'item', version: 1, requires_acceptance: true });
  assert.deepEqual(labels(), ['Accept billing item']);
  app.billing.renderActions('billing-items', { id: 'item', version: 2, requires_acceptance: true, status: 'cancelled' });
  assert.deepEqual(labels(), []);
});

test('issued and void invoices offer PDF download; void is labelled prominently', () => {
  const app = harness(async () => ({}));
  const labels = () => app.document.getElementById('record-actions').children.map((child) => child.textContent);
  app.billing.state.capabilities = { can_prepare: false, can_accept: true };
  app.billing.renderActions('invoices', { id: 'i', version: 3, document_state: 'void', void_reason: 'Duplicate' });
  assert.deepEqual(labels(), ['VOID INVOICE — not payable. Reason: Duplicate', 'Download original PDF (VOID invoice)']);
  app.billing.renderActions('invoices', { id: 'i', version: 2, document_state: 'issued' });
  assert.deepEqual(labels(), ['Download invoice PDF']);
  app.billing.renderActions('invoices', { id: 'i', version: 1, document_state: 'draft' });
  assert.deepEqual(labels(), []);
});

test('form record pickers respect the finance page_size limit and follow every cursor', async () => {
  const requested = [];
  const pages = { '': { items: [{ id: 'i1' }], next_cursor: 'c1' }, c1: { items: [{ id: 'i2' }], next_cursor: 'c2' }, c2: { items: [{ id: 'i3' }], next_cursor: null } };
  const app = harness(async (path) => {
    const query = new URL(path, 'https://example.test').searchParams;
    const size = Number(query.get('page_size'));
    requested.push(size);
    // Mirrors queryPage(): the server rejects page sizes outside 1-50.
    if (!Number.isInteger(size) || size < 1 || size > 50) throw new ApiError(400, 'BAD_REQUEST', 'Use a page_size from 1 to 50.');
    return pages[query.get('cursor') ?? ''];
  });
  const items = await app.billing.allRecords('invoices');
  assert.deepEqual(Array.from(items, (item) => item.id), ['i1', 'i2', 'i3']);
  assert.deepEqual(requested, [50, 50, 50]);
});

test('every finance list request in the billing UI stays within the API page_size limit', () => {
  const sizes = [...source.matchAll(/page_size: '(\d+)'/g)].map((match) => Number(match[1]));
  assert.ok(sizes.length >= 3);
  for (const size of sizes) assert.ok(size >= 1 && size <= 50, `page_size ${size}`);
});
