'use strict';
// БХ Учёт — сервер. Node 22+, без фреймворков: node:http + node:sqlite.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { db, UPLOAD_DIR, getSettings, setSetting, logEvent, DEFAULT_SETTINGS } = require('./db');
const auth = require('./auth');
const L = require('./logic');
const A = require('./analytics');
const ai = require('./ai');

const { HttpError, str } = L;
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 15 * 1024 * 1024;
const VERSION = require('../package.json').version;
const CURRENCY = process.env.CURRENCY || '₴';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(self)',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

// ---------- первый запуск: учётная запись руководителя ----------
function bootstrap() {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (n) return;
  const login = str(process.env.HEAD_LOGIN || 'head', 40);
  let password = process.env.HEAD_PASSWORD;
  let generated = false;
  if (!password || auth.passwordProblem(password)) { password = auth.randomPassword(); generated = true; }
  db.prepare('INSERT INTO users (login, name, position, role, pass_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(login, process.env.HEAD_NAME || 'Руководитель БХ', 'Руководитель подразделения', 'head', auth.hashPassword(password), generated ? 1 : 0, Date.now());
  logEvent(null, 'user', 1, 'bootstrap', { login });
  console.log('\n  ┌──────────────────────────────────────────────');
  console.log(`  │ Создан руководитель: логин «${login}»`);
  if (generated) console.log(`  │ Временный пароль: ${password}  (сменить при первом входе)`);
  else console.log('  │ Пароль — из переменной HEAD_PASSWORD');
  console.log('  └──────────────────────────────────────────────\n');
}

// ---------- помощники ----------
function send(res, status, data, req, headers = {}) {
  const json = JSON.stringify(data);
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers };
  if (req && json.length > 4096 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.writeHead(status, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(zlib.gzipSync(json));
  }
  res.writeHead(status, h);
  res.end(json);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Некорректный запрос')); }
    });
    req.on('error', reject);
  });
}
const needUser = (u) => { if (!u) throw new HttpError(401, 'Войдите в систему'); if (u.must_change_pw) throw new HttpError(428, 'Сначала смените временный пароль'); return u; };
const needHead = (u) => { needUser(u); if (u.role !== 'head') throw new HttpError(403, 'Раздел только для руководителя'); return u; };
const publicUser = (u) => u && ({ id: u.id, login: u.login, name: u.name, position: u.position, phone: u.phone, role: u.role, must_change_pw: !!u.must_change_pw });

// ---------- представление записей ----------
const userName = (id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || '' : '');

