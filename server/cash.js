'use strict';
// Касса подразделения: ручные операции руководителя и отчёт с остатком.
// Автоматические операции (выдача под отчёт, возврат остатка, доход наличными) создаются в logic.js.
const { db, getSettings, logEvent, tx } = require('./db');
const L = require('./logic');

const { HttpError, str, money, round2, isDate, fm } = L;

const KINDS = {
  topup: { dir: 'in', title: 'Пополнение' },
  income: { dir: 'in', title: 'Доход наличными' },
  return: { dir: 'in', title: 'Возврат остатка' },
  issue: { dir: 'out', title: 'Выдано под отчёт' },
  expense: { dir: 'out', title: 'Расход из кассы' },
  withdraw: { dir: 'out', title: 'Сдано / инкассация' },
  recount: { dir: null, title: 'Пересчёт кассы' },
};
const MANUAL = ['topup', 'expense', 'withdraw', 'recount'];

const needHead = (user) => { if (user.role !== 'head') throw new HttpError(403, 'Только для руководителя'); };
// Кассу ведёт руководитель или сотрудник с отметкой «Кассир». Видят её оба.
const canCash = (user) => user.role === 'head' || !!user.cashier;
const needCash = (user) => { L.needModule('mod_cash', 'Раздел «Касса»'); if (!canCash(user)) throw new HttpError(403, 'Касса доступна руководителю и кассиру'); };

function opDate(body) {
  const d = str(body.date, 10);
  if (!d) return Date.now();
  if (!isDate(d)) throw new HttpError(400, 'Проверьте дату');
  const ts = Date.parse(`${d}T12:00:00`);
  if (ts > Date.now() + 864e5) throw new HttpError(400, 'Дата не может быть в будущем');
  // Сегодняшняя дата — текущее время, чтобы порядок операций в ленте был верным.
  const t = new Date();
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  return d === today ? Date.now() : ts;
}

function createOp(user, body) {
  needCash(user);
  const kind = String(body.kind || '');
  if (!MANUAL.includes(kind)) throw new HttpError(400, 'Неизвестная операция');
  const settings = getSettings();
  const comment = str(body.comment, 500);
  const ts = opDate(body);
  return tx(() => {
    const bal = L.cashBalance();
    let op;
    if (kind === 'recount') {
      const counted = money(body.counted, { max: 1e9 });
      if (counted == null) throw new HttpError(400, 'Укажите, сколько денег фактически в кассе');
      const diff = round2(counted - bal);
      if (diff === 0) {
        logEvent(user.id, 'cash', null, 'cash_recount_ok', { balance: bal });
        return { id: null, diff: 0 };
      }
      op = { direction: diff > 0 ? 'in' : 'out', kind, amount: Math.abs(diff),
        comment: comment || (diff > 0 ? `Излишек при пересчёте: было ${fm(bal)}, по факту ${fm(counted)}` : `Недостача при пересчёте: было ${fm(bal)}, по факту ${fm(counted)}`) };
    } else {
      const amount = money(body.amount, { allowZero: false });
      if (amount == null) throw new HttpError(400, 'Укажите сумму');
      const dir = KINDS[kind].dir;
      if (dir === 'out' && amount > bal) throw new HttpError(409, `В кассе ${fm(bal)} — нельзя выдать ${fm(amount)}`);
      if (kind === 'expense' && !comment) throw new HttpError(400, 'Напишите, на что потрачено');
      const category = kind === 'expense' ? (settings.categories.includes(body.category) ? body.category : 'Прочее') : '';
      const object = kind === 'expense' && settings.objects.includes(body.object) ? body.object : '';
      op = { direction: dir, kind, amount, category, object, comment };
    }
    const id = L.cashInsert({ ...op, ts, user_id: user.id });
    if (body.file?.data) {
      const fid = L.storeFile(user, { cash_op_id: id }, kind === 'expense' ? 'receipt' : 'other', body.file.name, body.file.data);
      db.prepare('UPDATE cash_ops SET file_id = ? WHERE id = ?').run(fid, id);
    }
    logEvent(user.id, 'cash', id, `cash_${kind}`, { amount: op.amount, direction: op.direction, category: op.category, comment: op.comment, balance_after: L.cashBalance() });
    return { id, diff: kind === 'recount' ? (op.direction === 'in' ? op.amount : -op.amount) : undefined };
  });
}

