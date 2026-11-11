'use strict';
// Сквозной тест: права, заявка → согласование → чек → проведение, окно правки, корректировка, журнал.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
process.env.DATA_DIR = dir;
process.env.HEAD_LOGIN = 'boss';
process.env.HEAD_PASSWORD = 'Boss12345';
const { createServer, bootstrap } = require('../server/index');
const { db } = require('../server/db');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let base; let server;

function client() {
  let cookie = '';
  return async (method, p, body, { csrf = true } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-BH'] = '1';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
}

test.before(async () => {
  bootstrap();
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('полный цикл заявки и защита', async () => {
  const head = client(); const eng = client(); const other = client();
  assert.equal((await head('POST', '/api/login', { login: 'boss', password: 'wrong' })).status, 401);
  assert.equal((await head('POST', '/api/login', { login: 'boss', password: 'Boss12345' })).status, 200);

  // руководитель создаёт сотрудников; у них временный пароль
  const u1 = (await head('POST', '/api/head/users', { login: 'eng', name: 'Инженер', role: 'staff' })).data;
  const u2 = (await head('POST', '/api/head/users', { login: 'other', name: 'Другой', role: 'staff' })).data;
  assert.ok(u1.password);
  await eng('POST', '/api/login', { login: 'eng', password: u1.password });
  assert.equal((await eng('GET', '/api/requests')).status, 428, 'без смены временного пароля работать нельзя');
  assert.equal((await eng('POST', '/api/me/password', { current: u1.password, next: 'Engineer123' })).status, 200);
  await other('POST', '/api/login', { login: 'other', password: u2.password });
  await other('POST', '/api/me/password', { current: u2.password, next: 'Other12345' });

  // сотрудник не попадает в раздел руководителя
  assert.equal((await eng('GET', '/api/head/overview')).status, 403);
  assert.equal((await eng('GET', '/api/head/users')).status, 403);
  // без заголовка X-BH изменяющий запрос отклоняется
  assert.equal((await eng('POST', '/api/requests', { title: 'x' }, { csrf: false })).status, 403);

  // онлайн-покупка без ссылки не принимается
  const bad = await eng('POST', '/api/requests', { kind: 'purchase', title: 'Труба', channel: 'online', items: [{ name: 'Труба', qty: 2, price: 100 }] });
  assert.equal(bad.status, 400);
  const created = await eng('POST', '/api/requests', { kind: 'purchase', title: 'Труба', channel: 'online', items: [{ name: 'Труба 40х20', qty: 2, price: 100, url: 'shop.example/truba' }] });
  assert.equal(created.status, 200);
  const id = created.data.id;

  // чужую заявку другой сотрудник не видит
  assert.equal((await other('GET', `/api/requests/${id}`)).status, 404);
  assert.equal((await other('GET', '/api/requests')).data.items.length, 0);
  // сотрудник не может сам себе согласовать
  assert.equal((await eng('POST', `/api/requests/${id}/action`, { action: 'approve' })).status, 403);

  // в течение окна правки можно менять, изменения пишутся в журнал
  const ed = await eng('PUT', `/api/requests/${id}`, { items: [{ name: 'Труба 40х20', qty: 3, price: 100, url: 'shop.example/truba' }] });
  assert.equal(ed.status, 200);
  assert.equal(ed.data.request.amount, 300);
  assert.ok(ed.data.request.events.some((e) => e.action === 'edited' && e.data.changes.some((c) => c.field === 'qty')));

  // согласование
  assert.equal((await head('POST', `/api/requests/${id}/action`, { action: 'approve', approved_amount: 300 })).status, 200);
  // отчёт без чека не принимается
  await eng('PUT', `/api/requests/${id}`, { part: 'report', items: [{ id: ed.data.request.items[0].id, actual_qty: 3, actual_price: 110 }] });
  assert.equal((await eng('POST', `/api/requests/${id}/action`, { action: 'submit_report' })).status, 400);
  // чужой не может прикрепить файл; неподдерживаемый тип — отказ
  assert.equal((await other('POST', '/api/files', { request_id: id, name: 'x.png', data: PNG })).status, 404);
  assert.equal((await eng('POST', '/api/files', { request_id: id, name: 'x.exe', data: 'data:x;base64,TVqQAAMAAAAEAAAA' })).status, 415);
  const f = await eng('POST', '/api/files', { request_id: id, kind: 'receipt', name: 'чек.png', data: PNG });
  assert.equal(f.status, 200);
  assert.equal((await other('GET', `/api/files/${f.data.id}`)).status, 404);
  assert.equal((await eng('POST', `/api/requests/${id}/action`, { action: 'submit_report' })).status, 200);

  // окно правки отчёта истекло → правка запрещена, только через корректировку
  db.prepare('UPDATE requests SET edit_until = ? WHERE id = ?').run(Date.now() - 1000, id);
  const locked = await eng('PUT', `/api/requests/${id}`, { part: 'report', items: [{ id: ed.data.request.items[0].id, actual_price: 90 }] });
  assert.equal(locked.status, 423);
  const corr = await eng('POST', '/api/corrections', { entity: 'request', id, reason: 'Ошибся в цене по чеку' });
  assert.equal(corr.status, 200);
  assert.equal((await eng('POST', `/api/corrections/${corr.data.id}/decide`, { approve: true })).status, 403);
  assert.equal((await head('POST', `/api/corrections/${corr.data.id}/decide`, { approve: true, comment: 'ок' })).status, 200);
  assert.equal((await eng('PUT', `/api/requests/${id}`, { part: 'report', items: [{ id: ed.data.request.items[0].id, actual_qty: 3, actual_price: 105 }] })).status, 200);

  // руководитель проводит; перерасход виден в проверке
  const det = (await head('GET', `/api/requests/${id}`)).data;
  assert.equal(det.actual_total, 315);
  assert.ok(det.flags.some((x) => x.code === 'report_edited'));
  assert.equal((await head('POST', `/api/requests/${id}/action`, { action: 'close' })).status, 200);

  // повтор того же чека в другой заявке ловится
  const id2 = (await eng('POST', '/api/requests', { kind: 'money', title: 'На расходники', purpose: 'Электроды', amount: 500 })).data.id;
  await head('POST', `/api/requests/${id2}/action`, { action: 'approve' });
  await head('POST', `/api/requests/${id2}/action`, { action: 'issue', issued_amount: 500 });
  await eng('PUT', `/api/requests/${id2}`, { part: 'report', items: [{ name: 'Электроды', qty: 1, actual_price: 450 }], returned_amount: 50 });
  await eng('POST', '/api/files', { request_id: id2, kind: 'receipt', name: 'тот-же.png', data: PNG });
  await eng('POST', `/api/requests/${id2}/action`, { action: 'submit_report' });
  const d2 = (await head('GET', `/api/requests/${id2}`)).data;
  assert.ok(d2.flags.some((x) => x.code === 'dup_receipt'));
  await head('POST', `/api/requests/${id2}/action`, { action: 'close' });

  // доход и аналитика
  const inc = await eng('POST', '/api/incomes', { date: new Date().toISOString().slice(0, 10), title: 'Навес', amount: 5000 });
  await head('POST', `/api/incomes/${inc.data.id}/action`, { action: 'confirm' });
  const ov = (await head('GET', '/api/head/overview')).data;
  assert.equal(ov.current.income, 5000);
  assert.equal(ov.current.expenses, 765);
  assert.equal(ov.current.profit, 4235);

  // журнал нельзя изменить даже напрямую в базе
  assert.throws(() => db.prepare('DELETE FROM events').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE events SET action = 'x'").run(), /append-only/);

  // защита от подбора пароля
  const bf = client();
  for (let k = 0; k < 5; k++) await bf('POST', '/api/login', { login: 'eng', password: 'nope' });
  assert.equal((await bf('POST', '/api/login', { login: 'eng', password: 'Engineer123' })).status, 429);
});
