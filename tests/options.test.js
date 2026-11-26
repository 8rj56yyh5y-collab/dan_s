'use strict';
// Опции подразделения: по умолчанию — как в БХ; каждая опция действует на сервере, не только в интерфейсе.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-opt-'));
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
    return { status: res.status, data: await res.json() };
  };
}
test.before(async () => { bootstrap(); server = createServer(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('опции подразделения', async () => {
  const head = client();
  await head('POST', '/api/login', { login: 'boss', password: 'Boss12345' });
  const def = (await head('GET', '/api/settings')).data;
  for (const k of ['mod_incomes', 'mod_cash', 'mod_money', 'mod_delivery', 'mod_control', 'use_objects', 'require_link', 'require_receipt', 'income_confirm', 'cash_all']) assert.equal(def[k], true, k);
  assert.equal(def.label_object, 'Объект'); assert.equal(def.auto_approve_below, 0);

  // «Офис»: без доходов и денег под отчёт, без объектов, без ссылок, автосогласование до 1000
  const dv = (await head('POST', '/api/head/divisions', { name: 'Офис Днепр', copy_settings: true })).data;
  await head('POST', '/api/divisions/switch', { slug: dv.slug });
  assert.equal((await head('GET', '/api/settings')).data.mod_incomes, true, 'новое подразделение скопировало настройки');
  await head('PUT', '/api/head/settings', { mod_incomes: false, mod_money: false, mod_control: false, use_objects: false, require_link: false, require_category: true, auto_approve_below: 1000, categories: ['Канцелярия', 'Прочее'] });
  assert.equal((await head('POST', '/api/incomes', { date: '2026-11-01', title: 'x', amount: 10 })).status, 403);
  assert.equal((await head('POST', '/api/requests', { kind: 'money', title: 'x', purpose: 'x', amount: 10 })).status, 403);
  assert.equal((await head('POST', '/api/requests', { kind: 'purchase', title: 'Бумага', channel: 'online', items: [{ name: 'Бумага', qty: 1, price: 300 }] })).status, 400, 'категория обязательна');
  const small = (await head('POST', '/api/requests', { kind: 'purchase', title: 'Бумага', channel: 'online', category: 'Канцелярия', object: 'Что угодно', items: [{ name: 'Бумага', qty: 1, price: 300 }] })).data.id;
  const d1 = (await head('GET', `/api/requests/${small}`)).data;
  assert.equal(d1.status, 'approved', 'мелочь согласована автоматически'); assert.equal(d1.object, '', 'объект выключен — не сохраняется');
  const big = (await head('POST', '/api/requests', { kind: 'purchase', title: 'Принтер', channel: 'offline', category: 'Канцелярия', items: [{ name: 'Принтер', qty: 1, price: 5000 }] })).data.id;
  assert.equal((await head('GET', `/api/requests/${big}`)).data.status, 'pending', 'крупная — на согласование');

  // касса и доставка выключены; чек не обязателен
  await head('PUT', '/api/head/settings', { mod_cash: false, mod_delivery: false, require_receipt: false });
  assert.equal((await head('GET', '/api/cash')).status, 403);
  assert.equal((await head('POST', `/api/requests/${small}/deliveries`, { amount: 50 })).status, 403);
  const it = d1.items[0];
  await head('PUT', `/api/requests/${small}`, { part: 'report', items: [{ id: it.id, actual_qty: 1, actual_price: 300 }], receipt_total: 300 });
  assert.equal((await head('POST', `/api/requests/${small}/action`, { action: 'submit_report' })).status, 200, 'без чека — можно');
  assert.equal((await head('GET', `/api/requests/${small}`)).data.can_add_delivery, false);

  // «Отдел продаж» в основном подразделении: объект = клиент и обязателен, доходы без подтверждения
  await head('POST', '/api/divisions/switch', { slug: 'main' });
  assert.equal((await head('GET', '/api/settings')).data.mod_cash, true, 'настройки Днепра не задели основное подразделение');
  await head('PUT', '/api/head/settings', { label_object: 'Клиент', require_object: true, income_confirm: false, objects: ['ООО Ромашка'] });
  const no = await head('POST', '/api/incomes', { date: '2026-11-01', title: 'Продажа', amount: 1000 });
  assert.equal(no.status, 400); assert.match(no.data.error, /Клиент/);
  const inc = (await head('POST', '/api/incomes', { date: '2026-11-01', title: 'Продажа', amount: 1000, object: 'ООО Ромашка' })).data.id;
  assert.equal((await head('GET', `/api/incomes/${inc}`)).data.status, 'confirmed', 'доход учтён сразу');
  assert.equal((await head('GET', '/api/cash')).data.balance, 1000, 'и сразу в кассе');

  // новое подразделение «со стандартными настройками» — как в БХ
  const dv2 = (await head('POST', '/api/head/divisions', { name: 'ХХ', copy_settings: false })).data;
  await head('POST', '/api/divisions/switch', { slug: dv2.slug });
  const s2 = (await head('GET', '/api/settings')).data;
  assert.equal(s2.label_object, 'Объект'); assert.equal(s2.require_object, false); assert.equal(s2.division_name, 'ХХ');
});
