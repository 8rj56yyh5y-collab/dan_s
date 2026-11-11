'use strict';
// Бизнес-логика: заявки, отчёты по чекам, доходы, корректировки, проверки (флаги).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, UPLOAD_DIR, getSettings, logEvent, nameKey, tx } = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- мелкие помощники ----------
const str = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
function money(v, { allowZero = true, max = 1e9 } = {}) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > max || (!allowZero && n === 0)) return null;
  return round2(n);
}
function cleanUrl(v) {
  const s = str(v, 1000);
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.toString();
  } catch { return ''; }
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const pad = (n, w = 5) => String(n).padStart(w, '0');
const reqNumber = (id) => `З-${pad(id)}`;
const incNumber = (id) => `Д-${pad(id)}`;
const CUR = process.env.CURRENCY || '₴';
const fm = (n) => `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${CUR}`;
const editMs = () => Number(getSettings().edit_hours || 2) * 3600e3;

const STATUS = {
  pending: 'На согласовании',
  revision: 'На доработке',
  approved: 'Согласовано',
  issued: 'Деньги выданы',
  review: 'Отчёт на проверке',
  report_revision: 'Отчёт на доработке',
  closed: 'Проведено',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};
const INCOME_STATUS = { new: 'Ждёт подтверждения', confirmed: 'Подтверждено', rejected: 'Отклонено' };

// ---------- права ----------
function canSee(user, ownerId) {
  return user.role === 'head' || user.id === ownerId;
}
function loadRequest(id) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(id));
  if (!r) throw new HttpError(404, 'Заявка не найдена');
  return r;
}
function requestFor(user, id) {
  const r = loadRequest(id);
  if (!canSee(user, r.user_id)) throw new HttpError(404, 'Заявка не найдена');
  return r;
}
function canEditPlan(r, now = Date.now()) {
  if (r.status === 'revision') return true;
  return ['pending', 'approved'].includes(r.status) && now < r.edit_until;
}
function canEditReport(r, now = Date.now()) {
  if (['approved', 'issued', 'report_revision'].includes(r.status)) return true;
  return r.status === 'review' && now < r.edit_until;
}

// ---------- товары ----------
function parseItems(list, { kind, report = false } = {}) {
  if (!Array.isArray(list)) list = [];
  const units = getSettings().units;
  const out = [];
  for (const raw of list.slice(0, 100)) {
    const name = str(raw?.name, 200);
    if (!name) continue;
    const qty = money(raw?.qty ?? 1, { allowZero: false, max: 1e7 });
    if (qty == null) throw new HttpError(400, `Проверьте количество у «${name}»`);
    const price = money(raw?.price ?? 0, { max: 1e8 });
    if (price == null) throw new HttpError(400, `Проверьте цену у «${name}»`);
    if (kind === 'purchase' && !report && price === 0) throw new HttpError(400, `Укажите цену у «${name}»`);
    const unit = units.includes(raw?.unit) ? raw.unit : str(raw?.unit, 12) || 'шт';
    const item = {
      id: Number(raw?.id) || null,
      name, qty, unit, price,
      url: cleanUrl(raw?.url), shop: str(raw?.shop, 120),
      actual_qty: raw?.actual_qty === '' || raw?.actual_qty == null ? null : money(raw.actual_qty, { max: 1e7 }),
      actual_price: raw?.actual_price === '' || raw?.actual_price == null ? null : money(raw.actual_price, { max: 1e8 }),
    };
    out.push(item);
  }
  return out;
}
const itemsOf = (rid) => db.prepare('SELECT * FROM request_items WHERE request_id = ? ORDER BY pos, id').all(rid);
const planTotal = (items) => round2(items.reduce((s, i) => s + i.qty * i.price, 0));
const actualTotal = (items) => round2(items.reduce((s, i) => s + (i.actual_qty ?? i.qty) * (i.actual_price ?? 0), 0));

