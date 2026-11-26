'use strict';
// Доход и приход на нужды — разные вещи: приход идёт в кассу, но не в доходы, расходы и результат.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fund-'));
Object.assign(process.env, { DATA_DIR: dir, HEAD_LOGIN: 'boss', HEAD_PASSWORD: 'Boss12345' });
const { createServer, bootstrap } = require('../server/index');
let base; let server;
function client() {
  let cookie = '';
  return async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json', 'X-BH': '1' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}
test.before(async () => { bootstrap(); server = createServer(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('приход на нужды — не доход', async () => {
  const head = client();
  await head('POST', '/api/login', { login: 'boss', password: 'Boss12345' });
  const d = new Date().toISOString().slice(0, 10);
  const from = `${d.slice(0, 8)}01`;
  const ov = async () => (await head('GET', `/api/head/overview?from=${from}&to=${d}`)).data.current;

  // приход 33 000: в кассе есть, в доходах нет; категория и обязательные поля доходов к нему не относятся
  await head('PUT', '/api/head/settings', { require_category: true, income_confirm: true });
  const f = await head('POST', '/api/incomes', { kind: 'funding', date: d, title: 'На материалы и зарплаты', amount: 33000, method: 'cash', category: 'Продажа продукции' });
  assert.equal(f.status, 200, JSON.stringify(f.data));
  await head('POST', `/api/incomes/${f.data.id}/action`, { action: 'confirm' });
  const fi = (await head('GET', `/api/incomes/${f.data.id}`)).data;
  assert.equal(fi.kind, 'funding'); assert.equal(fi.category, '');
  assert.equal((await head('GET', '/api/cash')).data.balance, 33000, 'приход в кассе');
  let c = await ov();
  assert.equal(c.income, 0, 'приход не доход'); assert.equal(c.profit, 0);

  // обычный доход по-прежнему требует категорию и входит в доходы
  assert.equal((await head('POST', '/api/incomes', { date: d, title: 'Навес', amount: 5000 })).status, 400);
  const inc = (await head('POST', '/api/incomes', { date: d, title: 'Навес', amount: 5000, category: 'Услуги' })).data.id;
  await head('POST', `/api/incomes/${inc}/action`, { action: 'confirm' });
  assert.equal((await ov()).income, 5000);

  // ошибочно внесённый как доход переводится в приход: доходы уменьшаются, касса не меняется
  await head('POST', `/api/incomes/${inc}/action`, { action: 'set_kind', kind: 'funding' });
  c = await ov();
  assert.equal(c.income, 0); assert.equal((await head('GET', '/api/cash')).data.balance, 38000);
  const list = (await head('GET', '/api/incomes')).data;
  assert.equal(list.confirmed_sum, 0); assert.equal(list.funding_sum, 38000);
  assert.equal((await head('GET', '/api/incomes?kind=income')).data.items.length, 0);

  // отчёт по кассе: отдельная группа «Приходы на нужды», доходы за период — 0
  const rep = (await head('GET', `/api/cash/report?from=${from}&to=${d}`)).data;
  assert.ok(rep.groups_in.some((g) => g.title.startsWith('Приходы на нужды') && g.amount === 38000), JSON.stringify(rep.groups_in));
  assert.equal(rep.pl.income, 0);
  // лента операций: приход виден, но в прибыль не входит
  const feed = (await head('GET', `/api/head/money?from=${from}&to=${d}`)).data;
  assert.equal(feed.totals.income, 0); assert.ok(feed.items.some((x) => x.type === 'funding'));

  // и обратно
  await head('POST', `/api/incomes/${inc}/action`, { action: 'set_kind', kind: 'income' });
  assert.equal((await ov()).income, 5000);
});
