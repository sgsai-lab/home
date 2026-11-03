import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { getDoc, queryDocs, resetInMemoryDb, setDoc, setFirestoreDisabled } from '../src/server/db.mjs';
import { createGithubCrmRoutes } from '../src/server/routes/github-crm.mjs';
import { account, call, start } from './helpers.mjs';

setFirestoreDisabled(true);

function fakeAdapter({ configured = true, installation = { id: 17, account: 'acme' } } = {}) {
  const calls = [];
  return {
    configured,
    calls,
    async verifyRepository(repository) {
      calls.push(['verifyRepository', repository]);
      return { id: 123, full_name: repository, installation_id: installation.id, organization: installation.account };
    },
    async resolveProject(organization, number) {
      calls.push(['resolveProject', organization, number]);
      return { id: 'PVT_1', title: 'Acme', url: `https://github.com/orgs/${organization}/projects/${number}` };
    },
    async readProject(binding) {
      calls.push(['readProject', binding.project_v2_id]);
      return {
        items: [
          { id: 'I_1', type: 'issue', number: 8, title: 'Bug', state: 'OPEN', url: 'https://github.com/acme/widget/issues/8', status: 'Todo', iteration: 'Sprint 4' },
          { id: 'P_2', type: 'pull_request', number: 9, title: 'Fix', state: 'MERGED', url: 'https://github.com/acme/widget/pull/9', status: 'Done', iteration: null }
        ],
        iterations: [{ id: 'iteration-4', title: 'Sprint 4', start_date: '2026-10-01', duration: 14 }]
      };
    },
    async executeCommand(binding, command) {
      calls.push(['executeCommand', command.type]);
      return { external_id: command.type === 'issue.create' ? '42' : 'I_1', url: 'https://github.com/acme/widget/issues/42' };
    },
    async verifyWebhook() { return true; },
    async reconcile() { return { processed: 0 }; }
  };
}

function context({ user, projectId = 'project-a', body = {}, headers = {}, query = new URLSearchParams(), limit = () => true } = {}) {
  const response = {};
  return {
    params: { project_id: projectId, command_id: body.command_id },
    query,
    request: { headers, method: 'POST' },
    requestId: 'test-request',
    body: async () => body,
    auth: async () => ({ user }),
    limit(name, key) {
      if (!limit(name, key)) {
        const error = new Error('Rate limited');
        error.status = 429;
        throw error;
      }
    },
    send(status, data, responseHeaders = {}) {
      Object.assign(response, { status, data, headers: responseHeaders });
      return response;
    }
  };
}

async function fixture() {
  resetInMemoryDb();
  const owner = { id: 'owner-a', role: 'user', status: 'active' };
  await setDoc('clients', 'client-a', { id: 'client-a' });
  await setDoc('memberships', 'client-a__owner-a', { client_id: 'client-a', user_id: owner.id, role: 'owner', status: 'active' });
  await setDoc('users', owner.id, owner);
  await setDoc('projects', 'project-a', { id: 'project-a', client_id: 'client-a', name: 'A', deleted_at: null });
  return { owner, issuer: { id: 'issuer-a', role: 'admin', status: 'active' } };
}

async function installIssuer(issuer) {
  await setDoc('users', issuer.id, issuer);
  await setDoc('issuer_operators', issuer.id, { id: issuer.id, active: true });
  await setDoc('memberships', `client-a__${issuer.id}`, { client_id: 'client-a', user_id: issuer.id, role: 'owner', status: 'active' });
}

function routeSet(options = {}) {
  return createGithubCrmRoutes({ env: {}, ...options });
}

function findRoute(routes, method, suffix) {
  return routes.find(([candidate, path]) => candidate === method && path.endsWith(suffix))[2];
}

test('GitHub CRM scopes project access to its actual owner and issuer, never global admin bypass', async () => {
  const { owner, issuer } = await fixture();
  const routes = routeSet({ adapter: fakeAdapter() });
  const view = findRoute(routes, 'GET', '/github-crm');
  await assert.rejects(view(context({ user: { id: 'outsider', role: 'admin', status: 'active' } })), { status: 404 });
  const ownerView = await view(context({ user: owner }));
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.data.configured, true);
  await assert.rejects(findRoute(routes, 'PUT', '/binding')(context({
    user: owner,
    body: { repository_url: 'https://github.com/acme/widget', project_url: 'https://github.com/orgs/acme/projects/4' }
  })), { status: 403 });
  await installIssuer(issuer);
  const issuerCannotBypassMembership = await setDoc('memberships', `client-a__${issuer.id}`, {
    client_id: 'client-a', user_id: issuer.id, role: 'member', status: 'active'
  });
  assert.ok(issuerCannotBypassMembership);
  await assert.rejects(findRoute(routes, 'PUT', '/binding')(context({
    user: issuer,
    body: { repository_url: 'https://github.com/acme/widget', project_url: 'https://github.com/orgs/acme/projects/4' }
  })), { status: 403 });
});