function writeItems(rid, items) {
  db.prepare('DELETE FROM request_items WHERE request_id = ?').run(rid);
  const ins = db.prepare(`INSERT INTO request_items (request_id, pos, name, name_key, qty, unit, price, url, shop, actual_qty, actual_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  items.forEach((i, pos) => ins.run(rid, pos, i.name, nameKey(i.name), i.qty, i.unit, i.price, i.url, i.shop, i.actual_qty, i.actual_price));
}

// Разница «было → стало» для журнала.
function diffItems(before, after, fields) {
  const changes = [];
  const key = (i) => `${nameKey(i.name)}`;
  const b = new Map(before.map((i) => [key(i), i]));
  const a = new Map(after.map((i) => [key(i), i]));
  for (const [k, i] of a) {
    const old = b.get(k);
    if (!old) { changes.push({ item: i.name, change: 'добавлено', qty: i.qty, price: i.price }); continue; }
    for (const f of fields) {
      const ov = old[f] ?? null; const nv = i[f] ?? null;
      if (String(ov) !== String(nv)) changes.push({ item: i.name, field: f, from: ov, to: nv });
    }
  }
  for (const [k, i] of b) if (!a.has(k)) changes.push({ item: i.name, change: 'удалено', qty: i.qty, price: i.price });
  return changes;
}
function diffFields(before, after, fields) {
  const changes = [];
  for (const f of fields) {
    if (after[f] === undefined) continue;
    if (String(before[f] ?? '') !== String(after[f] ?? '')) changes.push({ field: f, from: before[f], to: after[f] });
  }
  return changes;
}

function planFields(body, settings) {
  const out = {
    title: str(body.title, 160),
    purpose: str(body.purpose, 2000),
    object: str(body.object, 120),
    category: str(body.category, 60),
    needed_by: isDate(str(body.needed_by, 10)) ? str(body.needed_by, 10) : '',
    channel: body.channel === 'offline' ? 'offline' : 'online',
  };
  if (!out.title) throw new HttpError(400, 'Напишите, что покупаем / на что деньги');
  if (out.object && !settings.objects.includes(out.object)) throw new HttpError(400, 'Выберите объект из списка');
  if (out.category && !settings.categories.includes(out.category)) throw new HttpError(400, 'Выберите категорию из списка');
  return out;
}

// ---------- заявки ----------
function createRequest(user, body) {
  if (user.role !== 'staff' && user.role !== 'head') throw new HttpError(403, 'Нет доступа');
  const settings = getSettings();
  const kind = body.kind === 'money' ? 'money' : 'purchase';
  const f = planFields(body, settings);
  const items = parseItems(body.items, { kind });
  let amount;
  if (kind === 'purchase') {
    if (!items.length) throw new HttpError(400, 'Добавьте хотя бы один товар');
    if (f.channel === 'online') {
      const noLink = items.find((i) => !i.url);
      if (noLink) throw new HttpError(400, `Для онлайн-покупки нужна ссылка на товар «${noLink.name}»`);
    }
    amount = planTotal(items);
  } else {
    amount = money(body.amount, { allowZero: false });
    if (amount == null) throw new HttpError(400, 'Укажите сумму');
    if (!f.purpose) throw new HttpError(400, 'Опишите, на что нужны деньги');
  }
  const now = Date.now();
  return tx(() => {
    const r = db.prepare(`INSERT INTO requests (kind, channel, title, purpose, object, category, needed_by, user_id, status, amount, edit_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(kind, f.channel, f.title, f.purpose, f.object, f.category, f.needed_by, user.id, amount, now + editMs(), now, now);
    const id = Number(r.lastInsertRowid);
    writeItems(id, items);
    logEvent(user.id, 'request', id, 'created', { kind, amount, items: items.length });
    return id;
  });
}