function requestRow(r) {
  return {
    id: r.id, number: L.reqNumber(r.id), kind: r.kind, channel: r.channel, title: r.title, object: r.object, category: r.category,
    status: r.status, status_text: L.STATUS[r.status], amount: r.amount, approved_amount: r.approved_amount, issued_amount: r.issued_amount,
    actual_total: r.actual_total, user_id: r.user_id, user_name: r.user_name, created_at: r.created_at, updated_at: r.updated_at,
    needed_by: r.needed_by, edit_until: r.edit_until, changed_after_approval: !!r.changed_after_approval, items_count: r.items_count,
    receipts: r.receipts, delivery_total: r.delivery_total || 0,
  };
}
function listRequests(user, q) {
  const where = []; const args = [];
  if (user.role !== 'head' || q.mine === '1') { where.push('r.user_id = ?'); args.push(user.id); }
  if (user.role === 'head' && q.user) { where.push('r.user_id = ?'); args.push(Number(q.user)); }
  const groups = {
    active: ['pending', 'revision', 'approved', 'issued', 'review', 'report_revision'],
    todo_head: ['pending', 'review'], todo_staff: ['revision', 'approved', 'issued', 'report_revision'],
    done: ['closed'], off: ['rejected', 'cancelled'],
  };
  if (q.status && groups[q.status]) { where.push(`r.status IN (${groups[q.status].map(() => '?').join(',')})`); args.push(...groups[q.status]); }
  else if (q.status && L.STATUS[q.status]) { where.push('r.status = ?'); args.push(q.status); }
  if (q.kind === 'purchase' || q.kind === 'money') { where.push('r.kind = ?'); args.push(q.kind); }
  if (q.object) { where.push('r.object = ?'); args.push(String(q.object)); }
  if (q.q) {
    const term = `%${String(q.q).toLowerCase().slice(0, 80)}%`;
    where.push("(LOWER(r.title) LIKE ? OR LOWER(r.purpose) LIKE ? OR EXISTS (SELECT 1 FROM request_items i WHERE i.request_id = r.id AND i.name_key LIKE ?) OR printf('з-%05d', r.id) LIKE ?)");
    args.push(term, term, term, term);
  }
  if (L.isDate(q.from || '')) { where.push('r.created_at >= ?'); args.push(Date.parse(`${q.from}T00:00:00`)); }
  if (L.isDate(q.to || '')) { where.push('r.created_at < ?'); args.push(Date.parse(`${q.to}T00:00:00`) + 864e5); }
  const limit = Math.min(500, Number(q.limit) || 200);
  const rows = db.prepare(`SELECT r.*, u.name user_name,
      (SELECT COUNT(*) FROM request_items i WHERE i.request_id = r.id) items_count,
      (SELECT COUNT(*) FROM files f WHERE f.request_id = r.id AND f.kind IN ('receipt','invoice')) receipts,
      (SELECT COALESCE(SUM(d.amount),0) FROM deliveries d WHERE d.request_id = r.id AND d.removed_at IS NULL) delivery_total
    FROM requests r JOIN users u ON u.id = r.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.updated_at DESC LIMIT ${limit}`).all(...args);
  const counts = {};
  const cw = user.role !== 'head' ? 'WHERE user_id = ?' : '';
  for (const c of db.prepare(`SELECT status, COUNT(*) n FROM requests ${cw} GROUP BY status`).all(...(cw ? [user.id] : []))) counts[c.status] = c.n;
  return { items: rows.map(requestRow), counts };
}

function eventsOf(entity, id) {
  return db.prepare('SELECT e.*, u.name user_name FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.entity = ? AND e.entity_id = ? ORDER BY e.id').all(entity, id)
    .map((e) => ({ id: e.id, ts: e.ts, user_name: e.user_name, action: e.action, data: JSON.parse(e.data || '{}') }));
}
function filesOf(col, id) {
  return db.prepare(`SELECT id, kind, orig_name, mime, size, created_at, ai_json, user_id, sha256 FROM files WHERE ${col} = ? AND kind != 'removed' ORDER BY id`).all(id)
    .map((f) => ({ ...f, ai: f.ai_json ? JSON.parse(f.ai_json) : null, ai_json: undefined }));
}
function correctionsOf(entity, id) {
  return db.prepare('SELECT c.*, u.name user_name, d.name decided_name FROM corrections c JOIN users u ON u.id = c.user_id LEFT JOIN users d ON d.id = c.decided_by WHERE c.entity = ? AND c.entity_id = ? ORDER BY c.id DESC').all(entity, id);
}

function requestDetail(user, id) {
  const r = L.requestFor(user, id);
  const items = L.itemsOf(r.id);
  const files = filesOf('request_id', r.id);
  const now = Date.now();
  const out = {
    ...requestRow({ ...r, user_name: userName(r.user_id) }),
    purpose: r.purpose, head_comment: r.head_comment, returned_amount: r.returned_amount,
    decided_at: r.decided_at, decided_by_name: userName(r.decided_by), reported_at: r.reported_at, closed_at: r.closed_at, closed_by_name: userName(r.closed_by),
    items: items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, price: i.price, url: i.url, shop: i.shop, actual_qty: i.actual_qty, actual_price: i.actual_price })),
    files: files.map((f) => ({ ...f, sha256: undefined })),
    events: eventsOf('request', r.id),
    corrections: correctionsOf('request', r.id),
    deliveries: L.deliveriesOf(r.id).map((d) => ({ ...d, paid_by_text: L.PAID_BY[d.paid_by], can_remove: user.role === 'head' || (d.user_id === user.id && now - d.created_at < Number(getSettings().edit_hours || 2) * 3600e3) })),
    delivery_total: L.deliveryTotal(r.id),
    can_add_delivery: L.canAddDelivery(user, r),
    mine: r.user_id === user.id,
    can_edit_plan: r.user_id === user.id && L.canEditPlan(r, now),
    can_edit_report: r.user_id === user.id && L.canEditReport(r, now),
    now,
  };
  if (user.role === 'head') {
    out.flags = L.flagsForRequest(r, items, files);
    out.items = out.items.map((i, k) => ({ ...i, history: items[k].history, price_flag: items[k].price_flag || 0 }));
  }
  return out;
}