function removeOp(user, id, reason) {
  needHead(user);
  const o = db.prepare('SELECT * FROM cash_ops WHERE id = ?').get(Number(id));
  if (!o || o.removed_at) throw new HttpError(404, 'Операция не найдена');
  if (!MANUAL.includes(o.kind)) throw new HttpError(409, 'Эта операция создана автоматически — она отменяется вместе с заявкой или доходом');
  const why = str(reason, 300);
  if (!why) throw new HttpError(400, 'Напишите причину отмены');
  db.prepare('UPDATE cash_ops SET removed_at = ?, removed_by = ?, remove_reason = ? WHERE id = ?').run(Date.now(), user.id, why, o.id);
  logEvent(user.id, 'cash', o.id, 'cash_voided', { kind: o.kind, amount: o.amount, reason: why });
}

function range(q) {
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let from = isDate(q.from || '') ? q.from : ymd(new Date(today.getFullYear(), today.getMonth(), 1));
  let to = isDate(q.to || '') ? q.to : ymd(today);
  if (from > to) [from, to] = [to, from];
  return { from, to, fromTs: Date.parse(`${from}T00:00:00`), toTs: Date.parse(`${to}T00:00:00`) + 864e5 - 1 };
}

const signed = "CASE direction WHEN 'in' THEN amount ELSE -amount END";

function report(q = {}) {
  const r = range(q);
  const opening = round2(db.prepare(`SELECT COALESCE(SUM(${signed}),0) s FROM cash_ops WHERE removed_at IS NULL AND ts < ?`).get(r.fromTs).s);
  const where = ['c.ts BETWEEN ? AND ?']; const args = [r.fromTs, r.toTs];
  if (q.kind && KINDS[q.kind]) { where.push('c.kind = ?'); args.push(q.kind); }
  const rows = db.prepare(`SELECT c.*, u.name user_name, rm.name removed_name, rq.title request_title, i.title income_title
    FROM cash_ops c JOIN users u ON u.id = c.user_id LEFT JOIN users rm ON rm.id = c.removed_by
    LEFT JOIN requests rq ON rq.id = c.request_id LEFT JOIN incomes i ON i.id = c.income_id
    WHERE ${where.join(' AND ')} ORDER BY c.ts, c.id`).all(...args);
  // Остаток после каждой операции считается по всем видам, даже если включён фильтр.
  const all = db.prepare(`SELECT id, ${signed} v, removed_at FROM cash_ops WHERE ts BETWEEN ? AND ? ORDER BY ts, id`).all(r.fromTs, r.toTs);
  let run = opening; const after = new Map();
  for (const o of all) { if (!o.removed_at) run += o.v; after.set(o.id, round2(run)); }
  const closing = round2(run);
  const totals = { in: 0, out: 0, by_kind: {} };
  for (const o of rows) {
    if (o.removed_at) continue;
    totals[o.direction] += o.amount;
    totals.by_kind[o.kind] = round2((totals.by_kind[o.kind] || 0) + (o.direction === 'in' ? o.amount : -o.amount));
  }
  const underReport = db.prepare("SELECT COALESCE(SUM(issued_amount),0) s, COUNT(*) n FROM requests WHERE issued_from_cash = 1 AND status IN ('issued','review','report_revision')").get();
  const pend = db.prepare("SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM openings WHERE status = 'pending' AND target = 'cash'").get();
  return {
    range: r, opening, closing, balance: L.cashBalance(), pending_openings: { s: round2(pend.s), n: pend.n },
    cashiers: db.prepare("SELECT name FROM users WHERE cashier = 1 AND active = 1 ORDER BY name").all().map((x) => x.name),
    totals: { in: round2(totals.in), out: round2(totals.out), by_kind: totals.by_kind },
    under_report: { s: round2(underReport.s), n: underReport.n },
    items: rows.reverse().map((o) => ({
      id: o.id, ts: o.ts, direction: o.direction, kind: o.kind, kind_text: KINDS[o.kind].title, amount: o.amount, category: o.category, object: o.object,
      comment: o.comment, request_id: o.request_id, request_number: o.request_id ? L.reqNumber(o.request_id) : null, request_title: o.request_title,
      income_id: o.income_id, income_number: o.income_id ? L.incNumber(o.income_id) : null, income_title: o.income_title, file_id: o.file_id, delivery_id: o.delivery_id,
      user_name: o.user_name, balance_after: after.get(o.id), manual: MANUAL.includes(o.kind),
      removed_at: o.removed_at, removed_name: o.removed_name, remove_reason: o.remove_reason,
    })),
    kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.title])),
  };
}

