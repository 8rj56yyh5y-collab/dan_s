'use strict';
// Вход, сессии, пароли. Пароли — scrypt с солью; в базе хранится только хеш токена сессии.
const crypto = require('node:crypto');
const { db, mainDb, logEvent, listDivisions, divisionDb, useDivision, currentDivision } = require('./db');

const COOKIE = 'bh_sid';
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 24 * 7;
const MAX_FAILS = 5;
const FAIL_WINDOW = 15 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Пароль — минимум 8 символов';
  if (!/\d/.test(s) || !/\p{L}/u.test(s)) return 'В пароле нужны и буквы, и цифры';
  return null;
}
function randomPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const dig = '23456789';
  let s = '';
  for (let i = 0; i < 7; i++) s += abc[crypto.randomInt(abc.length)];
  for (let i = 0; i < 3; i++) s += dig[crypto.randomInt(dig.length)];
  return s;
}

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function cookie(token, maxAgeSec) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

// Сессии всех подразделений хранятся в основной базе; поле division — в каком подразделении вошёл пользователь.
function createSession(userId, req, division = currentDivision()) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  mainDb.prepare('INSERT INTO sessions (token_hash, user_id, division, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha(token), userId, division, now, now + SESSION_HOURS * 3600e3, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  mainDb.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, userId);
  return token;
}
function destroySession(token) {
  if (token) mainDb.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}
function destroyUserSessions(userId, exceptToken) {
  const div = currentDivision();
  if (exceptToken) mainDb.prepare('DELETE FROM sessions WHERE user_id = ? AND division = ? AND token_hash != ?').run(userId, div, sha(exceptToken));
  else mainDb.prepare('DELETE FROM sessions WHERE user_id = ? AND division = ?').run(userId, div);
}

// Переключение руководителя в другое подразделение: та же сессия, другая база и учётная запись.
function switchSession(token, division, userId) {
  mainDb.prepare('UPDATE sessions SET division = ?, user_id = ? WHERE token_hash = ?').run(division, userId, sha(token));
}

const USER_FIELDS = 'u.id, u.login, u.name, u.position, u.phone, u.role, u.cashier, u.must_change_pw, u.active, u.created_at, u.last_login';

function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sess = mainDb.prepare('SELECT user_id, division, expires_at FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!sess) return null;
  // Дальше весь запрос работает с базой подразделения этой сессии.
  if (sess.expires_at < Date.now() || !useDivision(sess.division)) { destroySession(token); return null; }
  const row = db.prepare(`SELECT ${USER_FIELDS} FROM users u WHERE u.id = ?`).get(sess.user_id);
  if (!row || !row.active) { destroySession(token); return null; }
  row.token = token;
  row.division = sess.division;
  return row;
}

function clientIp(req) {
  const fwd = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || req.socket.remoteAddress || '';
}

// Защита от подбора пароля: 5 ошибок за 15 минут — вход по этому логину с этого адреса блокируется.
function loginBlocked(login, req) {
  const now = Date.now();
  mainDb.prepare('DELETE FROM login_fails WHERE ts < ?').run(now - FAIL_WINDOW);
  const keys = [`l:${String(login).toLowerCase()}|${clientIp(req)}`, `ip:${clientIp(req)}`];
  const a = mainDb.prepare('SELECT COUNT(*) n FROM login_fails WHERE key = ?').get(keys[0]).n;
  const b = mainDb.prepare('SELECT COUNT(*) n FROM login_fails WHERE key = ?').get(keys[1]).n;
  return a >= MAX_FAILS || b >= MAX_FAILS * 4;
}
function loginFailed(login, req) {
  const now = Date.now();
  mainDb.prepare('INSERT INTO login_fails (key, ts) VALUES (?, ?)').run(`l:${String(login).toLowerCase()}|${clientIp(req)}`, now);
  mainDb.prepare('INSERT INTO login_fails (key, ts) VALUES (?, ?)').run(`ip:${clientIp(req)}`, now);
}

function login(loginName, password, req) {
  const name = String(loginName || '').trim();
  // Логин ищется во всех подразделениях; входим туда, где совпал пароль (сначала основное).
  let user = null; let found = null;
  for (const dv of listDivisions()) {
    const u = divisionDb(dv.slug).prepare('SELECT * FROM users WHERE login = ?').get(name);
    if (!u) continue;
    found = found || { u, slug: dv.slug };
    if (u.active && verifyPassword(password, u.pass_hash)) { user = u; useDivision(dv.slug); break; }
  }
  const ok = !!user;
  if (!ok) {
    user = found ? found.u : null;
    if (found) useDivision(found.slug);
    // Хешируем даже для несуществующего логина — чтобы время ответа не выдавало, есть ли такой пользователь.
    if (!user) verifyPassword(password, 'aa:' + '0'.repeat(128));
    loginFailed(loginName, req);
    logEvent(user ? user.id : null, 'auth', user ? user.id : null, 'login_failed', { login: String(loginName || '').slice(0, 60), ip: clientIp(req) });
    return null;
  }
  logEvent(user.id, 'auth', user.id, 'login', { ip: clientIp(req) });
  return { user, token: createSession(user.id, req) };
}

module.exports = {
  COOKIE, SESSION_HOURS, hashPassword, verifyPassword, passwordProblem, randomPassword,
  parseCookies, cookie, createSession, destroySession, destroyUserSessions, userFromRequest,
  loginBlocked, login, clientIp, switchSession,
};