test('unconfigured GitHub credentials are explicit and never simulated', async () => {
  const { owner } = await fixture();
  const routes = routeSet();
  await assert.rejects(findRoute(routes, 'GET', '/github-crm')(context({ user: owner })), { status: 503 });
});

test('GitHub App permission failures surface as unavailable without saving a binding', async () => {
  const { issuer } = await fixture();
  await installIssuer(issuer);
  const adapter = fakeAdapter();
  adapter.verifyRepository = async () => { throw Object.assign(new Error('permission denied'), { status: 403 }); };
  const routes = routeSet({ adapter });
  await assert.rejects(findRoute(routes, 'PUT', '/binding')(context({
    user: issuer,
    body: { repository_url: 'https://github.com/acme/widget', project_url: 'https://github.com/orgs/acme/projects/4' }
  })), { status: 503 });
  assert.equal(await getDoc('github_project_bindings', 'project-a'), null);
});

test('binding accepts exact GitHub repository and organization Project v2 links only after installation verification', async () => {
  const { owner, issuer } = await fixture();
  await installIssuer(issuer);
  const adapter = fakeAdapter();
  const routes = routeSet({ adapter });
  const bind = findRoute(routes, 'PUT', '/binding');
  await assert.rejects(bind(context({
    user: issuer,
    body: { repository_url: 'https://evil.example/acme/widget', project_url: 'https://github.com/orgs/acme/projects/4' }
  })), { status: 400 });
  await assert.rejects(bind(context({
    user: issuer,
    body: { repository_url: 'https://github.com/acme/widget', project_url: 'https://github.com/orgs/another/projects/4' }
  })), { status: 400 });
  assert.equal(adapter.calls.length, 0, 'untrusted or mismatched links are rejected before GitHub API calls');
  const result = await bind(context({
    user: issuer,
    body: { repository_url: 'https://github.com/acme/widget', project_url: 'https://github.com/orgs/acme/projects/4' }
  }));
  assert.equal(result.status, 200);
  assert.equal(result.data.binding.repository, 'acme/widget');
  assert.equal(result.data.binding.project_v2_number, 4);
  assert.equal(adapter.calls[0][0], 'verifyRepository');
  assert.equal((await getDoc('github_project_bindings', 'project-a')).project_id, 'project-a');
  assert.equal(owner.id, 'owner-a');
});

test('commands are durable and idempotent and ambiguous adapter failures require reconciliation', async () => {
  const { issuer } = await fixture();
  await installIssuer(issuer);
  const adapter = fakeAdapter();
  const routes = routeSet({ adapter });
  await findRoute(routes, 'PUT', '/binding')(context({
    user: issuer,
    body: { repository_url: 'https://github.com/acme/widget', project_url: 'https://github.com/orgs/acme/projects/4' }
  }));
  const command = findRoute(routes, 'POST', '/commands');
  const input = { type: 'issue.create', title: 'First issue', body: 'Details' };
  const first = await command(context({ user: issuer, body: input, headers: { 'idempotency-key': 'create-1' } }));
  assert.equal(first.status, 202);
  assert.equal(first.data.status, 'completed');
  const replay = await command(context({ user: issuer, body: input, headers: { 'idempotency-key': 'create-1' } }));
  assert.equal(replay.data.id, first.data.id);
  assert.equal(adapter.calls.filter(([name]) => name === 'executeCommand').length, 1);
  assert.equal((await getDoc('github_crm_commands', first.data.id)).status, 'completed');

  const statusCommand = await command(context({
    user: issuer,
    body: { type: 'issue.status', item_id: 'PVTITEM_1', field_id: 'PVTSSF_1', option_id: 'option_done' },
    headers: { 'idempotency-key': 'status-1' }
  }));
  const iterationCommand = await command(context({
    user: issuer,
    body: { type: 'issue.iteration', item_id: 'PVTITEM_1', field_id: 'PVTIF_1', iteration_id: 'iteration-4' },
    headers: { 'idempotency-key': 'iteration-1' }
  }));
  assert.equal(statusCommand.data.status, 'completed');
  assert.equal(iterationCommand.data.status, 'completed');

  adapter.executeCommand = async () => { throw Object.assign(new Error('connection lost'), { ambiguous: true }); };
  const uncertain = await command(context({
    user: issuer, body: { type: 'issue.create', title: 'Maybe created', body: '' }, headers: { 'idempotency-key': 'create-2' }
  }));
  assert.equal(uncertain.data.status, 'reconciliation_required');
  assert.ok(uncertain.data.error_code);
  adapter.executeCommand = async () => ({ external_id: '43', url: 'https://github.com/acme/widget/issues/43' });
  const retried = await findRoute(routes, 'POST', '/retry')(context({
    user: issuer,
    projectId: 'project-a',
    body: { command_id: uncertain.data.id }
  }));
  assert.equal(retried.data.status, 'completed');
  assert.equal(retried.data.external_id, '43');
});