function updateRequest(user, id, body) {
  const r = requestFor(user, id);
  if (r.user_id !== user.id) throw new HttpError(403, 'Изменять заявку может только её автор');
  const now = Date.now();
  const settings = getSettings();
  const before = itemsOf(r.id);
  const wantsPlan = body.part !== 'report';

  return tx(() => {
    if (wantsPlan) {
      if (!canEditPlan(r, now)) throw new HttpError(423, 'Время на правку вышло. Отправьте запрос на корректировку руководителю.');
      const f = planFields({ ...r, ...body }, settings);
      const items = parseItems(body.items ?? before, { kind: r.kind });
      let amount = r.amount;
      if (r.kind === 'purchase') {
        if (!items.length) throw new HttpError(400, 'Добавьте хотя бы один товар');
        if (f.channel === 'online') {
          const noLink = items.find((i) => !i.url);
          if (noLink) throw new HttpError(400, `Для онлайн-покупки нужна ссылка на товар «${noLink.name}»`);
        }
        amount = planTotal(items);
      } else if (body.amount !== undefined) {
        amount = money(body.amount, { allowZero: false });
        if (amount == null) throw new HttpError(400, 'Укажите сумму');
      }
      const changes = [
        ...diffFields(r, { ...f, amount }, ['title', 'purpose', 'object', 'category', 'needed_by', 'channel', 'amount']),
        ...diffItems(before, items, ['qty', 'unit', 'price', 'url', 'shop']),
      ];
      if (!changes.length) return { changed: false };
      // Любое изменение после согласования возвращает заявку на повторное согласование.
      const reapprove = r.status === 'approved';
      db.prepare(`UPDATE requests SET title=?, purpose=?, object=?, category=?, needed_by=?, channel=?, amount=?, updated_at=?,
        status = CASE WHEN status='approved' THEN 'pending' ELSE status END,
        changed_after_approval = changed_after_approval OR ?, approved_amount = CASE WHEN ? THEN NULL ELSE approved_amount END
        WHERE id=?`)
        .run(f.title, f.purpose, f.object, f.category, f.needed_by, f.channel, amount, now, reapprove ? 1 : 0, reapprove ? 1 : 0, r.id);
      // Сохраняем фактические цены, если они уже были введены.
      const prevActual = new Map(before.map((i) => [nameKey(i.name), i]));
      items.forEach((i) => { const p = prevActual.get(nameKey(i.name)); if (p) { i.actual_qty = p.actual_qty; i.actual_price = p.actual_price; } });
      writeItems(r.id, items);
      logEvent(user.id, 'request', r.id, reapprove ? 'edited_after_approval' : 'edited', { changes });
      return { changed: true, reapprove };
    }

    // Отчёт: фактические цены и количество по чеку.
    if (!canEditReport(r, now)) throw new HttpError(423, r.status === 'review'
      ? 'Время на правку отчёта вышло. Отправьте запрос на корректировку руководителю.'
      : 'Сейчас отчёт по этой заявке изменить нельзя');
    let items;
    if (r.kind === 'money') {
      // По подотчёту сотрудник сам перечисляет, что купил; цена по чеку = фактическая.
      items = parseItems(body.items, { kind: 'money', report: true }).map((i) => ({
        ...i, price: i.actual_price ?? i.price, actual_price: i.actual_price ?? i.price,
      }));
    } else {
      const incoming = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [Number(i.id), i]));
      items = before.map((i) => {
        const inc = incoming.get(i.id);
        if (!inc) return i;
        const aq = inc.actual_qty === '' || inc.actual_qty == null ? null : money(inc.actual_qty, { max: 1e7 });
        const ap = inc.actual_price === '' || inc.actual_price == null ? null : money(inc.actual_price, { max: 1e8 });
        if (inc.actual_qty != null && inc.actual_qty !== '' && aq == null) throw new HttpError(400, `Проверьте количество у «${i.name}»`);
        if (inc.actual_price != null && inc.actual_price !== '' && ap == null) throw new HttpError(400, `Проверьте цену у «${i.name}»`);
        return { ...i, actual_qty: aq, actual_price: ap };
      });
    }
    let returned = r.returned_amount;
    if (body.returned_amount !== undefined) {
      returned = body.returned_amount === '' ? null : money(body.returned_amount);
      if (body.returned_amount !== '' && returned == null) throw new HttpError(400, 'Проверьте сумму возврата');
    }
    const changes = [
      ...diffItems(before, items, ['actual_qty', 'actual_price', ...(r.kind === 'money' ? ['qty', 'price'] : [])]),
      ...diffFields(r, { returned_amount: returned }, ['returned_amount']),
    ];
    if (!changes.length) return { changed: false };
    writeItems(r.id, items);
    const total = actualTotal(itemsOf(r.id));
    db.prepare('UPDATE requests SET actual_total = ?, returned_amount = ?, updated_at = ? WHERE id = ?').run(total, returned, now, r.id);
    logEvent(user.id, 'request', r.id, r.status === 'review' ? 'report_edited' : 'report_draft', { changes, actual_total: total });
    return { changed: true };
  });
}