function listIncomes(user, q) {
  const where = []; const args = [];
  if (user.role !== 'head') { where.push('i.user_id = ?'); args.push(user.id); }
  if (['new', 'confirmed', 'rejected'].includes(q.status)) { where.push('i.status = ?'); args.push(q.status); }
  if (L.isDate(q.from || '')) { where.push('i.date >= ?'); args.push(q.from); }
  if (L.isDate(q.to || '')) { where.push('i.date <= ?'); args.push(q.to); }
  if (q.q) { const t = `%${String(q.q).toLowerCase().slice(0, 80)}%`; where.push('(LOWER(i.title) LIKE ? OR LOWER(i.client) LIKE ?)'); args.push(t, t); }
  const rows = db.prepare(`SELECT i.*, u.name user_name, (SELECT COUNT(*) FROM files f WHERE f.income_id = i.id AND f.kind != 'removed') files
    FROM incomes i JOIN users u ON u.id = i.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.date DESC, i.id DESC LIMIT 500`).all(...args);
  const sum = rows.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.amount, 0);
  return { items: rows.map((r) => ({ ...r, number: L.incNumber(r.id), status_text: L.INCOME_STATUS[r.status] })), confirmed_sum: L.round2(sum) };
}
function incomeDetail(user, id) {
  const inc = L.incomeFor(user, id);
  return {
    ...inc, number: L.incNumber(inc.id), status_text: L.INCOME_STATUS[inc.status], user_name: userName(inc.user_id), decided_by_name: userName(inc.decided_by),
    files: filesOf('income_id', inc.id).map((f) => ({ ...f, sha256: undefined })), events: eventsOf('income', inc.id), corrections: correctionsOf('income', inc.id),
    mine: inc.user_id === user.id, can_edit: inc.user_id === user.id && inc.status === 'new' && Date.now() < inc.edit_until, now: Date.now(),
  };
}

function staffHome(user) {
  const mine = (statuses) => db.prepare(`SELECT r.*, u.name user_name FROM requests r JOIN users u ON u.id = r.user_id WHERE r.user_id = ? AND r.status IN (${statuses.map(() => '?').join(',')}) ORDER BY r.updated_at DESC`).all(user.id, ...statuses).map(requestRow);
  const month = new Date(); const mStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
  const spent = db.prepare("SELECT COALESCE(SUM(actual_total),0) s, COUNT(*) n FROM requests WHERE user_id=? AND status='closed' AND closed_at >= ?").get(user.id, mStart);
  spent.s += db.prepare('SELECT COALESCE(SUM(amount),0) s FROM delivery_costs WHERE req_user = ? AND ts >= ?').get(user.id, mStart).s;
  const inc = db.prepare("SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM incomes WHERE user_id=? AND status='confirmed' AND date >= ?").get(user.id, new Date(mStart).toISOString().slice(0, 10));
  const adv = A.advances(user.id)[0];
  return {
    todo: mine(['revision', 'approved', 'issued', 'report_revision']),
    waiting: mine(['pending', 'review']),
    advance: adv ? { balance: adv.balance, open_count: adv.open_count } : { balance: 0, open_count: 0 },
    month: { spent: L.round2(spent.s), spent_n: spent.n, income: L.round2(inc.s), income_n: inc.n },
    corrections: db.prepare("SELECT c.*, CASE c.entity WHEN 'request' THEN printf('З-%05d', c.entity_id) ELSE printf('Д-%05d', c.entity_id) END number FROM corrections c WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 5").all(user.id),
  };
}
function headHome() {
  const q = (statuses) => db.prepare(`SELECT r.*, u.name user_name FROM requests r JOIN users u ON u.id = r.user_id WHERE r.status IN (${statuses.map(() => '?').join(',')}) ORDER BY r.updated_at ASC LIMIT 50`).all(...statuses).map(requestRow);
  return {
    to_approve: q(['pending']),
    to_close: q(['review']),
    incomes: db.prepare("SELECT i.*, u.name user_name FROM incomes i JOIN users u ON u.id = i.user_id WHERE i.status='new' ORDER BY i.id LIMIT 50").all().map((i) => ({ ...i, number: L.incNumber(i.id) })),
    corrections: db.prepare(`SELECT c.*, u.name user_name, CASE c.entity WHEN 'request' THEN printf('З-%05d', c.entity_id) ELSE printf('Д-%05d', c.entity_id) END number
      FROM corrections c JOIN users u ON u.id = c.user_id WHERE c.status='pending' ORDER BY c.id`).all(),
    overview: A.overview({}),
  };
}