test('webhook signatures are verified before durable deduplication', async () => {
  const adapter = fakeAdapter();
  const routes = routeSet({ adapter, env: { GITHUB_WEBHOOK_SECRET: 'test-secret' } });
  const webhook = findRoute(routes, 'POST', '/webhooks');
  const body = '{"action":"opened"}';
  const signature = (payload) => `sha256=${createHmac('sha256', 'test-secret').update(payload).digest('hex')}`;
  const makeRequest = (value, signed = true) => ({
    headers: { 'x-hub-signature-256': signed ? signature(value) : `sha256=${'a'.repeat(64)}`, 'x-github-delivery': 'delivery-1', 'x-github-event': 'issues' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(value); }
  });
  await assert.rejects(webhook({ request: makeRequest(body, false), send() {} }), { status: 401 });
  const accepted = await webhook({ request: makeRequest(body), send(status, data) { return { status, data }; } });
  assert.equal(accepted.status, 202);
  const duplicate = await webhook({ request: makeRequest(body), send(status, data) { return { status, data }; } });
  assert.equal(duplicate.data.duplicate, true);
});

test('rate failures and revoked actual-owner/issuer authority prevent mutations', async () => {
  const { issuer } = await fixture();
  await installIssuer(issuer);
  const routes = routeSet({ adapter: fakeAdapter() });
  await findRoute(routes, 'PUT', '/binding')(context({
    user: issuer,
    body: { repository_url: 'https://github.com/acme/widget', project_url: 'https://github.com/orgs/acme/projects/4' }
  }));
  const command = findRoute(routes, 'POST', '/commands');
  await assert.rejects(command(context({ user: issuer, limit: () => false, body: { type: 'issue.create', title: 'No', body: '' }, headers: { 'idempotency-key': 'rate-1' } })), { status: 429 });
  assert.equal((await queryDocs('github_crm_commands')).length, 0);
  await setDoc('issuer_operators', issuer.id, { id: issuer.id, active: false });
  await assert.rejects(command(context({ user: issuer, body: { type: 'issue.create', title: 'No', body: '' }, headers: { 'idempotency-key': 'revoked-1' } })), { status: 403 });
  assert.equal((await queryDocs('github_crm_commands')).length, 0);
  await setDoc('issuer_operators', issuer.id, { id: issuer.id, active: true });
  await setDoc('memberships', `client-a__${issuer.id}`, {
    client_id: 'client-a', user_id: issuer.id, role: 'owner', status: 'inactive'
  });
  await assert.rejects(command(context({ user: issuer, body: { type: 'issue.create', title: 'No', body: '' }, headers: { 'idempotency-key': 'owner-revoked' } })), { status: 404 });
  assert.equal((await queryDocs('github_crm_commands')).length, 0);
});

test('worker reconcile fails closed without verified service identity', async () => {
  const routes = routeSet({ adapter: fakeAdapter(), env: {} });
  const worker = findRoute(routes, 'POST', '/worker/reconcile');
  await assert.rejects(worker(context({ headers: { authorization: 'Bearer untrusted' } })), { status: 503 });
});