function staffAction(user, id, action, body = {}) {
  const r = requestFor(user, id);
  if (r.user_id !== user.id) throw new HttpError(403, 'Это действие доступно только автору заявки');
  const now = Date.now();
  return tx(() => {
    if (action === 'resubmit') {
      if (r.status !== 'revision') throw new HttpError(409, 'Заявка не на доработке');
      db.prepare("UPDATE requests SET status='pending', edit_until=?, updated_at=? WHERE id=?").run(now + editMs(), now, r.id);
      logEvent(user.id, 'request', r.id, 'resubmitted', { comment: str(body.comment, 500) });
      return;
    }
    if (action === 'cancel') {
      if (!['pending', 'revision', 'approved'].includes(r.status)) throw new HttpError(409, 'Эту заявку уже нельзя отменить');
      db.prepare("UPDATE requests SET status='cancelled', updated_at=? WHERE id=?").run(now, r.id);
      logEvent(user.id, 'request', r.id, 'cancelled', { comment: str(body.comment, 500) });
      return;
    }
    if (action === 'submit_report') {
      if (!['approved', 'issued', 'report_revision'].includes(r.status)) throw new HttpError(409, 'Отчёт сейчас отправить нельзя');
      const items = itemsOf(r.id);
      if (!items.length) throw new HttpError(400, 'Добавьте купленные позиции с ценами из чека');
      const missing = items.find((i) => i.actual_price == null);
      if (missing) throw new HttpError(400, `Укажите цену по чеку для «${missing.name}»`);
      const receipts = db.prepare("SELECT COUNT(*) n FROM files WHERE request_id = ? AND kind IN ('receipt','invoice')").get(r.id).n;
      if (!receipts) throw new HttpError(400, 'Без чека или накладной отчёт не принимается. Прикрепите фото или PDF.');
      const total = actualTotal(items);
      db.prepare("UPDATE requests SET status='review', actual_total=?, reported_at=?, edit_until=?, updated_at=? WHERE id=?")
        .run(total, now, now + editMs(), now, r.id);
      logEvent(user.id, 'request', r.id, 'report_submitted', { actual_total: total, receipts });
      return;
    }
    throw new HttpError(400, 'Неизвестное действие');
  });
}

function headAction(user, id, action, body = {}) {
  if (user.role !== 'head') throw new HttpError(403, 'Только для руководителя');
  const r = loadRequest(id);
  const now = Date.now();
  const comment = str(body.comment, 1000);
  return tx(() => {
    switch (action) {
      case 'approve': {
        if (r.status !== 'pending') throw new HttpError(409, 'Согласовать можно только заявку на согласовании');
        const amt = body.approved_amount == null || body.approved_amount === '' ? r.amount : money(body.approved_amount, { allowZero: false });
        if (amt == null) throw new HttpError(400, 'Проверьте согласованную сумму');
        db.prepare("UPDATE requests SET status='approved', approved_amount=?, head_comment=?, decided_at=?, decided_by=?, updated_at=? WHERE id=?")
          .run(amt, comment, now, user.id, now, r.id);
        logEvent(user.id, 'request', r.id, 'approved', { approved_amount: amt, comment });
        break;
      }
      case 'reject':
        if (!['pending', 'revision'].includes(r.status)) throw new HttpError(409, 'Отклонить можно только заявку до согласования');
        if (!comment) throw new HttpError(400, 'Напишите причину отказа');
        db.prepare("UPDATE requests SET status='rejected', head_comment=?, decided_at=?, decided_by=?, updated_at=? WHERE id=?").run(comment, now, user.id, now, r.id);
        logEvent(user.id, 'request', r.id, 'rejected', { comment });
        break;
      case 'return':
        if (!['pending', 'review'].includes(r.status)) throw new HttpError(409, 'Вернуть на доработку сейчас нельзя');
        if (!comment) throw new HttpError(400, 'Напишите, что нужно исправить');
        db.prepare('UPDATE requests SET status=?, head_comment=?, updated_at=? WHERE id=?')
          .run(r.status === 'pending' ? 'revision' : 'report_revision', comment, now, r.id);
        logEvent(user.id, 'request', r.id, r.status === 'pending' ? 'returned' : 'report_returned', { comment });
        break;
      case 'issue': {
        if (r.status !== 'approved') throw new HttpError(409, 'Выдать деньги можно по согласованной заявке');
        const amt = money(body.issued_amount ?? r.approved_amount ?? r.amount, { allowZero: false });
        if (amt == null) throw new HttpError(400, 'Проверьте выданную сумму');
        db.prepare("UPDATE requests SET status='issued', issued_amount=?, updated_at=? WHERE id=?").run(amt, now, r.id);
        logEvent(user.id, 'request', r.id, 'issued', { issued_amount: amt, comment });
        break;
      }
      case 'close':
        if (r.status !== 'review') throw new HttpError(409, 'Провести можно только отчёт на проверке');
        db.prepare("UPDATE requests SET status='closed', closed_at=?, closed_by=?, head_comment=CASE WHEN ?<>'' THEN ? ELSE head_comment END, updated_at=? WHERE id=?")
          .run(now, user.id, comment, comment, now, r.id);
        logEvent(user.id, 'request', r.id, 'closed', { actual_total: r.actual_total, comment });
        break;
      case 'comment':
        if (!comment) throw new HttpError(400, 'Пустой комментарий');
        logEvent(user.id, 'request', r.id, 'comment', { comment });
        break;
      default:
        throw new HttpError(400, 'Неизвестное действие');
    }
  });
}

