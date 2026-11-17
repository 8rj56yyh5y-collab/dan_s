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
  // сумма по чеку не совпадает с позициями — не принимается
  await eng('PUT', `/api/requests/${id}`, { part: 'report', receipt_total: 350 });
  const mism = await eng('POST', `/api/requests/${id}/action`, { action: 'submit_report' });
  assert.equal(mism.status, 400); assert.match(mism.data.error, /не совпадает/);
  // чек 330 больше согласованных 300 — без объяснения нельзя (это запрос на превышение)
  await eng('PUT', `/api/requests/${id}`, { part: 'report', receipt_total: 330 });
  const over = await eng('POST', `/api/requests/${id}/action`, { action: 'submit_report' });
  assert.equal(over.status, 400); assert.match(over.data.error, /больше согласованных/);
  await eng('PUT', `/api/requests/${id}`, { part: 'report', report_comment: 'Подорожала труба' });
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
  // касса пуста — выдать из неё нельзя; пополняем и выдаём
  assert.equal((await head('POST', `/api/requests/${id2}/action`, { action: 'issue', issued_amount: 500 })).status, 409);
  assert.equal((await eng('POST', '/api/cash', { kind: 'topup', amount: 1000 })).status, 403);
  assert.equal((await eng('GET', '/api/cash')).status, 403);
  assert.equal((await head('POST', '/api/cash', { kind: 'topup', amount: 1000, comment: 'Из офиса' })).data.balance, 1000);
  assert.equal((await head('POST', `/api/requests/${id2}/action`, { action: 'issue', issued_amount: 500 })).status, 200);
  assert.equal((await head('GET', '/api/cash')).data.balance, 500);
  await eng('PUT', `/api/requests/${id2}`, { part: 'report', items: [{ name: 'Электроды', qty: 1, actual_price: 450 }], returned_amount: 50 });
  await eng('POST', '/api/files', { request_id: id2, kind: 'receipt', name: 'тот-же.png', data: PNG });
  await eng('POST', `/api/requests/${id2}/action`, { action: 'submit_report' });
  const d2 = (await head('GET', `/api/requests/${id2}`)).data;
  assert.ok(d2.flags.some((x) => x.code === 'dup_receipt'));
  await head('POST', `/api/requests/${id2}/action`, { action: 'close' });
  // остаток подотчёта (50) вернулся в кассу при проведении
  let cr = (await head('GET', '/api/cash')).data;
  assert.equal(cr.balance, 550);
  assert.ok(cr.items.some((o) => o.kind === 'return' && o.amount === 50));
  // ручные операции: расход без описания и больше остатка — нельзя
  assert.equal((await head('POST', '/api/cash', { kind: 'expense', amount: 100 })).status, 400);
  assert.equal((await head('POST', '/api/cash', { kind: 'withdraw', amount: 9999 })).status, 409);
  const ce = await head('POST', '/api/cash', { kind: 'expense', amount: 100, category: 'Материалы', comment: 'Краска', file: { name: 'чек.png', data: PNG } });
  assert.equal(ce.data.balance, 450);
  // пересчёт: по факту 440 → недостача 10
  const rc = await head('POST', '/api/cash', { kind: 'recount', counted: 440 });
  assert.equal(rc.data.diff, -10);
  assert.equal(rc.data.balance, 440);
  // автоматическую операцию отменить нельзя, ручную — с причиной
  const issueOp = (await head('GET', '/api/cash')).data.items.find((o) => o.kind === 'issue');
  assert.equal((await head('POST', `/api/head/cash/${issueOp.id}/void`, { reason: 'x' })).status, 409);
  const expOverview = (await head('GET', '/api/head/overview')).data.current;
  assert.equal(expOverview.cash_expenses, 100);
  assert.equal((await head('POST', `/api/head/cash/${ce.data.id}/void`, {})).status, 400);
  assert.equal((await head('POST', `/api/head/cash/${ce.data.id}/void`, { reason: 'Ошибочно' })).data.balance, 540);

  // доставка: после проведения, без согласования; чужой и до согласования — нельзя
  const pend = (await eng('POST', '/api/requests', { kind: 'money', title: 'Ещё', purpose: 'x', amount: 100 })).data.id;
  assert.equal((await eng('POST', `/api/requests/${pend}/deliveries`, { amount: 50 })).status, 409);
  assert.equal((await other('POST', `/api/requests/${id}/deliveries`, { amount: 50 })).status, 404);
  assert.equal((await eng('POST', `/api/requests/${id}/deliveries`, { amount: 0 })).status, 400);
  const dl = await eng('POST', `/api/requests/${id}/deliveries`, { amount: 80, carrier: 'Нова пошта', ttn: '20450 000 000 000', paid_by: 'self', file: { name: 'np.png', data: PNG } });
  assert.equal(dl.status, 200);
  assert.equal(dl.data.request.delivery_total, 80);
  assert.equal(dl.data.request.deliveries[0].ttn, '20450000000000');
  assert.ok(dl.data.request.events.some((e) => e.action === 'delivery_added' && e.data.after_close));
  // лишняя запись: автор удаляет сам, в журнале остаётся
  const extra = await eng('POST', `/api/requests/${id}/deliveries`, { amount: 999, paid_by: 'company' });
  const extraId = extra.data.request.deliveries.find((d) => d.amount === 999).id;
  assert.equal((await other('DELETE', `/api/deliveries/${extraId}`)).status, 404);
  assert.equal((await eng('DELETE', `/api/deliveries/${extraId}`)).status, 200);
  // после окна правки сотрудник удалить не может, руководитель — может
  db.prepare('UPDATE deliveries SET created_at = ? WHERE id = ?').run(Date.now() - 3 * 3600e3, dl.data.request.deliveries[0].id);
  assert.equal((await eng('DELETE', `/api/deliveries/${dl.data.request.deliveries[0].id}`)).status, 423);
  // «оплатил сам» → компания должна сотруднику
  const adv = (await head('GET', '/api/head/overview')).data.advances.find((a) => a.name === 'Инженер');
  assert.equal(adv.balance, -80);

  // доход и аналитика (расходы = 315 + 450 по чекам + 80 доставка)
  const inc = await eng('POST', '/api/incomes', { date: new Date().toISOString().slice(0, 10), title: 'Навес', amount: 5000, method: 'cash' });
  await head('POST', `/api/incomes/${inc.data.id}/action`, { action: 'confirm' });
  // доход наличными попал в кассу
  assert.equal((await head('GET', '/api/cash')).data.balance, 5540);
  const ov = (await head('GET', '/api/head/overview')).data;
  assert.equal(ov.current.income, 5000);
  assert.equal(ov.current.expenses, 845);
  assert.equal(ov.current.delivery, 80);
  assert.equal(ov.current.profit, 4155);
  assert.ok(ov.by_category.some((c) => c.k === 'Доставка' && c.s === 80));

  // журнал нельзя изменить даже напрямую в базе
  assert.throws(() => db.prepare('DELETE FROM events').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE events SET action = 'x'").run(), /append-only/);

  // чек приложен, цены не заполнены: «потрачено» не показывается как 0; руководитель проводит по чеку сам
  const id3 = (await eng('POST', '/api/requests', { kind: 'purchase', title: 'Кабель', channel: 'offline', items: [{ name: 'Кабель 3х2.5', qty: 10, price: 40 }] })).data.id;
  await head('POST', `/api/requests/${id3}/action`, { action: 'approve' });
  assert.equal((await head('POST', `/api/requests/${id3}/action`, { action: 'accept' })).status, 400, 'без чека провести нельзя');
  await eng('POST', '/api/files', { request_id: id3, kind: 'receipt', name: 'кабель.png', data: PNG });
  const it3 = (await eng('GET', `/api/requests/${id3}`)).data.items[0];
  const draft = await eng('PUT', `/api/requests/${id3}`, { part: 'report', items: [{ id: it3.id, actual_qty: 10, actual_price: '' }] });
  assert.equal(draft.data.request.actual_total, null, 'черновик без цен не считается тратой 0 ₴');
  assert.equal((await eng('POST', `/api/requests/${id3}/action`, { action: 'accept', items: [{ id: it3.id, actual_price: 42 }] })).status, 403);
  assert.equal((await head('POST', `/api/requests/${id3}/action`, { action: 'accept', items: [{ id: it3.id, actual_qty: 10, actual_price: '' }] })).status, 400);
  const acc = await head('POST', `/api/requests/${id3}/action`, { action: 'accept', items: [{ id: it3.id, actual_qty: 10, actual_price: 42 }] });
  assert.equal(acc.data.request.status, 'closed');
  assert.equal(acc.data.request.actual_total, 420);

  // отчёт «одной суммой»: только сумма по чеку, без цен по позициям; проверка это отмечает
  const id4 = (await eng('POST', '/api/requests', { kind: 'purchase', title: 'Мелочи', channel: 'offline', items: [{ name: 'Хомуты', qty: 1, price: 50 }, { name: 'Изолента', qty: 2, price: 30 }] })).data.id;
  await head('POST', `/api/requests/${id4}/action`, { action: 'approve' });
  await eng('POST', '/api/files', { request_id: id4, kind: 'receipt', name: 'м.png', data: PNG });
  assert.equal((await eng('POST', `/api/requests/${id4}/action`, { action: 'submit_report' })).status, 400, 'нет ни цен, ни суммы');
  const one = await eng('PUT', `/api/requests/${id4}`, { part: 'report', receipt_total: 105, no_breakdown: true });
  assert.equal(one.data.request.actual_total, 105);
  assert.equal((await eng('POST', `/api/requests/${id4}/action`, { action: 'submit_report' })).status, 200);
  const d4 = (await head('GET', `/api/requests/${id4}`)).data;
  assert.equal(d4.receipt_total, 105);
  assert.ok(d4.flags.some((x) => x.code === 'no_breakdown'));

  // начальный остаток кассы: заявка → подтверждение (единственный руководитель может подтвердить свой)
  const before = (await head('GET', '/api/cash')).data.balance;
  assert.equal((await head('POST', '/api/openings', { target: 'cash', amount: 1500 })).status, 400, 'нужно указать, откуда деньги');
  const op = (await head('POST', '/api/openings', { target: 'cash', amount: 1500, comment: 'Было в сейфе' })).data.id;
  assert.equal((await head('POST', '/api/openings', { target: 'cash', amount: 10, comment: 'Ещё раз' })).status, 409);
  assert.equal((await eng('POST', `/api/openings/${op}/decide`, { approve: true })).status, 403);
  assert.equal((await head('GET', '/api/cash')).data.balance, before, 'до подтверждения в кассу не попадает');
  await head('POST', `/api/openings/${op}/decide`, { approve: true });
  assert.equal((await head('GET', '/api/cash')).data.balance, before + 1500);
  const op2 = (await eng('POST', '/api/openings', { target: 'advance', amount: 300, comment: 'На руках' })).data.id;
  assert.equal((await head('POST', `/api/openings/${op2}/decide`, { approve: false })).status, 400, 'отказ — с причиной');
  await head('POST', `/api/openings/${op2}/decide`, { approve: false, comment: 'Уже учтено' });
  assert.equal((await eng('GET', '/api/openings')).data.items.find((o) => o.id === op2).status, 'rejected');

  // кассир: инженер ведёт кассу, руководитель видит всё и одни отменяет операции
  assert.equal((await eng('GET', '/api/cash')).status, 403, 'без отметки «кассир» кассы не видно');
  await head('PUT', `/api/head/users/${u1.id}`, { cashier: true });
  await eng('POST', '/api/logout'); await eng('POST', '/api/login', { login: 'eng', password: 'Engineer123' });
  const bal0 = (await eng('GET', '/api/cash')).data.balance;
  const ct = await eng('POST', '/api/cash', { kind: 'topup', amount: 200, comment: 'Из сейфа' });
  assert.equal(ct.data.balance, bal0 + 200);
  const cx = await eng('POST', '/api/cash', { kind: 'expense', amount: 50, comment: 'Вода', category: 'Хозтовары' });
  assert.equal((await head('GET', '/api/cash')).data.items[0].user_name, 'Инженер', 'руководитель видит операции кассира');
  assert.equal((await eng('POST', `/api/head/cash/${cx.data.id}/void`, { reason: 'x' })).status, 403, 'отменяет только руководитель');
  assert.equal((await other('GET', '/api/cash')).status, 403);
  // остаток подтвердили «под отчёт», а это была касса — переносим, пока по нему не отчитывались
  const op3 = (await eng('POST', '/api/openings', { target: 'advance', amount: 400, comment: 'В сейфе лежали' })).data.id;
  await head('POST', `/api/openings/${op3}/decide`, { approve: true });
  const balBefore = (await head('GET', '/api/cash')).data.balance;
  assert.equal((await head('POST', `/api/openings/${op3}/to-cash`)).data.balance, balBefore + 400);
  assert.equal((await head('POST', `/api/openings/${op3}/to-cash`)).status, 409, 'повторно нельзя');
  // при подтверждении руководитель сам выбирает, куда зачислить
  const op4 = (await eng('POST', '/api/openings', { target: 'advance', amount: 100, comment: 'Ещё' })).data.id;
  const b4 = (await head('GET', '/api/cash')).data.balance;
  await head('POST', `/api/openings/${op4}/decide`, { approve: true, target: 'cash' });
  assert.equal((await head('GET', '/api/cash')).data.balance, b4 + 100);

  // история операций: доходы, расходы по заявкам, доставка и касса в одной ленте
  const feed = (await head('GET', '/api/head/money')).data;
  assert.ok(feed.items.some((x) => x.type === 'income' && x.amount === 5000));
  assert.ok(feed.items.some((x) => x.type === 'expense' && x.source === `З-0000${id3}`));
  assert.ok(feed.items.some((x) => x.kind_text.startsWith('Доставка')));
  assert.ok(feed.items.some((x) => x.cash && x.title === 'Вода' && x.dir === 'out'));
  assert.equal(feed.totals.profit, Math.round((feed.totals.income - feed.totals.expenses) * 100) / 100);
  assert.ok((await head('GET', '/api/head/money?type=cash')).data.items.every((x) => x.cash));
  assert.ok((await head('GET', '/api/head/money?type=in')).data.items.every((x) => x.dir === 'in'));
  assert.equal((await eng('GET', '/api/head/money')).status, 403, 'историю всех денег видит только руководитель');

  // защита от подбора пароля
  const bf = client();
  for (let k = 0; k < 5; k++) await bf('POST', '/api/login', { login: 'eng', password: 'nope' });
  assert.equal((await bf('POST', '/api/login', { login: 'eng', password: 'Engineer123' })).status, 429);
});
