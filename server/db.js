'use strict';
// База данных БХ Учёт — встроенный SQLite из Node 22 (node:sqlite), без внешних зависимостей.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'bh.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('head','staff')),
  pass_hash TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT, ua TEXT
);
CREATE TABLE IF NOT EXISTS login_fails (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_fails_key ON login_fails(key, ts);

-- Заявки: покупка материалов (purchase) или запрос денег под отчёт (money).
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','money')),
  channel TEXT NOT NULL DEFAULT 'online' CHECK (channel IN ('online','offline')),
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  object TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  needed_by TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,          -- сумма по заявке (план)
  approved_amount REAL,                    -- сколько согласовал руководитель
  issued_amount REAL,                      -- сколько выдано на руки (подотчёт)
  actual_total REAL,                       -- фактически потрачено по чекам
  returned_amount REAL,                    -- возвращён остаток
  head_comment TEXT NOT NULL DEFAULT '',
  changed_after_approval INTEGER NOT NULL DEFAULT 0,
  edit_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER, decided_by INTEGER,
  reported_at INTEGER,
  closed_at INTEGER, closed_by INTEGER
);
CREATE INDEX IF NOT EXISTS requests_user ON requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status);

CREATE TABLE IF NOT EXISTS request_items (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  pos INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'шт',
  price REAL NOT NULL DEFAULT 0,           -- цена за единицу по заявке
  url TEXT NOT NULL DEFAULT '',
  shop TEXT NOT NULL DEFAULT '',
  actual_qty REAL,
  actual_price REAL                        -- цена за единицу по чеку
);
CREATE INDEX IF NOT EXISTS items_req ON request_items(request_id);
CREATE INDEX IF NOT EXISTS items_key ON request_items(name_key);

-- Доходы: продажи, услуги, оплаты от клиентов.
CREATE TABLE IF NOT EXISTS incomes (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  object TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'account' CHECK (method IN ('cash','card','account')),
  comment TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','rejected')),
  head_comment TEXT NOT NULL DEFAULT '',
  edit_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER, decided_by INTEGER
);
CREATE INDEX IF NOT EXISTS incomes_date ON incomes(date);

-- Файлы: чеки, накладные, счета, фото. Хеш нужен, чтобы ловить один и тот же чек в двух заявках.
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  request_id INTEGER REFERENCES requests(id),
  income_id INTEGER REFERENCES incomes(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'receipt',
  orig_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  ai_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_req ON files(request_id);
CREATE INDEX IF NOT EXISTS files_inc ON files(income_id);
CREATE INDEX IF NOT EXISTS files_sha ON files(sha256);

-- Доставка: добавляется к заявке после покупки (в т. ч. после проведения), без согласования.
-- Расход считается датой добавления, но не раньше проведения заявки.
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  carrier TEXT NOT NULL DEFAULT '',
  ttn TEXT NOT NULL DEFAULT '',
  paid_by TEXT NOT NULL DEFAULT 'self' CHECK (paid_by IN ('advance','self','company')),
  comment TEXT NOT NULL DEFAULT '',
  file_id INTEGER REFERENCES files(id),
  created_at INTEGER NOT NULL,
  removed_at INTEGER, removed_by INTEGER
);
CREATE INDEX IF NOT EXISTS deliveries_req ON deliveries(request_id);
CREATE VIEW IF NOT EXISTS delivery_costs AS
  SELECT d.id, d.request_id, d.amount, d.paid_by, d.user_id, r.user_id req_user, r.object, r.category,
         MAX(d.created_at, r.closed_at) ts
  FROM deliveries d JOIN requests r ON r.id = d.request_id
  WHERE d.removed_at IS NULL AND r.status = 'closed';

-- Запросы на корректировку после окончания окна правки.
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('request','income')),
  entity_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER, decided_by INTEGER,
  decision_comment TEXT NOT NULL DEFAULT ''
);

-- Журнал: каждое действие и каждое изменение (было → стало). Только добавление, удалить нельзя.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_entity ON events(entity, entity_id);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  edit_hours: 2,               // окно самостоятельной правки
  price_alert_pct: 15,         // насколько цена выше обычной, чтобы подсветить
  overspend_alert_pct: 10,     // насколько факт выше согласованного
  categories: ['Материалы', 'Инструмент', 'Расходники', 'Электрика', 'Сантехника', 'Металл', 'Крепёж', 'Транспорт', 'Хозтовары', 'Прочее'],
  income_categories: ['Продажа продукции', 'Услуги', 'Изготовление на заказ', 'Металлолом', 'Прочее'],
  objects: ['База (общие нужды)'],
  units: ['шт', 'м', 'м²', 'м³', 'кг', 'т', 'л', 'уп', 'компл'],
};

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* пропуск битого значения */ }
  }
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function logEvent(userId, entity, entityId, action, data = {}) {
  db.prepare('INSERT INTO events (ts, user_id, entity, entity_id, action, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), userId ?? null, entity, entityId ?? null, action, JSON.stringify(data));
}

// Ключ для сравнения цен на «один и тот же» товар: регистр, ё, пунктуация и пробелы не важны.
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DATA_DIR, UPLOAD_DIR, getSettings, setSetting, logEvent, nameKey, tx, DEFAULT_SETTINGS };
