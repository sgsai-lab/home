import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/assets/js/reports.js', import.meta.url), 'utf8');
function harness(api) {
  const elements = new Map();
  const events = new Map();
  const revoked = [];
  const node = () => ({
    textContent: 'Private data', hidden: false, disabled: false, children: [], elements: [],
    addEventListener() {},
    replaceChildren(...children) { this.children = children; this.textContent = ''; }
  });
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  } };
  const context = {
    api, document, URLSearchParams, BigInt, Blob, setTimeout, console,
    URL: { revokeObjectURL: (url) => revoked.push(url) },
    location: { search: '', pathname: '/workspace/reports/', hash: '' },
    history: { replaceState() {} },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    h: () => node(), setupTabs() {}, requireUser: async () => ({}), PROJECT_STATUS: {},
    showStatus: (target, text) => { target.textContent = text; },
    describeError: (error) => error.message
  };
  vm.runInNewContext(`${source.replace(/^import[^\n]+\n/gm, '').replace(/^main\(\)\.catch[^\n]+$/m, '')}
    globalThis.reports = { state, urls, money, clearPrivateView, loadReport, exportReport };`, context);
  return { ...context, events, revoked };
}

test('reports clear private rows, selectors and download URLs on pagehide', () => {
  const app = harness(async () => ({}));
  app.reports.state.data = { private: true };
  app.reports.urls.add('blob:private');
  app.events.get('pagehide')();
  assert.equal(app.reports.state.data, null);
  assert.equal(app.document.getElementById('report-content').hidden, true);
  assert.equal(app.document.getElementById('projects-table').textContent, '');
  assert.equal(app.document.getElementById('report-client').textContent, '');
  assert.equal(app.document.getElementById('export-report').disabled, true);
  assert.deepEqual(app.revoked, ['blob:private']);
});

test('reports discard stale responses and use no-store requests', async () => {
  let finish;
  let options;
  const app = harness(async (_path, requestOptions) => {
    options = requestOptions;
    return new Promise((resolve) => { finish = resolve; });
  });
  const pending = app.reports.loadReport(new URLSearchParams());
  app.reports.clearPrivateView();
  finish({ private: true });
  await pending;
  assert.equal(options.cache, 'no-store');
  assert.equal(app.reports.state.data, null);
  assert.equal(app.document.getElementById('report-content').hidden, true);
});

test('report export reauthorizes applied filters and discards a download after access is lost', async () => {
  let finish;
  let requested;
  const app = harness((path) => {
    requested = path;
    return new Promise((resolve) => { finish = resolve; });
  });
  app.reports.state.data = {};
  app.reports.state.query = new URLSearchParams('client_id=one&from=2026-02-01&to=2026-02-28');
  app.reports.state.section = 'payables';
  const pending = app.reports.exportReport();
  app.reports.clearPrivateView();
  finish({ content_type: 'text/csv', content: 'Private data' });
  await pending;
  assert.match(requested, /client_id=one/);
  assert.match(requested, /section=payables/);
  assert.equal(app.reports.state.data, null);
  assert.equal(app.document.getElementById('export-report').disabled, true);
});

test('authorization errors clear report choices and surface the error', async () => {
  const app = harness(async () => { throw Object.assign(new Error('Owner access revoked'), { status: 403 }); });
  await app.reports.loadReport(new URLSearchParams());
  assert.equal(app.document.getElementById('report-client').textContent, '');
  assert.equal(app.document.getElementById('page-status').textContent, 'Owner access revoked');
});
