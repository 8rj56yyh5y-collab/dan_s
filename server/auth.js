'use strict';
// Вход, сессии, пароли. Пароли — scrypt с солью; в базе хранится только хеш токена сессии.
const crypto = require('node:crypto');
const { db, logEvent } = require('./db');

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

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha(token), userId, now, now + SESSION_HOURS * 3600e3, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, userId);
  return token;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}
function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha(exceptToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

const USER_FIELDS = 'u.id, u.login, u.name, u.position, u.phone, u.role, u.must_change_pw, u.active, u.created_at, u.last_login';

function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare(`SELECT ${USER_FIELDS}, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.active) { destroySession(token); return null; }
  delete row.expires_at;
  row.token = token;
  return row;
}

function clientIp(req) {
  const fwd = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || req.socket.remoteAddress || '';
}

// Защита от подбора пароля: 5 ошибок за 15 минут — вход по этому логину с этого адреса блокируется.
function loginBlocked(login, req) {
  const now = Date.now();
  db.prepare('DELETE FROM login_fails WHERE ts < ?').run(now - FAIL_WINDOW);
  const keys = [`l:${String(login).toLowerCase()}|${clientIp(req)}`, `ip:${clientIp(req)}`];
  const a = db.prepare('SELECT COUNT(*) n FROM login_fails WHERE key = ?').get(keys[0]).n;
  const b = db.prepare('SELECT COUNT(*) n FROM login_fails WHERE key = ?').get(keys[1]).n;
  return a >= MAX_FAILS || b >= MAX_FAILS * 4;
}
function loginFailed(login, req) {
  const now = Date.now();
  db.prepare('INSERT INTO login_fails (key, ts) VALUES (?, ?)').run(`l:${String(login).toLowerCase()}|${clientIp(req)}`, now);
  db.prepare('INSERT INTO login_fails (key, ts) VALUES (?, ?)').run(`ip:${clientIp(req)}`, now);
}

function login(loginName, password, req) {
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(String(loginName || '').trim());
  const ok = user && user.active && verifyPassword(password, user.pass_hash);
  if (!ok) {
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
  loginBlocked, login, clientIp,
};