function eventsFeed(q) {
  const where = []; const args = [];
  if (q.entity) { where.push('e.entity = ?'); args.push(String(q.entity)); }
  if (q.user) { where.push('e.user_id = ?'); args.push(Number(q.user)); }
  if (q.before) { where.push('e.id < ?'); args.push(Number(q.before)); }
  if (q.action) { where.push('e.action = ?'); args.push(String(q.action)); }
  const rows = db.prepare(`SELECT e.*, u.name user_name FROM events e LEFT JOIN users u ON u.id = e.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT 100`).all(...args);
  return rows.map((e) => ({ id: e.id, ts: e.ts, user_name: e.user_name, entity: e.entity, entity_id: e.entity_id, action: e.action, data: JSON.parse(e.data || '{}'),
    number: e.entity === 'request' ? L.reqNumber(e.entity_id) : e.entity === 'income' ? L.incNumber(e.entity_id) : null }));
}

// ---------- сотрудники ----------
function listUsers() {
  return db.prepare(`SELECT u.id, u.login, u.name, u.position, u.phone, u.role, u.active, u.must_change_pw, u.created_at, u.last_login,
      (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id) requests,
      (SELECT COALESCE(SUM(actual_total),0) FROM requests r WHERE r.user_id = u.id AND r.status='closed')
        + (SELECT COALESCE(SUM(amount),0) FROM delivery_costs d WHERE d.req_user = u.id) spent
    FROM users u ORDER BY u.active DESC, u.role, u.name`).all().map((u) => ({ ...u, spent: L.round2(u.spent) }));
}
function createUser(head, body) {
  const login = str(body.login, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(login)) throw new HttpError(400, 'Логин: латиница, цифры, точка, дефис — от 3 символов');
  if (db.prepare('SELECT id FROM users WHERE login = ?').get(login)) throw new HttpError(409, 'Такой логин уже есть');
  const name = str(body.name, 100);
  if (!name) throw new HttpError(400, 'Укажите имя');
  const role = body.role === 'head' ? 'head' : 'staff';
  const password = auth.randomPassword();
  const r = db.prepare('INSERT INTO users (login, name, position, phone, role, pass_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(login, name, str(body.position, 100), str(body.phone, 30), role, auth.hashPassword(password), Date.now());
  const id = Number(r.lastInsertRowid);
  logEvent(head.id, 'user', id, 'user_created', { login, name, role });
  return { id, login, password };
}
function updateUser(head, id, body) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) throw new HttpError(404, 'Сотрудник не найден');
  const next = {
    name: body.name !== undefined ? str(body.name, 100) || u.name : u.name,
    position: body.position !== undefined ? str(body.position, 100) : u.position,
    phone: body.phone !== undefined ? str(body.phone, 30) : u.phone,
    role: body.role === 'head' || body.role === 'staff' ? body.role : u.role,
    active: body.active === undefined ? u.active : body.active ? 1 : 0,
  };
  if (u.id === head.id && (next.role !== 'head' || !next.active)) throw new HttpError(400, 'Нельзя снять права или отключить самого себя');
  if (u.role === 'head' && (next.role !== 'head' || !next.active)) {
    const heads = db.prepare("SELECT COUNT(*) n FROM users WHERE role='head' AND active=1").get().n;
    if (heads <= 1) throw new HttpError(400, 'Должен остаться хотя бы один руководитель');
  }
  db.prepare('UPDATE users SET name=?, position=?, phone=?, role=?, active=? WHERE id=?').run(next.name, next.position, next.phone, next.role, next.active, u.id);
  if (!next.active || next.role !== u.role) auth.destroyUserSessions(u.id);
  const changes = Object.keys(next).filter((k) => String(next[k]) !== String(u[k])).map((k) => ({ field: k, from: u[k], to: next[k] }));
  if (changes.length) logEvent(head.id, 'user', u.id, 'user_updated', { changes });
}
function resetPassword(head, id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) throw new HttpError(404, 'Сотрудник не найден');
  const password = auth.randomPassword();
  db.prepare('UPDATE users SET pass_hash = ?, must_change_pw = 1 WHERE id = ?').run(auth.hashPassword(password), u.id);
  auth.destroyUserSessions(u.id);
  logEvent(head.id, 'user', u.id, 'password_reset', {});
  return { login: u.login, password };
}

