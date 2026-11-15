'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
process.env.APP_PASSWORD = 'secret';
const { server } = require('../server.js');

let base, cookie;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), res };
}

test('requires login', async () => {
  assert.equal((await call('GET', '/api/data')).status, 401);
  assert.equal((await call('POST', '/api/login', { name: 'Me', password: 'nope' })).status, 401);
  const ok = await call('POST', '/api/login', { name: 'Me', password: 'secret' });
  assert.equal(ok.status, 200);
  cookie = ok.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/me')).body.name, 'Me');
});

test('cats, weights and cascade delete', async () => {
  const cat = (await call('POST', '/api/cats', { name: 'Mochi', sex: 'Female' })).body;
  assert.ok(cat.id);
  assert.equal(cat.createdBy, 'Me');
  assert.equal((await call('POST', '/api/weights', { catId: 'nope', date: '2026-11-01', kg: 4 })).status, 400);
  assert.equal((await call('POST', '/api/weights', { catId: cat.id, date: '2026-11-01', kg: 4.2 })).status, 201);
  assert.equal((await call('POST', '/api/events', { catId: cat.id, type: 'Deflea', date: '2026-11-01', nextDue: '2026-12-01' })).status, 201);
  assert.equal((await call('POST', '/api/feedings', { catId: cat.id, time: '25:00' })).status, 400);
  assert.equal((await call('DELETE', `/api/cats/${cat.id}`)).status, 200);
  const { db } = (await call('GET', '/api/data')).body;
  assert.equal(db.weights.length, 0);
  assert.equal(db.events.length, 0);
});

test('transactions and groceries', async () => {
  assert.equal((await call('POST', '/api/transactions', { type: 'income', amount: 'abc', month: '2026-11' })).status, 400);
  const t = (await call('POST', '/api/transactions', { type: 'expense', amount: 12.5, month: '2026-11', category: 'Pets' })).body;
  const upd = await call('PUT', `/api/transactions/${t.id}`, { amount: 20 });
  assert.equal(upd.body.amount, 20);
  assert.equal(upd.body.category, 'Pets');

  const g = (await call('POST', '/api/groceries', { name: 'Milk', addedDate: '2026-11-15' })).body;
  const bought = (await call('PUT', `/api/groceries/${g.id}`, { bought: true, boughtDate: '2026-11-16' })).body;
  assert.equal(bought.bought, true);
  assert.equal(bought.name, 'Milk');
});

test('rejects non-JSON writes and persists to disk', async () => {
  assert.equal((await call('POST', '/api/groceries', { name: 'x', addedDate: '2026-11-15' }, { 'Content-Type': 'text/plain' })).status, 415);
  const saved = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  assert.equal(saved.groceries[0].name, 'Milk');
});

test('static files are served and path traversal is blocked', async () => {
  const res = await fetch(base + '/');
  assert.match(await res.text(), /Our Home/);
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 403);
});
