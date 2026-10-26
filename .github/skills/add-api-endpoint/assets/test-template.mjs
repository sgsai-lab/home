// Template: test/<feature>.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { account, call, start } from './helpers.mjs';

test('widgets are created by workspace admins and invisible to other tenants', async (t) => {
  const { baseUrl } = await start(t);
  const admin = await account(baseUrl, 'admin@sgs.test', { role: 'admin' });
  const client = (await call(baseUrl, '/api/v1/clients', { method: 'POST', token: admin.token, body: { name: 'Acme', primary_sector: 'business' } })).data;

  const created = await call(baseUrl, '/api/v1/widgets', { method: 'POST', token: admin.token, body: { client_id: client.id, name: '<b>Widget</b>' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.name, 'Widget');

  const outsider = await account(baseUrl, 'outsider@example.com');
  assert.equal((await call(baseUrl, `/api/v1/widgets?client_id=${client.id}`, { token: outsider.token })).status, 404);
  assert.equal((await call(baseUrl, '/api/v1/widgets', { method: 'POST', body: {} })).status, 401);
});