// ---------- настройки ----------
function updateSettings(head, body) {
  const changes = [];
  const cur = getSettings();
  const list = (v, max) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, 120)).filter(Boolean))].slice(0, max);
  const num = (v, a, b) => { const n = Number(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : null; };
  const plan = {
    edit_hours: num(body.edit_hours, 0.25, 72),
    price_alert_pct: num(body.price_alert_pct, 1, 500),
    overspend_alert_pct: num(body.overspend_alert_pct, 0, 500),
    categories: body.categories && list(body.categories, 60),
    income_categories: body.income_categories && list(body.income_categories, 40),
    objects: body.objects && list(body.objects, 200),
    units: body.units && list(body.units, 30),
  };
  for (const [k, v] of Object.entries(plan)) {
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    if (JSON.stringify(cur[k]) !== JSON.stringify(v)) { setSetting(k, v); changes.push({ field: k, from: cur[k], to: v }); }
  }
  if (changes.length) logEvent(head.id, 'settings', null, 'settings_updated', { changes });
  return getSettings();
}

// ---------- выгрузка CSV ----------
function csv(rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
}
function exportCsv(q) {
  const d = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU') : '');
  const nf = (n) => (n == null ? '' : String(n).replace('.', ','));
  if (q.type === 'incomes') {
    const rows = listIncomes({ role: 'head' }, q).items;
    return csv([['Номер', 'Дата', 'Что', 'Клиент', 'Объект', 'Категория', 'Сумма', 'Оплата', 'Статус', 'Внёс'],
      ...rows.map((r) => [r.number, r.date, r.title, r.client, r.object, r.category, nf(r.amount), r.method, r.status_text, r.user_name])]);
  }
  if (q.type === 'items') {
    const rows = db.prepare(`SELECT r.id, r.closed_at, r.object, r.category, u.name, i.name item, i.qty, i.unit, i.price, i.actual_qty, i.actual_price, i.shop, i.url
      FROM request_items i JOIN requests r ON r.id = i.request_id JOIN users u ON u.id = r.user_id WHERE r.status='closed' ORDER BY r.closed_at DESC`).all();
    return csv([['Заявка', 'Проведено', 'Объект', 'Категория', 'Сотрудник', 'Товар', 'Кол-во', 'Ед.', 'Цена в заявке', 'Кол-во по чеку', 'Цена по чеку', 'Магазин', 'Ссылка'],
      ...rows.map((r) => [L.reqNumber(r.id), d(r.closed_at), r.object, r.category, r.name, r.item, nf(r.qty), r.unit, nf(r.price), nf(r.actual_qty), nf(r.actual_price), r.shop, r.url])]);
  }
  const rows = listRequests({ role: 'head' }, { ...q, limit: 500 }).items;
  return csv([['Номер', 'Создана', 'Тип', 'Что', 'Объект', 'Категория', 'Сотрудник', 'Статус', 'По заявке', 'Согласовано', 'Выдано', 'Факт по чекам', 'Доставка'],
    ...rows.map((r) => [r.number, d(r.created_at), r.kind === 'money' ? 'Деньги под отчёт' : `Покупка ${r.channel === 'offline' ? 'офлайн' : 'онлайн'}`,
      r.title, r.object, r.category, r.user_name, r.status_text, nf(r.amount), nf(r.approved_amount), nf(r.issued_amount), nf(r.actual_total), nf(r.delivery_total)])]);
}