// ---------- файлы ----------
const ALLOWED = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf',
};
const MAX_FILE = 10 * 1024 * 1024;

function sniffMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.slice(4, 12).toString().startsWith('ftyphei') || buf.slice(4, 12).toString().startsWith('ftypmif')) return 'image/heic';
  return null;
}

function addFile(user, { request_id, income_id, kind, name, data }) {
  const k = ['receipt', 'invoice', 'photo', 'other'].includes(kind) ? kind : 'receipt';
  let owner;
  if (request_id) {
    const r = requestFor(user, request_id);
    if (r.user_id !== user.id) throw new HttpError(403, 'Файлы прикрепляет автор заявки');
    if (['closed', 'rejected', 'cancelled'].includes(r.status)) throw new HttpError(409, 'Заявка закрыта — файлы не добавляются');
    if (r.status === 'review' && Date.now() >= r.edit_until) throw new HttpError(423, 'Время на правку отчёта вышло. Нужен запрос на корректировку.');
    owner = { request_id: r.id, income_id: null };
  } else if (income_id) {
    const inc = incomeFor(user, income_id);
    if (inc.user_id !== user.id) throw new HttpError(403, 'Файлы прикрепляет автор записи');
    if (!(inc.status === 'new' && Date.now() < inc.edit_until)) throw new HttpError(423, 'Время на правку вышло. Нужен запрос на корректировку.');
    owner = { request_id: null, income_id: inc.id };
  } else throw new HttpError(400, 'Не указано, к чему файл');

  const b64 = String(data || '').replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new HttpError(400, 'Пустой файл');
  if (buf.length > MAX_FILE) throw new HttpError(413, 'Файл больше 10 МБ');
  const mime = sniffMime(buf);
  if (!mime) throw new HttpError(415, 'Подходят фото (JPG, PNG, WEBP, HEIC) или PDF');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const stored = `${crypto.randomBytes(16).toString('hex')}${ALLOWED[mime]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf, { mode: 0o600 });
  const dup = db.prepare('SELECT id, request_id, income_id FROM files WHERE sha256 = ? LIMIT 1').get(sha256);
  const res = db.prepare(`INSERT INTO files (request_id, income_id, user_id, kind, orig_name, mime, size, stored, sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(owner.request_id, owner.income_id, user.id, k, str(name, 120) || `файл${ALLOWED[mime]}`, mime, buf.length, stored, sha256, Date.now());
  const fid = Number(res.lastInsertRowid);
  logEvent(user.id, owner.request_id ? 'request' : 'income', owner.request_id || owner.income_id, 'file_added',
    { file_id: fid, kind: k, name: str(name, 120), duplicate_of: dup ? (dup.request_id ? reqNumber(dup.request_id) : incNumber(dup.income_id)) : null });
  return fid;
}

function fileFor(user, id) {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(id));
  if (!f) throw new HttpError(404, 'Файл не найден');
  const ownerId = f.request_id ? loadRequest(f.request_id).user_id : loadIncome(f.income_id).user_id;
  if (!canSee(user, ownerId)) throw new HttpError(404, 'Файл не найден');
  return f;
}

