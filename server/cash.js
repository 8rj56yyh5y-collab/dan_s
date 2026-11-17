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
const needCash = (user) => { if (!canCash(user)) throw new HttpError(403, 'Касса доступна руководителю и кассиру'); };

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
      income_id: o.income_id, income_number: o.income_id ? L.incNumber(o.income_id) : null, income_title: o.income_title, file_id: o.file_id,
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

module.exports = { KINDS, MANUAL, TARGETS, canCash, moveOpeningToCash, createOp, removeOp, report, csvRows, createOpening, decideOpening, listOpenings };