test('worker accepts only an injected verified OIDC identity and stays project-scoped', async () => {
  const { issuer } = await fixture();
  await installIssuer(issuer);
  const adapter = fakeAdapter();
  const env = {
    GITHUB_CRM_WORKER_AUDIENCE: 'https://api.example.test/api/v1/github-crm/worker/reconcile',
    GITHUB_CRM_WORKER_SERVICE_ACCOUNT: 'crm-worker@example.iam.gserviceaccount.com'
  };
  const routes = routeSet({
    adapter,
    env,
    verifyServiceIdentity: async (token, audience) => {
      assert.equal(token, 'verified-token');
      assert.equal(audience, env.GITHUB_CRM_WORKER_AUDIENCE);
      return { email: env.GITHUB_CRM_WORKER_SERVICE_ACCOUNT, email_verified: true };
    }
  });
  await findRoute(routes, 'PUT', '/binding')(context({
    user: issuer,
    body: { repository_url: 'https://github.com/acme/widget', project_url: 'https://github.com/orgs/acme/projects/4' }
  }));
  const result = await findRoute(routes, 'POST', '/worker/reconcile')(context({
    body: { project_id: 'project-a' },
    headers: { authorization: 'Bearer verified-token' }
  }));
  assert.equal(result.status, 200);
  assert.equal(result.data.project_id, 'project-a');
  assert.equal(result.data.processed_webhooks, 0);
});

test('HTTP smoke: parent handler forwards adapter and OIDC verifier, and defaults fail explicitly', async (t) => {
  const adapter = fakeAdapter();
  let verifierCalls = 0;
  const { baseUrl } = await start(t, {
    githubAdapter: adapter,
    env: {
      GITHUB_CRM_WORKER_AUDIENCE: 'https://api.test/github-worker',
      GITHUB_CRM_WORKER_SERVICE_ACCOUNT: 'github-worker@example.iam.gserviceaccount.com'
    },
    verifyGithubWorkerIdentity: async (token, audience) => {
      verifierCalls += 1;
      assert.equal(token, 'service-token');
      assert.equal(audience, 'https://api.test/github-worker');
      return { email: 'github-worker@example.iam.gserviceaccount.com', email_verified: true };
    }
  });
  const issuer = await account(baseUrl, 'github-issuer@sgs.test', { role: 'admin' });
  await setDoc('clients', 'client-http', { id: 'client-http' });
  await setDoc('memberships', `client-http__${issuer.user.id}`, {
    client_id: 'client-http', user_id: issuer.user.id, role: 'owner', status: 'active'
  });
  await setDoc('issuer_operators', issuer.user.id, { id: issuer.user.id, active: true });
  await setDoc('projects', 'project-http', {
    id: 'project-http', client_id: 'client-http', name: 'HTTP smoke', deleted_at: null
  });

  const view = await call(baseUrl, '/api/v1/projects/project-http/github-crm', { token: issuer.token });
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.data.configured, true, 'injected adapter overrides unconfigured production default');
  assert.equal(view.headers.get('cache-control'), 'no-store');

  await setDoc('github_project_bindings', 'project-http', {
    id: 'project-http', project_id: 'project-http', client_id: 'client-http',
    repository: 'acme/widget', repository_owner: 'acme', repository_name: 'widget',
    installation_id: 17, project_v2_id: 'PVT_HTTP', project_v2_number: 4, organization: 'acme'
  });
  const worker = await call(baseUrl, '/api/v1/github-crm/worker/reconcile', {
    method: 'POST',
    headers: { authorization: 'Bearer service-token' },
    body: { project_id: 'project-http' }
  });
  assert.equal(worker.status, 200, JSON.stringify(worker.data));
  assert.equal(worker.data.project_id, 'project-http');
  assert.equal(verifierCalls, 1, 'injected service verifier is called through the real request handler');

  const unavailableServer = await start(t);
  const unavailableOwner = await account(unavailableServer.baseUrl, 'github-owner@customer.test');
  await setDoc('clients', 'client-unconfigured', { id: 'client-unconfigured' });
  await setDoc('memberships', `client-unconfigured__${unavailableOwner.user.id}`, {
    client_id: 'client-unconfigured', user_id: unavailableOwner.user.id, role: 'owner', status: 'active'
  });
  await setDoc('projects', 'project-unconfigured', {
    id: 'project-unconfigured', client_id: 'client-unconfigured', name: 'Unconfigured', deleted_at: null
  });
  const unavailable = await call(
    unavailableServer.baseUrl,
    '/api/v1/projects/project-unconfigured/github-crm',
    { token: unavailableOwner.token }
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.data.error.code, 'GITHUB_CRM_UNAVAILABLE');
});
