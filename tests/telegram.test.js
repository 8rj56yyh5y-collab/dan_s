'use strict';
// Telegram-бот: привязка, уведомления, решения кнопками, причина отказа, защита. Telegram подменён локальным сервером.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sent = []; let updates = []; let nextUpdate = 1;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const method = req.url.split('/').pop();
    const data = body ? JSON.parse(body) : {};
    let result = true;
    if (method === 'getMe') result = { id: 1, username: 'bh_test_bot' };
    else if (method === 'getUpdates') {
      if (!updates.length) await new Promise((r) => setTimeout(r, 50));
      result = updates; updates = [];
    } else sent.push({ method, ...data });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-tg-'));
let base; let server; let tg; let db;
const push = (u) => updates.push({ update_id: nextUpdate++, ...u });
const waitFor = async (fn, what) => {
  for (let k = 0; k < 100; k++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error(`не дождались: ${what}`);
};
const msgTo = (chat, re) => sent.find((m) => m.method === 'sendMessage' && String(m.chat_id) === String(chat) && re.test(m.text));

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

test.before(async () => {
  await new Promise((r) => fake.listen(0, r));
  Object.assign(process.env, { DATA_DIR: dir, HEAD_LOGIN: 'boss', HEAD_PASSWORD: 'Boss12345', TELEGRAM_BOT_TOKEN: 'test',
    TELEGRAM_API_BASE: `http://127.0.0.1:${fake.address().port}`, TELEGRAM_POLL_TIMEOUT: '0', PUBLIC_URL: 'https://bh.example.com' });
  const app = require('../server/index');
  tg = require('../server/telegram'); db = require('../server/db').db;
  app.bootstrap();
  server = app.createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  await tg.start();
});
test.after(() => { tg.stop(); server.close(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('бот: привязка, уведомления и решения кнопками', async () => {
  const head = client(); const eng = client();
  await head('POST', '/api/login', { login: 'boss', password: 'Boss12345' });
  const u = (await head('POST', '/api/head/users', { login: 'eng', name: 'Инженер', role: 'staff' })).data;
  await eng('POST', '/api/login', { login: 'eng', password: u.password });
  await eng('POST', '/api/me/password', { current: u.password, next: 'Engineer123' });

  // привязка: код из профиля → /start <код> в боте
  const link = (await head('POST', '/api/me/telegram')).data;
  assert.match(link.url, /^https:\/\/t\.me\/bh_test_bot\?start=[a-f0-9]{24}$/);
  push({ message: { chat: { id: 111, type: 'private' }, from: { username: 'boss_tg' }, text: `/start ${link.url.split('=')[1]}` } });
  await waitFor(() => msgTo(111, /Готово/), 'привязка руководителя');
  assert.equal((await head('GET', '/api/me/telegram')).data.linked, true);
  const elink = (await eng('POST', '/api/me/telegram')).data;
  push({ message: { chat: { id: 222, type: 'private' }, from: {}, text: `/start ${elink.url.split('=')[1]}` } });
  await waitFor(() => msgTo(222, /Готово/), 'привязка сотрудника');
  // чужой или просроченный код не привязывает
  push({ message: { chat: { id: 333, type: 'private' }, from: {}, text: `/start ${'a'.repeat(24)}` } });
  await waitFor(() => msgTo(333, /Профиль/), 'подсказка незнакомцу');

  // новая заявка → руководителю приходит сообщение с кнопками
  const id = (await eng('POST', '/api/requests', { kind: 'purchase', title: 'Труба', channel: 'offline', items: [{ name: 'Труба 40х20', qty: 2, price: 100 }] })).data.id;
  const note = await waitFor(() => msgTo(111, /Новая заявка/), 'уведомление о заявке');
  const buttons = note.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === `h:approve:r:${id}`));
  assert.ok(buttons.some((b) => b.url === `https://bh.example.com/#/r/${id}`));
  assert.ok(!msgTo(222, /Новая заявка/), 'сотрудник не получает уведомление о своей же заявке');

  // сотрудник нажал чужую кнопку — нельзя; незнакомец — нельзя
  push({ callback_query: { id: 'x1', from: { id: 222 }, message: { chat: { id: 222 }, message_id: 1, text: 't' }, data: `h:approve:r:${id}` } });
  push({ callback_query: { id: 'x2', from: { id: 333 }, message: { chat: { id: 333 }, message_id: 1, text: 't' }, data: `h:approve:r:${id}` } });
  await waitFor(() => sent.filter((m) => m.method === 'answerCallbackQuery' && ['x1', 'x2'].includes(m.callback_query_id)).length === 2, 'ответы на чужие кнопки');
  assert.equal(db.prepare('SELECT status FROM requests WHERE id = ?').get(id).status, 'pending');

  // руководитель согласует кнопкой → сотруднику приходит решение, сообщение помечается
  push({ callback_query: { id: 'c1', from: { id: 111 }, message: { chat: { id: 111 }, message_id: 7, text: note.text }, data: `h:approve:r:${id}` } });
  await waitFor(() => db.prepare('SELECT status FROM requests WHERE id = ?').get(id).status === 'approved', 'согласование кнопкой');
  await waitFor(() => msgTo(222, /согласована/), 'уведомление сотруднику');
  await waitFor(() => sent.find((m) => m.method === 'editMessageText' && m.message_id === 7 && /Согласовано/.test(m.text)), 'отметка в сообщении');
  // повторное нажатие — уже решено
  push({ callback_query: { id: 'c2', from: { id: 111 }, message: { chat: { id: 111 }, message_id: 7, text: note.text }, data: `h:approve:r:${id}` } });
  await waitFor(() => sent.find((m) => m.method === 'answerCallbackQuery' && m.callback_query_id === 'c2' && m.show_alert), 'повтор');

  // отказ с причиной: кнопка → бот просит причину → ответ текстом
  const id2 = (await eng('POST', '/api/requests', { kind: 'money', title: 'На расходники', purpose: 'Электроды', amount: 300 })).data.id;
  await waitFor(() => sent.find((m) => m.method === 'sendMessage' && String(m.chat_id) === '111' && m.text.includes('З-0000' + id2)), 'вторая заявка');
  push({ callback_query: { id: 'c3', from: { id: 111 }, message: { chat: { id: 111 }, message_id: 8, text: 'Заявка' }, data: `h:reject:r:${id2}` } });
  await waitFor(() => sent.find((m) => m.method === 'sendMessage' && String(m.chat_id) === '111' && m.reply_markup?.force_reply), 'вопрос о причине');
  push({ message: { chat: { id: 111, type: 'private' }, from: {}, text: 'Дорого, есть на складе' } });
  await waitFor(() => db.prepare('SELECT status FROM requests WHERE id = ?').get(id2).status === 'rejected', 'отказ с причиной');
  assert.equal(db.prepare('SELECT head_comment FROM requests WHERE id = ?').get(id2).head_comment, 'Дорого, есть на складе');
  await waitFor(() => msgTo(222, /отклонена[\s\S]*Дорого/), 'причина у сотрудника');

  // начальный остаток: заявка → кнопка «Подтвердить» → деньги на руках становятся подотчётом
  const oid = (await eng('POST', '/api/openings', { target: 'advance', amount: 700, comment: 'Остаток с прошлого месяца' })).data.id;
  await waitFor(() => msgTo(111, /Начальный остаток/), 'остаток руководителю');
  push({ callback_query: { id: 'c4', from: { id: 111 }, message: { chat: { id: 111 }, message_id: 9, text: 'Остаток' }, data: `h:op1:o:${oid}` } });
  await waitFor(() => db.prepare('SELECT status FROM openings WHERE id = ?').get(oid).status === 'approved', 'подтверждение остатка');
  const rq = db.prepare("SELECT * FROM requests WHERE title = 'Начальный остаток на руках'").get();
  assert.equal(rq.status, 'issued'); assert.equal(rq.issued_amount, 700);
  await waitFor(() => msgTo(222, /подтверждён/), 'сотрудник узнал о подтверждении');

  // /stop — отвязка
  push({ message: { chat: { id: 222, type: 'private' }, from: {}, text: '/stop' } });
  await waitFor(() => msgTo(222, /отключены/), 'отвязка');
  assert.equal((await eng('GET', '/api/me/telegram')).data.linked, false);
});
