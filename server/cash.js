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

const needHead = (user) => { if (user.role !== 'head') throw new HttpError(403, 'Касса — только для руководителя'); };

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
  needHead(user);
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
  return {
    range: r, opening, closing, balance: L.cashBalance(),
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

module.exports = { KINDS, MANUAL, createOp, removeOp, report, csvRows };