function csvRows(q) {
  const rep = report(q);
  const nf = (n) => (n == null ? '' : String(n).replace('.', ','));
  return [['Дата', 'Операция', 'Приход', 'Расход', 'Остаток после', 'Категория', 'Объект', 'Основание', 'Комментарий', 'Кто', 'Отменена'],
    ...rep.items.slice().reverse().map((o) => [new Date(o.ts).toLocaleString('ru-RU'), o.kind_text, o.direction === 'in' ? nf(o.amount) : '', o.direction === 'out' ? nf(o.amount) : '',
      nf(o.balance_after), o.category, o.object, o.request_number || o.income_number || '', o.comment, o.user_name, o.removed_at ? `да: ${o.remove_reason}` : ''])];
}

// ---------- прошлые расходы, которые ещё не прошли через кассу ----------
// Проведённые заявки без выдачи под отчёт, где не указано «картой/счётом компании» или «своими деньгами»
// и по которым касса ещё не уменьшалась.
function unpaidPast(user) {
  needCash(user);
  return db.prepare(`SELECT r.id, r.title, r.closed_at, r.actual_total, r.channel, r.kind, r.paid_from, r.object, u.name user_name
    FROM requests r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'closed' AND r.issued_amount IS NULL AND r.actual_total > 0 AND r.paid_from NOT IN ('company','self')
      AND NOT EXISTS (SELECT 1 FROM cash_ops c WHERE c.request_id = r.id AND c.kind = 'expense' AND c.delivery_id IS NULL AND c.removed_at IS NULL)
    ORDER BY r.closed_at`).all().map((r) => ({ ...r, number: L.reqNumber(r.id) }));
}
// action: cash — списать из кассы датой проведения; company/self — оплачено не из кассы, убрать из списка.
function settlePast(user, ids, action) {
  needHead(user);
  if (!['cash', 'company', 'self'].includes(action)) throw new HttpError(400, 'Неизвестное действие');
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean).slice(0, 1000);
  if (!list.length) throw new HttpError(400, 'Отметьте заявки');
  const allowed = new Map(unpaidPast(user).map((r) => [r.id, r]));
  return tx(() => {
    let n = 0; let sum = 0;
    for (const id of list) {
      if (!allowed.has(id)) continue;
      const r = L.loadRequest(id);
      db.prepare('UPDATE requests SET paid_from = ? WHERE id = ?').run(action, id);
      if (action === 'cash') { L.cashPayRequest(user, { ...r, paid_from: 'cash' }, r.actual_total, r.closed_at); sum += r.actual_total; }
      logEvent(user.id, 'request', id, 'paid_from_set', { paid_from: L.PAY_FROM[action], amount: r.actual_total, past: true });
      n++;
    }
    return { count: n, sum: round2(sum), balance: L.cashBalance() };
  });
}