// ---------- маршруты ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const q = Object.fromEntries(url.searchParams);
  const user = auth.userFromRequest(req);
  const body = m === 'GET' || m === 'HEAD' ? {} : await readBody(req);
  const ok = (data = { ok: true }, headers) => send(res, 200, data, req, headers);
  let mt;

  // Защита от подделки запросов: все изменяющие запросы — только из нашего интерфейса.
  if (m !== 'GET' && req.headers['x-bh'] !== '1') throw new HttpError(403, 'Запрос отклонён');

  if (p === '/api/meta' && m === 'GET') return ok({ version: VERSION, currency: CURRENCY, ai: ai.enabled() });

  if (p === '/api/login' && m === 'POST') {
    const login = str(body.login, 60);
    if (auth.loginBlocked(login, req)) throw new HttpError(429, 'Слишком много попыток. Подождите 15 минут.');
    const r = auth.login(login, String(body.password || ''), req);
    if (!r) throw new HttpError(401, 'Неверный логин или пароль');
    return ok({ user: publicUser(r.user) }, { 'Set-Cookie': auth.cookie(r.token, auth.SESSION_HOURS * 3600) });
  }
  if (p === '/api/logout' && m === 'POST') {
    if (user) { auth.destroySession(user.token); logEvent(user.id, 'auth', user.id, 'logout', {}); }
    return ok({ ok: true }, { 'Set-Cookie': auth.cookie('', 0) });
  }
  if (p === '/api/me' && m === 'GET') return ok({ user: publicUser(user) });
  if (p === '/api/me/password' && m === 'POST') {
    if (!user) throw new HttpError(401, 'Войдите в систему');
    const full = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(String(body.current || ''), full.pass_hash)) throw new HttpError(400, 'Текущий пароль неверный');
    const problem = auth.passwordProblem(body.next);
    if (problem) throw new HttpError(400, problem);
    if (body.next === body.current) throw new HttpError(400, 'Новый пароль должен отличаться от текущего');
    db.prepare('UPDATE users SET pass_hash = ?, must_change_pw = 0 WHERE id = ?').run(auth.hashPassword(body.next), user.id);
    auth.destroyUserSessions(user.id, user.token);
    logEvent(user.id, 'auth', user.id, 'password_changed', {});
    return ok();
  }

  needUser(user);
  if (p === '/api/settings' && m === 'GET') { const s = getSettings(); return ok({ ...s, currency: CURRENCY, ai: ai.enabled() }); }
  if (p === '/api/home' && m === 'GET') return ok(user.role === 'head' ? headHome() : staffHome(user));

  // заявки
  if (p === '/api/requests' && m === 'GET') return ok(listRequests(user, q));
  if (p === '/api/requests' && m === 'POST') return ok({ id: L.createRequest(user, body) });
  if ((mt = p.match(/^\/api\/requests\/(\d+)$/))) {
    if (m === 'GET') return ok(requestDetail(user, mt[1]));
    if (m === 'PUT') { const r = L.updateRequest(user, mt[1], body); return ok({ ...r, request: requestDetail(user, mt[1]) }); }
  }
  if ((mt = p.match(/^\/api\/requests\/(\d+)\/action$/)) && m === 'POST') {
    const a = String(body.action || '');
    if (['resubmit', 'cancel', 'submit_report'].includes(a)) L.staffAction(user, mt[1], a, body);
    else L.headAction(user, mt[1], a, body);
    return ok({ request: requestDetail(user, mt[1]) });
  }

  // файлы
  if (p === '/api/files' && m === 'POST') return ok({ id: L.addFile(user, body) });
  if ((mt = p.match(/^\/api\/files\/(\d+)$/))) {
    const f = L.fileFor(user, mt[1]);
    if (m === 'GET') {
      if (f.kind === 'removed') throw new HttpError(404, 'Файл не найден');
      const file = path.join(UPLOAD_DIR, path.basename(f.stored));
      const disp = q.download === '1' ? 'attachment' : 'inline';
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': f.mime, 'Content-Length': f.size, 'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(f.orig_name)}`, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' });
      return fs.createReadStream(file).pipe(res);
    }
    if (m === 'DELETE') { L.removeFile(user, mt[1]); return ok(); }
  }
  if ((mt = p.match(/^\/api\/files\/(\d+)\/ai$/)) && m === 'POST') {
    L.fileFor(user, mt[1]);
    return ok({ result: await ai.parseReceipt(user, mt[1]) });
  }

  // доходы
  if (p === '/api/incomes' && m === 'GET') return ok(listIncomes(user, q));
  if (p === '/api/incomes' && m === 'POST') return ok({ id: L.createIncome(user, body) });
  if ((mt = p.match(/^\/api\/incomes\/(\d+)$/))) {
    if (m === 'GET') return ok(incomeDetail(user, mt[1]));
    if (m === 'PUT') { L.updateIncome(user, mt[1], body); return ok({ income: incomeDetail(user, mt[1]) }); }
  }
  if ((mt = p.match(/^\/api\/incomes\/(\d+)\/action$/)) && m === 'POST') {
    L.headIncomeAction(user, mt[1], String(body.action || ''), body);
    return ok({ income: incomeDetail(user, mt[1]) });
  }

  // доставка
  if ((mt = p.match(/^\/api\/requests\/(\d+)\/deliveries$/)) && m === 'POST') { L.addDelivery(user, mt[1], body); return ok({ request: requestDetail(user, mt[1]) }); }
  if ((mt = p.match(/^\/api\/deliveries\/(\d+)$/)) && m === 'DELETE') {
    const rid = db.prepare('SELECT request_id FROM deliveries WHERE id = ?').get(Number(mt[1]))?.request_id;
    L.removeDelivery(user, mt[1]); return ok({ request: requestDetail(user, rid) });
  }

  // корректировки
  if (p === '/api/corrections' && m === 'POST') return ok({ id: L.requestCorrection(user, body) });
  if ((mt = p.match(/^\/api\/corrections\/(\d+)\/decide$/)) && m === 'POST') { L.decideCorrection(user, mt[1], !!body.approve, body.comment); return ok(); }

  // ----- только руководитель -----
  if (p.startsWith('/api/head/')) {
    needHead(user);
    if (p === '/api/head/overview' && m === 'GET') return ok(A.overview(q));
    if (p === '/api/head/prices' && m === 'GET') return ok({ items: A.priceCatalog(q) });
    if (p === '/api/head/control' && m === 'GET') return ok(A.controlFeed());
    if (p === '/api/head/events' && m === 'GET') return ok({ items: eventsFeed(q) });
    if (p === '/api/head/users' && m === 'GET') return ok({ items: listUsers() });
    if (p === '/api/head/users' && m === 'POST') return ok(createUser(user, body));
    if ((mt = p.match(/^\/api\/head\/users\/(\d+)$/)) && m === 'PUT') { updateUser(user, mt[1], body); return ok(); }
    if ((mt = p.match(/^\/api\/head\/users\/(\d+)\/reset$/)) && m === 'POST') return ok(resetPassword(user, mt[1]));
    if (p === '/api/head/settings' && m === 'PUT') return ok(updateSettings(user, body));
    if (p === '/api/head/export' && m === 'GET') {
      const data = exportCsv(q);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="bh-${q.type || 'requests'}-${new Date().toISOString().slice(0, 10)}.csv"` });
      logEvent(user.id, 'export', null, 'exported', { type: q.type || 'requests' });
      return res.end(data);
    }
  }
  throw new HttpError(404, 'Не найдено');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    const ext = path.extname(file);
    const h = { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' };
    if (buf.length > 2048 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && /text|javascript|json|svg/.test(h['Content-Type'])) {
      res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      return res.end(zlib.gzipSync(buf));
    }
    res.writeHead(200, h);
    res.end(buf);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
    try {
      await api(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Внутренняя ошибка, попробуйте ещё раз' : e.message }, req);
      else res.end();
    }
  });
}

if (require.main === module) {
  bootstrap();
  if (process.env.DEMO === '1' && db.prepare('SELECT COUNT(*) n FROM requests').get().n === 0) require('./demo').seed();
  createServer().listen(PORT, () => console.log(`БХ Учёт v${VERSION}: http://localhost:${PORT}`));
}

module.exports = { createServer, bootstrap, DEFAULT_SETTINGS };