function removeFile(user, id) {
  const f = fileFor(user, id);
  if (f.user_id !== user.id) throw new HttpError(403, 'Удалить файл может только тот, кто его добавил');
  if (f.request_id) {
    const r = loadRequest(f.request_id);
    if (!(['approved', 'issued', 'report_revision', 'pending', 'revision'].includes(r.status) || (r.status === 'review' && Date.now() < r.edit_until)))
      throw new HttpError(423, 'Файл уже нельзя удалить');
  } else {
    const inc = loadIncome(f.income_id);
    if (!(inc.status === 'new' && Date.now() < inc.edit_until)) throw new HttpError(423, 'Файл уже нельзя удалить');
  }
  // Сам файл остаётся на диске (для истории), отвязываем его и пишем в журнал.
  db.prepare('UPDATE files SET request_id = NULL, income_id = NULL, kind = ? WHERE id = ?').run('removed', f.id);
  logEvent(user.id, f.request_id ? 'request' : 'income', f.request_id || f.income_id, 'file_removed', { file_id: f.id, name: f.orig_name });
}

// ---------- доходы ----------
function loadIncome(id) {
  const r = db.prepare('SELECT * FROM incomes WHERE id = ?').get(Number(id));
  if (!r) throw new HttpError(404, 'Запись не найдена');
  return r;
}
function incomeFor(user, id) {
  const r = loadIncome(id);
  if (!canSee(user, r.user_id)) throw new HttpError(404, 'Запись не найдена');
  return r;
}
function incomeFields(body, settings) {
  const f = {
    date: isDate(str(body.date, 10)) ? str(body.date, 10) : '',
    title: str(body.title, 200),
    client: str(body.client, 160),
    object: str(body.object, 120),
    category: str(body.category, 60),
    amount: money(body.amount, { allowZero: false }),
    method: ['cash', 'card', 'account'].includes(body.method) ? body.method : 'account',
    comment: str(body.comment, 1000),
  };
  if (!f.date) throw new HttpError(400, 'Укажите дату');
  if (!f.title) throw new HttpError(400, 'Напишите, что продали или за что оплата');
  if (f.amount == null) throw new HttpError(400, 'Укажите сумму');
  if (f.object && !settings.objects.includes(f.object)) throw new HttpError(400, 'Выберите объект из списка');
  if (f.category && !settings.income_categories.includes(f.category)) throw new HttpError(400, 'Выберите категорию из списка');
  return f;
}
function createIncome(user, body) {
  const f = incomeFields(body, getSettings());
  const now = Date.now();
  const r = db.prepare(`INSERT INTO incomes (date, title, client, object, category, amount, method, comment, user_id, edit_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(f.date, f.title, f.client, f.object, f.category, f.amount, f.method, f.comment, user.id, now + editMs(), now, now);
  const id = Number(r.lastInsertRowid);
  logEvent(user.id, 'income', id, 'created', { amount: f.amount });
  return id;
}
function updateIncome(user, id, body) {
  const inc = incomeFor(user, id);
  if (inc.user_id !== user.id) throw new HttpError(403, 'Изменять запись может только её автор');
  if (!(inc.status === 'new' && Date.now() < inc.edit_until)) throw new HttpError(423, 'Время на правку вышло. Отправьте запрос на корректировку руководителю.');
  const f = incomeFields({ ...inc, ...body }, getSettings());
  const changes = diffFields(inc, f, Object.keys(f));
  if (!changes.length) return { changed: false };
  db.prepare('UPDATE incomes SET date=?, title=?, client=?, object=?, category=?, amount=?, method=?, comment=?, updated_at=? WHERE id=?')
    .run(f.date, f.title, f.client, f.object, f.category, f.amount, f.method, f.comment, Date.now(), inc.id);
  logEvent(user.id, 'income', inc.id, 'edited', { changes });
  return { changed: true };
}
function headIncomeAction(user, id, action, body = {}) {
  if (user.role !== 'head') throw new HttpError(403, 'Только для руководителя');
  const inc = loadIncome(id);
  const comment = str(body.comment, 1000);
  const now = Date.now();
  if (action === 'confirm') {
    if (inc.status !== 'new') throw new HttpError(409, 'Запись уже обработана');
    db.prepare("UPDATE incomes SET status='confirmed', head_comment=?, decided_at=?, decided_by=?, updated_at=? WHERE id=?").run(comment, now, user.id, now, inc.id);
  } else if (action === 'reject') {
    if (inc.status !== 'new') throw new HttpError(409, 'Запись уже обработана');
    if (!comment) throw new HttpError(400, 'Напишите причину');
    db.prepare("UPDATE incomes SET status='rejected', head_comment=?, decided_at=?, decided_by=?, updated_at=? WHERE id=?").run(comment, now, user.id, now, inc.id);
  } else if (action === 'comment') {
    if (!comment) throw new HttpError(400, 'Пустой комментарий');
  } else throw new HttpError(400, 'Неизвестное действие');
  logEvent(user.id, 'income', inc.id, action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : 'comment', { comment });
}

// ---------- корректировки ----------
function requestCorrection(user, body) {
  const entity = body.entity === 'income' ? 'income' : 'request';
  const obj = entity === 'income' ? incomeFor(user, body.id) : requestFor(user, body.id);
  if (obj.user_id !== user.id) throw new HttpError(403, 'Запросить корректировку может только автор');
  const reason = str(body.reason, 1000);
  if (reason.length < 5) throw new HttpError(400, 'Опишите, что и почему нужно исправить');
  if (['rejected', 'cancelled'].includes(obj.status)) throw new HttpError(409, 'Запись закрыта');
  const open = db.prepare("SELECT id FROM corrections WHERE entity=? AND entity_id=? AND status='pending'").get(entity, obj.id);
  if (open) throw new HttpError(409, 'Запрос на корректировку уже отправлен — ждите решения');
  const r = db.prepare('INSERT INTO corrections (entity, entity_id, user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(entity, obj.id, user.id, reason, Date.now());
  logEvent(user.id, entity, obj.id, 'correction_requested', { reason });
  return Number(r.lastInsertRowid);
}
function decideCorrection(user, id, approve, comment) {
  if (user.role !== 'head') throw new HttpError(403, 'Только для руководителя');
  const c = db.prepare('SELECT * FROM corrections WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'Запрос не найден');
  if (c.status !== 'pending') throw new HttpError(409, 'Запрос уже рассмотрен');
  const now = Date.now();
  const until = now + editMs();
  tx(() => {
    db.prepare('UPDATE corrections SET status=?, decided_at=?, decided_by=?, decision_comment=? WHERE id=?')
      .run(approve ? 'approved' : 'rejected', now, user.id, str(comment, 1000), c.id);
    if (approve) {
      if (c.entity === 'income') {
        db.prepare("UPDATE incomes SET status='new', edit_until=?, updated_at=? WHERE id=?").run(until, now, c.entity_id);
      } else {
        const r = loadRequest(c.entity_id);
        // Проведённый отчёт возвращается на проверку; остальное — просто открывается на правку.
        const status = r.status === 'closed' ? 'review' : r.status;
        db.prepare('UPDATE requests SET status=?, edit_until=?, closed_at = CASE WHEN ?=\'review\' AND status=\'closed\' THEN NULL ELSE closed_at END, updated_at=? WHERE id=?')
          .run(status, until, status, now, r.id);
      }
    }
    logEvent(user.id, c.entity, c.entity_id, approve ? 'correction_approved' : 'correction_rejected', { comment: str(comment, 1000), until: approve ? until : null });
  });
}

// ---------- проверки (флаги) ----------
// История цен по товару: проведённые заявки, кроме текущей.
function priceHistory(key, excludeId) {
  return db.prepare(`SELECT i.qty, i.price, i.actual_price, r.id rid, r.closed_at, r.user_id, u.name user_name, i.shop
    FROM request_items i JOIN requests r ON r.id = i.request_id JOIN users u ON u.id = r.user_id
    WHERE i.name_key = ? AND r.status = 'closed' AND r.id != ? ORDER BY r.closed_at DESC LIMIT 50`).all(key, excludeId || 0)
    .map((h) => ({ ...h, unit_price: h.actual_price ?? h.price }))
    .filter((h) => h.unit_price > 0);
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function flagsForRequest(r, items, files, settings = getSettings()) {
  const flags = [];
  const pct = Number(settings.price_alert_pct) || 15;
  for (const i of items) {
    const hist = priceHistory(i.name_key, r.id);
    const med = median(hist.map((h) => h.unit_price));
    i.history = { count: hist.length, median: med, min: hist.length ? Math.min(...hist.map((h) => h.unit_price)) : null, last: hist[0]?.unit_price ?? null };
    const cur = i.actual_price ?? i.price;
    if (med && cur > med * (1 + pct / 100)) {
      i.price_flag = round2((cur / med - 1) * 100);
      flags.push({ level: i.price_flag > pct * 2 ? 'high' : 'mid', code: 'price_high', text: `«${i.name}»: ${fm(cur)} за ед. — на ${Math.round(i.price_flag)}% выше обычной цены (${fm(med)}, по ${hist.length} покуп.)` });
    }
    if (i.actual_price != null && i.price > 0 && r.kind === 'purchase' && i.actual_price > i.price * (1 + pct / 100)) {
      flags.push({ level: 'mid', code: 'item_over_plan', text: `«${i.name}»: по чеку ${fm(i.actual_price)}, в заявке было ${fm(i.price)}` });
    }
  }
  if (r.kind === 'purchase' && r.channel === 'online' && items.some((i) => !i.url)) flags.push({ level: 'mid', code: 'no_link', text: 'Онлайн-покупка без ссылки на товар' });
  const base = r.approved_amount ?? r.amount;
  const over = Number(settings.overspend_alert_pct) || 10;
  if (r.actual_total != null && base > 0 && r.actual_total > base * (1 + over / 100)) {
    flags.push({ level: 'high', code: 'overspend', text: `Потрачено ${fm(r.actual_total)} при согласованных ${fm(base)} (+${Math.round((r.actual_total / base - 1) * 100)}%)` });
  }
  const receipts = files.filter((f) => ['receipt', 'invoice'].includes(f.kind));
  if (['review', 'closed'].includes(r.status) && !receipts.length) flags.push({ level: 'high', code: 'no_receipt', text: 'Нет чека или накладной' });
  for (const f of files) {
    const dup = db.prepare(`SELECT request_id, income_id FROM files WHERE sha256 = ? AND id != ? AND (request_id IS NOT NULL OR income_id IS NOT NULL) AND COALESCE(request_id, -1) != ? LIMIT 1`)
      .get(f.sha256, f.id, r.id);
    if (dup) flags.push({ level: 'high', code: 'dup_receipt', text: `Файл «${f.orig_name}» уже прикреплён к ${dup.request_id ? 'заявке ' + reqNumber(dup.request_id) : 'доходу ' + incNumber(dup.income_id)}` });
    if (f.ai_json && r.actual_total != null) {
      try {
        const ai = JSON.parse(f.ai_json);
        const aiTotal = Number(ai.total);
        if (aiTotal > 0 && receipts.length === 1 && Math.abs(aiTotal - r.actual_total) > Math.max(1, aiTotal * 0.03)) {
          flags.push({ level: 'high', code: 'ai_mismatch', text: `ИИ прочитал в чеке ${fm(aiTotal)}, а в отчёте указано ${fm(r.actual_total)}` });
        }
      } catch { /* битый json */ }
    }
  }
  if (r.changed_after_approval) flags.push({ level: 'mid', code: 'changed_after_approval', text: 'Заявку меняли после согласования (см. историю)' });
  if (r.status === 'issued') {
    const issuedEv = db.prepare("SELECT ts FROM events WHERE entity='request' AND entity_id=? AND action='issued' ORDER BY id DESC LIMIT 1").get(r.id);
    if (issuedEv && Date.now() - issuedEv.ts > 7 * 864e5) flags.push({ level: 'mid', code: 'late_report', text: 'Деньги выданы больше 7 дней назад, отчёта нет' });
  }
  const edits = db.prepare("SELECT COUNT(*) n FROM events WHERE entity='request' AND entity_id=? AND action='report_edited'").get(r.id).n;
  if (edits) flags.push({ level: 'low', code: 'report_edited', text: `Отчёт правили после отправки (${edits} раз)` });
  return flags;
}

module.exports = {
  HttpError, STATUS, INCOME_STATUS, str, money, round2, isDate, reqNumber, incNumber, median,
  canSee, loadRequest, requestFor, canEditPlan, canEditReport, itemsOf, planTotal, actualTotal,
  createRequest, updateRequest, staffAction, headAction,
  addFile, fileFor, removeFile, ALLOWED,
  loadIncome, incomeFor, createIncome, updateIncome, headIncomeAction,
  requestCorrection, decideCorrection,
  priceHistory, flagsForRequest,
};
