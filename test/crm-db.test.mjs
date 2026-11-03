import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDoc, queryPage, resetInMemoryDb, setDoc, setFirestoreDisabled, transactDocs, updateDoc
} from '../src/server/db.mjs';
import { HttpError } from '../src/server/http.mjs';

setFirestoreDisabled(true);

test('multi-document memory transactions serialize increments and cannot partially commit', async () => {
  resetInMemoryDb();
  await setDoc('counters', 'one', { id: 'one', count: 0 });
  const refs = [{ collection: 'counters', id: 'one' }, { collection: 'events', id: 'event' }];
  await Promise.all(Array.from({ length: 20 }, () => transactDocs(refs, ([counter]) => ({
    writes: [{ ...refs[0], data: { ...counter, count: counter.count + 1 } }], result: counter.count + 1
  }))));
  assert.equal((await getDoc('counters', 'one')).count, 20);
  await assert.rejects(transactDocs(refs, ([counter]) => {
    counter.count = 999;
    throw new HttpError(409, 'REJECTED', 'Rejected transaction');
  }), { code: 'REJECTED' });
  assert.equal((await getDoc('counters', 'one')).count, 20);
  await assert.rejects(transactDocs(refs, ([counter]) => ({
    writes: [
      { ...refs[0], data: { ...counter, count: 999 } },
      { collection: 'events', id: 'undeclared', data: { id: 'undeclared' } }
    ]
  })), /declared reference/);
  assert.equal((await getDoc('counters', 'one')).count, 20);
  assert.equal(await getDoc('events', 'undeclared'), null);
});

test('transaction results are isolated, asynchronous callbacks and duplicate writes are rejected', async () => {
  resetInMemoryDb();
  const doc = { collection: 'counters', id: 'one' };
  await setDoc(doc.collection, doc.id, { count: 1 });
  await assert.rejects(transactDocs([doc], async () => ({ writes: [] })), /synchronous/);
  await assert.rejects(transactDocs([doc], () => ({
    writes: [{ ...doc, data: { count: 2 } }, { ...doc, data: { count: 3 } }]
  })), /one declared reference/);
  const result = await transactDocs([doc], ([counter]) => ({
    writes: [{ ...doc, data: { ...counter, nested: { value: 2 } } }],
    result: { nested: { value: 2 } }
  }));
  result.nested.value = 999;
  assert.equal((await getDoc(doc.collection, doc.id)).nested.value, 2);
});

test('single-document synchronous updates cannot overwrite a concurrent finance transaction', async () => {
  resetInMemoryDb();
  await setDoc('projects', 'one', { id: 'one', version: 1 });
  const projectRef = { collection: 'projects', id: 'one' };
  await Promise.all([
    updateDoc('projects', 'one', (project) => ({ ...project, version: project.version + 1 })),
    transactDocs([projectRef], ([project]) => ({
      writes: [{ ...projectRef, data: { ...project, finance_retained: true, version: project.version + 1 } }]
    }))
  ]);
  assert.equal((await getDoc('projects', 'one')).version, 3);
  assert.equal((await getDoc('projects', 'one')).finance_retained, true);
});

test('cursor queries traverse more than 1000 documents without duplication or tenant leakage', async () => {
  resetInMemoryDb();
  for (let index = 0; index < 1011; index++) {
    const id = `dea_${String(index).padStart(6, '0')}`;
    await setDoc('deals', id, { id, client_id: index < 1010 ? 'a' : 'b' });
  }
  const ids = [];
  let after = null;
  do {
    const page = await queryPage('deals', { where: [['client_id', '==', 'a']], pageSize: 50, after });
    ids.push(...page.items.map((item) => item.id));
    after = page.next_cursor;
  } while (after);
  assert.equal(ids.length, 1010);
  assert.equal(new Set(ids).size, 1010);
  assert.ok(!ids.includes('dea_001010'));
  await assert.rejects(queryPage('deals', { after: '../bad' }), { status: 400 });
  await assert.rejects(queryPage('deals', { pageSize: 51 }), { status: 400 });
});

test('document-ID paging supports legacy memberships without an id data field', async () => {
  resetInMemoryDb();
  for (let index = 0; index < 65; index++) await setDoc('memberships', `client__u${String(index).padStart(3, '0')}`, { client_id: 'client', user_id: `u${index}` });
  const first = await queryPage('memberships', { where: [['client_id', '==', 'client']], pageSize: 50, documentIdOrder: true });
  const second = await queryPage('memberships', { where: [['client_id', '==', 'client']], pageSize: 50, documentIdOrder: true, after: first.next_cursor });
  assert.equal(first.items.length + second.items.length, 65);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 65);
  assert.equal((await getDoc('memberships', 'client__u000')).id, undefined);
});
