'use strict';
// «Всё через кассу»: каждый доход и расход меняет кассу; сверка за весь период проводит прошлое без дублей.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cashall-'));
Object.assign(process.env, { DATA_DIR: dir, HEAD_LOGIN: 'boss', HEAD_PASSWORD: 'Boss12345' });
const { createServer, bootstrap } = require('../server/index');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let base; let server;
function client() {
  let cookie = '';
  return async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json', 'X-BH': '1' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
}
test.before(async () => { bootstrap(); server = createServer(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function closedPurchase(head, title, price, channel = 'online') {
  const id = (await head('POST', '/api/requests', { kind: 'purchase', title, channel, items: [{ name: title, qty: 1, price, url: 'shop.example/x' }] })).data.id;
  await head('POST', `/api/requests/${id}/action`, { action: 'approve' });
  await head('POST', '/api/files', { request_id: id, kind: 'receipt', name: 'ч.png', data: PNG });
  const it = (await head('GET', `/api/requests/${id}`)).data.items[0];
  await head('POST', `/api/requests/${id}/action`, { action: 'accept', items: [{ id: it.id, actual_qty: 1, actual_price: price }], receipt_total: price });
  return id;
}

test('всё через кассу + сверка за весь период', async () => {
  const head = client();
  await head('POST', '/api/login', { login: 'boss', password: 'Boss12345' });
  assert.equal((await head('GET', '/api/settings')).data.cash_all, true, 'по умолчанию всё через кассу');

  // «старое» время: в кассу шли только наличные
  await head('PUT', '/api/head/settings', { cash_all: false });
  const op = (await head('POST', '/api/openings', { target: 'cash', amount: 5000, comment: 'Внёс недавно' })).data.id;
  await head('POST', `/api/openings/${op}/decide`, { approve: true });
  const inc1 = (await head('POST', '/api/incomes', { date: '2026-10-05', title: 'Навес', amount: 3000, method: 'card' })).data.id;
  await head('POST', `/api/incomes/${inc1}/action`, { action: 'confirm' });
  const r1 = await closedPurchase(head, 'Труба', 1200);
  await head('POST', `/api/requests/${r1}/deliveries`, { amount: 100, paid_by: 'company' });
  assert.equal((await head('GET', '/api/cash')).data.balance, 5000, 'в старом режиме карта и онлайн-покупка кассу не трогали');

  // сверка: видит доход, заявку, доставку и внесённый остаток
  const pv = (await head('GET', '/api/cash/sync')).data;
  assert.deepEqual([pv.incomes.n, pv.requests.n, pv.deliveries.n, pv.openings.n], [1, 1, 1, 1]);
  assert.equal(pv.balance_after, 5000 + 3000 - 1200 - 100);
  // в кассе реально 9000 → остаток на начало = 9000 − (3000 − 1200 − 100) = 7300, внесённые 5000 заменяются
  const ap = (await head('POST', '/api/cash/sync', { mode: 'now', amount: 9000 })).data;
  assert.equal(ap.operations, 3); assert.equal(ap.start, 7300); assert.equal(ap.balance, 9000);
  const ops = (await head('GET', '/api/cash?from=2000-01-01')).data.items;
  const startOp = ops.find((o) => /Остаток на начало учёта/.test(o.comment) && !o.removed_at);
  assert.ok(startOp && startOp.ts <= Math.min(...ops.filter((o) => o !== startOp).map((o) => o.ts)), 'остаток на начало — самая ранняя операция');
  assert.ok(ops.some((o) => o.removed_at && o.amount === 5000), 'внесённый ранее остаток заменён, но виден зачёркнутым');
  // повторная сверка ничего не дублирует
  const again = (await head('GET', '/api/cash/sync')).data;
  assert.deepEqual([again.incomes.n, again.requests.n, again.deliveries.n], [0, 0, 0]);
  assert.equal((await head('POST', '/api/cash/sync', { mode: 'keep' })).data.operations, 0);
  assert.equal((await head('GET', '/api/cash')).data.balance, 9000);
  // отрицательный остаток на начало — ошибка
  const neg = await head('POST', '/api/cash/sync', { mode: 'now', amount: 0 });
  assert.equal(neg.status, 400, 'отрицательный остаток на начало не принимается'); assert.match(neg.data.error, /отрицательный/);
  assert.equal((await head('GET', '/api/cash')).data.balance, 9000, 'после ошибки ничего не изменилось');

  // дальше — всё через кассу автоматически
  assert.equal((await head('GET', '/api/settings')).data.cash_all, true);
  const bal = (await head('GET', '/api/cash')).data.balance;
  const inc2 = (await head('POST', '/api/incomes', { date: new Date().toISOString().slice(0, 10), title: 'Резка', amount: 800, method: 'account' })).data.id;
  await head('POST', `/api/incomes/${inc2}/action`, { action: 'confirm' });
  assert.equal((await head('GET', '/api/cash')).data.balance, bal + 800, 'доход на счёт тоже в кассе');
  await closedPurchase(head, 'Краска', 300, 'online');
  assert.equal((await head('GET', '/api/cash')).data.balance, bal + 800 - 300, 'онлайн-покупка тоже из кассы');
  // в прибыли нет двойного счёта
  const pl = (await head('GET', '/api/head/overview?from=2026-01-01&to=2030-12-31')).data.current;
  assert.equal(pl.income, 3800); assert.equal(pl.expenses, 1600); assert.equal(pl.cash_expenses, 0);

  // отчёт: Excel и данные для печати
  const rep = (await head('GET', '/api/cash/report?from=2026-01-01&to=2030-12-31')).data;
  assert.equal(rep.closing, (await head('GET', '/api/cash')).data.balance);
  assert.ok(rep.items.length >= 6);
  const x = await head('GET', '/api/cash/report.xlsx?from=2026-01-01&to=2030-12-31');
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type'), /spreadsheetml/);
  assert.equal(x.data.slice(0, 2).toString(), 'PK', 'это zip-архив xlsx');
});
