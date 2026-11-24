'use strict';
// Подразделения: у каждого своя база (касса, заявки, сотрудники); руководитель переключается, сотрудник не видит чужих.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-div-'));
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

test('подразделения изолированы, руководитель переключается', async () => {
  const head = client(); const eng = client();
  await head('POST', '/api/login', { login: 'boss', password: 'Boss12345' });
  const u = (await head('POST', '/api/head/users', { login: 'eng', name: 'Инженер', role: 'staff' })).data;
  await eng('POST', '/api/login', { login: 'eng', password: u.password });
  await eng('POST', '/api/me/password', { current: u.password, next: 'Engineer123' });
  await head('POST', '/api/cash', { kind: 'topup', amount: 1000, comment: 'БХ' });
  await eng('POST', '/api/requests', { kind: 'money', title: 'Заявка БХ', purpose: 'x', amount: 100 });

  // создать подразделение может только руководитель
  assert.equal((await eng('POST', '/api/head/divisions', { name: 'Офис Днепр' })).status, 403);
  const dv = (await head('POST', '/api/head/divisions', { name: 'Офис Днепр' })).data;
  assert.ok(dv.slug);
  assert.equal((await head('POST', '/api/head/divisions', { name: 'офис днепр' })).status, 409);

  // сотрудник не видит другие подразделения и не может переключиться
  const ed = (await eng('GET', '/api/divisions')).data;
  assert.equal(ed.items.length, 1); assert.equal(ed.items[0].name, 'БХ');
  assert.equal((await eng('POST', '/api/divisions/switch', { slug: dv.slug })).status, 403);

  // руководитель видит оба и переключается без входа
  assert.equal((await head('GET', '/api/divisions')).data.items.length, 2);
  assert.equal((await head('POST', '/api/divisions/switch', { slug: dv.slug })).status, 200);
  assert.equal((await head('GET', '/api/me')).data.division.name, 'Офис Днепр');
  assert.equal((await head('GET', '/api/cash')).data.balance, 0, 'своя касса');
  assert.equal((await head('GET', '/api/requests?status=')).data.items.length, 0, 'свои заявки');
  assert.ok(!(await head('GET', '/api/head/users')).data.items.some((x) => x.login === 'eng'), 'инженера БХ здесь нет');
  await head('POST', '/api/cash', { kind: 'topup', amount: 250, comment: 'Днепр' });
  const d = (await head('POST', '/api/head/users', { login: 'dnipro', name: 'Сотрудник Днепр', role: 'staff' })).data;

  // сотрудник Днепра входит сразу в своё подразделение и видит только его
  const dn = client();
  await dn('POST', '/api/login', { login: 'dnipro', password: d.password });
  await dn('POST', '/api/me/password', { current: d.password, next: 'Dnipro12345' });
  assert.equal((await dn('GET', '/api/me')).data.division.name, 'Офис Днепр');
  assert.equal((await dn('GET', '/api/requests')).data.items.length, 0);
  assert.equal((await dn('GET', '/api/divisions')).data.items.length, 1);

  // инженер БХ в своём подразделении: касса и заявки БХ не тронуты
  assert.equal((await eng('GET', '/api/me')).data.division.name, 'БХ');
  assert.equal((await eng('GET', '/api/requests')).data.items.length, 1);
  await head('POST', '/api/divisions/switch', { slug: 'main' });
  assert.equal((await head('GET', '/api/cash')).data.balance, 1000);
  assert.ok((await head('GET', '/api/head/events')).data.items.some((e) => e.action === 'division_entered'));

  // пароль руководителя меняется во всех его подразделениях
  await head('POST', '/api/me/password', { current: 'Boss12345', next: 'NewBoss999' });
  const h2 = client();
  assert.equal((await h2('POST', '/api/login', { login: 'boss', password: 'NewBoss999' })).status, 200);
  assert.equal((await h2('POST', '/api/divisions/switch', { slug: dv.slug })).status, 200);
  assert.equal((await h2('GET', '/api/cash')).data.balance, 250);
});