// ---------- сверка кассы за весь период ----------
// Находит всё, что ещё не прошло через кассу: подтверждённые доходы, проведённые заявки, доставку.
// То, что уже есть в кассе (выдача под отчёт из кассы, уже списанные расходы, доходы), второй раз не попадает.
function syncCandidates() {
  const activeOp = (where) => `EXISTS (SELECT 1 FROM cash_ops c WHERE c.removed_at IS NULL AND ${where})`;
  const incomes = db.prepare(`SELECT i.*, u.name user_name FROM incomes i JOIN users u ON u.id = i.user_id
    WHERE i.status = 'confirmed' AND NOT ${activeOp("c.kind = 'income' AND c.income_id = i.id")} ORDER BY i.date`).all()
    .map((i) => ({ ...i, ts: Math.min(Date.parse(`${i.date}T12:00:00`) || i.created_at, i.decided_at || Date.now()) }));
  const requests = db.prepare(`SELECT r.*, u.name user_name FROM requests r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'closed' AND r.actual_total > 0 AND COALESCE(r.issued_from_cash, 0) = 0
      AND NOT ${activeOp("c.kind = 'expense' AND c.request_id = r.id AND c.delivery_id IS NULL")} ORDER BY r.closed_at`).all();
  const deliveries = db.prepare(`SELECT d.*, r.title, r.object, r.status req_status, r.closed_at, r.issued_from_cash, u.name user_name
    FROM deliveries d JOIN requests r ON r.id = d.request_id JOIN users u ON u.id = d.user_id
    WHERE d.removed_at IS NULL AND r.status NOT IN ('rejected','cancelled')
      AND NOT (d.paid_by = 'advance' AND COALESCE(r.issued_from_cash, 0) = 1)
      AND NOT ${activeOp('c.delivery_id = d.id')} ORDER BY d.created_at`).all()
    .map((d) => ({ ...d, ts: Math.max(d.created_at, d.closed_at || 0) }));
  // Начальные остатки, внесённые через «Начальный остаток», — их можно заменить одним остатком на начало учёта.
  const openings = db.prepare(`SELECT c.* FROM cash_ops c WHERE c.removed_at IS NULL AND c.kind = 'topup'
    AND (c.id IN (SELECT cash_op_id FROM openings WHERE status = 'approved' AND cash_op_id IS NOT NULL) OR c.comment LIKE 'Остаток на начало учёта%')`).all();
  return { incomes, requests, deliveries, openings };
}
function syncPreview(user) {
  needHead(user);
  const c = syncCandidates();
  const sum = (arr, f = (x) => x.amount) => round2(arr.reduce((t, x) => t + f(x), 0));
  const balance = L.cashBalance();
  const inc = sum(c.incomes); const req = sum(c.requests, (x) => x.actual_total); const del = sum(c.deliveries);
  const open = sum(c.openings);
  return {
    balance, cash_all: L.cashAll(),
    incomes: { n: c.incomes.length, s: inc }, requests: { n: c.requests.length, s: req }, deliveries: { n: c.deliveries.length, s: del },
    openings: { n: c.openings.length, s: open },
    balance_after: round2(balance + inc - req - del),
    // остаток без внесённых начальных остатков — от него считаем «остаток на начало», если известна сумма сейчас
    balance_without_openings: round2(balance + inc - req - del - open),
    first_date: syncPreviewFirst(),
    items: [
      ...c.incomes.map((x) => ({ ts: x.ts, dir: 'in', amount: x.amount, title: x.title, source: L.incNumber(x.id), user_name: x.user_name })),
      ...c.requests.map((x) => ({ ts: x.closed_at, dir: 'out', amount: x.actual_total, title: x.title, source: L.reqNumber(x.id), user_name: x.user_name })),
      ...c.deliveries.map((x) => ({ ts: x.ts, dir: 'out', amount: x.amount, title: `Доставка: ${x.title}`, source: L.reqNumber(x.request_id), user_name: x.user_name })),
    ].sort((a, b) => a.ts - b.ts),
  };
}
// mode: 'start' — amount это остаток на начало учёта; 'now' — amount это сколько реально в кассе сейчас; 'keep' — начальные остатки не трогаем.
function syncApply(user, body) {
  needHead(user);
  const mode = ['start', 'now', 'keep'].includes(body.mode) ? body.mode : 'keep';
  const startDate = isDate(str(body.start_date, 10)) ? str(body.start_date, 10) : null;
  let amount = null;
  if (mode !== 'keep') {
    amount = money(body.amount, { max: 1e9 });
    if (amount == null) throw new HttpError(400, mode === 'now' ? 'Укажите, сколько сейчас реально в кассе' : 'Укажите остаток на начало учёта');
  }
  return tx(() => {
    const c = syncCandidates();
    let n = 0;
    for (const i of c.incomes) {
      L.cashInsert({ direction: 'in', kind: 'income', amount: i.amount, income_id: i.id, object: i.object, category: i.category, comment: i.title.slice(0, 300), user_id: user.id, ts: i.ts }); n++;
    }
    for (const r of c.requests) {
      db.prepare("UPDATE requests SET paid_from = 'cash' WHERE id = ?").run(r.id);
      L.cashInsert({ direction: 'out', kind: 'expense', amount: r.actual_total, request_id: r.id, object: r.object, category: r.category,
        comment: `Оплачено из кассы: ${r.title}`.slice(0, 300), user_id: user.id, ts: r.closed_at }); n++;
    }
    for (const d of c.deliveries) {
      L.cashInsert({ direction: 'out', kind: 'expense', amount: d.amount, request_id: d.request_id, delivery_id: d.id, object: d.object, category: 'Доставка',
        comment: `Доставка: ${d.carrier || ''}${d.ttn ? ` ТТН ${d.ttn}` : ''} · ${d.title}`.slice(0, 300), user_id: user.id, ts: d.ts }); n++;
    }
    let startOp = null; let start = null;
    if (mode !== 'keep') {
      // Начальные остатки заменяются одним «остатком на начало учёта», датированным самым началом.
      const openIds = c.openings.map((o) => o.id);
      for (const id of openIds) {
        db.prepare('UPDATE cash_ops SET removed_at = ?, removed_by = ?, remove_reason = ? WHERE id = ?').run(Date.now(), user.id, 'Заменено остатком на начало учёта', id);
      }
      start = mode === 'start' ? amount : round2(amount - L.cashBalance());
      if (start < 0) throw new HttpError(400, `Получается отрицательный остаток на начало учёта (${fm(start)}): расходов в истории больше, чем доходов и сумма в кассе сейчас. Проверьте сумму или проведённые заявки.`);
      const first = startDate || syncPreviewFirst();
      const ts = Date.parse(`${first}T00:00:01`);
      if (start > 0) {
        startOp = L.cashInsert({ direction: 'in', kind: 'topup', amount: start, comment: `Остаток на начало учёта (${first})`, user_id: user.id, ts });
        if (openIds.length) db.prepare(`UPDATE openings SET cash_op_id = ? WHERE cash_op_id IN (${openIds.map(() => '?').join(',')})`).run(startOp, ...openIds);
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('cash_all', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run();
    const balance = L.cashBalance();
    logEvent(user.id, 'cash', startOp, 'cash_synced', { operations: n, start, mode, balance });
    return { operations: n, start, balance };
  });
}
// Самая ранняя дата учёта (для «остатка на начало»).
function syncPreviewFirst() {
  const m = Math.min(
    db.prepare("SELECT MIN(ts) m FROM cash_ops WHERE removed_at IS NULL AND NOT (kind = 'topup' AND comment LIKE 'Остаток на начало учёта%')").get().m || Infinity,
    db.prepare("SELECT MIN(closed_at) m FROM requests WHERE status = 'closed'").get().m || Infinity,
    Date.parse(`${db.prepare("SELECT MIN(date) m FROM incomes WHERE status = 'confirmed'").get().m || '9999-01-01'}T12:00:00`),
    Date.now());
  return new Date(m - 864e5).toISOString().slice(0, 10);
}

// ---------- начальный остаток (по согласованию) ----------
const TARGETS = { cash: 'В кассу БХ', advance: 'Мои деньги под отчёт' };

function createOpening(user, body) {
  const target = TARGETS[body.target] ? body.target : null;
  if (!target) throw new HttpError(400, 'Выберите, что за остаток');
  const amount = money(body.amount, { allowZero: false });
  if (amount == null) throw new HttpError(400, 'Укажите сумму');
  const comment = str(body.comment, 500);
  if (comment.length < 3) throw new HttpError(400, 'Напишите, откуда эти деньги');
  if (db.prepare("SELECT id FROM openings WHERE user_id = ? AND target = ? AND status = 'pending'").get(user.id, target)) {
    throw new HttpError(409, 'Такой остаток уже ждёт подтверждения');
  }
  const r = db.prepare('INSERT INTO openings (user_id, target, amount, comment, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, target, amount, comment, Date.now());
  const id = Number(r.lastInsertRowid);
  logEvent(user.id, 'opening', id, 'opening_requested', { target: TARGETS[target], amount, comment });
  return id;
}

function decideOpening(user, id, approve, comment, target) {
  needHead(user);
  const o = db.prepare('SELECT * FROM openings WHERE id = ?').get(Number(id));
  if (o && approve && TARGETS[target] && target !== o.target && o.status === 'pending') {
    db.prepare('UPDATE openings SET target = ? WHERE id = ?').run(target, o.id);
    logEvent(user.id, 'opening', o.id, 'opening_retargeted', { from: TARGETS[o.target], to: TARGETS[target] });
    o.target = target;
  }
  if (!o) throw new HttpError(404, 'Заявка на остаток не найдена');
  if (o.status !== 'pending') throw new HttpError(409, 'Уже рассмотрено');
  // Свой остаток руководитель подтверждает сам, только если других руководителей нет.
  if (o.user_id === user.id && db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'head' AND active = 1 AND id != ?").get(user.id).n) {
    throw new HttpError(403, 'Свой остаток подтверждает другой руководитель');
  }
  const why = str(comment, 500);
  if (!approve && !why) throw new HttpError(400, 'Напишите причину отказа');
  const author = db.prepare('SELECT id, name FROM users WHERE id = ?').get(o.user_id);
  const now = Date.now();
  return tx(() => {
    let cashOpId = null; let requestId = null;
    if (approve && o.target === 'cash') {
      cashOpId = L.cashInsert({ direction: 'in', kind: 'topup', amount: o.amount, comment: `Начальный остаток (внёс ${author.name}): ${o.comment}`.slice(0, 300), user_id: user.id });
    }
    if (approve && o.target === 'advance') {
      // Деньги на руках становятся подотчётом: сотрудник отчитывается по ним чеками, как по выданным.
      const r = db.prepare(`INSERT INTO requests (kind, channel, title, purpose, user_id, status, amount, approved_amount, issued_amount, issued_from_cash,
          edit_until, created_at, updated_at, decided_at, decided_by) VALUES ('money', 'offline', ?, ?, ?, 'issued', ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
        .run('Начальный остаток на руках', o.comment, o.user_id, o.amount, o.amount, o.amount, now, now, now, now, user.id);
      requestId = Number(r.lastInsertRowid);
      logEvent(user.id, 'request', requestId, 'opening_issued', { amount: o.amount, comment: o.comment });
    }
    db.prepare('UPDATE openings SET status = ?, decided_at = ?, decided_by = ?, decision_comment = ?, cash_op_id = ?, request_id = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', now, user.id, why, cashOpId, requestId, o.id);
    logEvent(user.id, 'opening', o.id, approve ? 'opening_approved' : 'opening_rejected', { target: TARGETS[o.target], amount: o.amount, comment: why, author: author.name });
    return { request_id: requestId, cash_op_id: cashOpId, user_id: o.user_id };
  });
}

// Остаток подтвердили как «деньги на руках», а это были наличные кассы: переносим в кассу.
// Можно, пока по подотчёту не было ни отчёта, ни чеков.
function moveOpeningToCash(user, id) {
  needHead(user);
  const o = db.prepare('SELECT * FROM openings WHERE id = ?').get(Number(id));
  if (!o || o.status !== 'approved' || o.target !== 'advance' || !o.request_id) throw new HttpError(409, 'Перенести в кассу можно только подтверждённый остаток «под отчёт»');
  const r = L.loadRequest(o.request_id);
  const used = db.prepare("SELECT COUNT(*) n FROM files WHERE request_id = ? AND kind != 'removed'").get(r.id).n + L.itemsOf(r.id).length;
  if (r.status !== 'issued' || used) throw new HttpError(409, 'По этому остатку уже отчитывались — перенести нельзя');
  const author = db.prepare('SELECT name FROM users WHERE id = ?').get(o.user_id);
  return tx(() => {
    db.prepare("UPDATE requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), r.id);
    logEvent(user.id, 'request', r.id, 'cancelled', { comment: 'Начальный остаток перенесён в кассу' });
    const cashOpId = L.cashInsert({ direction: 'in', kind: 'topup', amount: o.amount, comment: `Начальный остаток (внёс ${author.name}): ${o.comment}`.slice(0, 300), user_id: user.id });
    db.prepare("UPDATE openings SET target = 'cash', cash_op_id = ?, request_id = NULL WHERE id = ?").run(cashOpId, o.id);
    logEvent(user.id, 'opening', o.id, 'opening_moved_to_cash', { amount: o.amount, author: author.name });
    return { cash_op_id: cashOpId };
  });
}

function listOpenings(user) {
  const all = canCash(user);
  const where = all ? "o.status = 'pending' OR o.created_at > ? OR o.user_id = ?" : 'o.user_id = ? OR ? = 0';
  const args = all ? [Date.now() - 30 * 864e5, user.id] : [user.id, 1];
  return db.prepare(`SELECT o.*, u.name user_name, d.name decided_name FROM openings o JOIN users u ON u.id = o.user_id LEFT JOIN users d ON d.id = o.decided_by
    WHERE ${where} ORDER BY o.status = 'pending' DESC, o.id DESC LIMIT 50`).all(...args)
    .map((o) => ({ ...o, target_text: TARGETS[o.target] }));
}

module.exports = { KINDS, MANUAL, TARGETS, canCash, moveOpeningToCash, unpaidPast, settlePast, syncPreview, syncApply, createOp, removeOp, report, csvRows, createOpening, decideOpening, listOpenings };
