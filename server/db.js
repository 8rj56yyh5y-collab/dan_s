'use strict';
// База данных Максимет — встроенный SQLite из Node 22 (node:sqlite), без внешних зависимостей.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Схема и миграции для базы любого подразделения (у каждого подразделения — свой файл базы).
function setupDb(db) {
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
    paid_by TEXT NOT NULL DEFAULT 'self' CHECK (paid_by IN ('advance','self','company','cash')),
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

  -- Касса подразделения: наличные. Остаток = приход − расход (без отменённых операций).
  -- kind: topup — пополнение, income — доход наличными, return — возврат остатка подотчёта,
  --       issue — выдача под отчёт, expense — расход из кассы, withdraw — сдача/инкассация, recount — пересчёт.
  -- Записи не удаляются: отмена помечает removed_at и пишется в журнал.
  CREATE TABLE IF NOT EXISTS cash_ops (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    kind TEXT NOT NULL CHECK (kind IN ('topup','income','return','issue','expense','withdraw','recount')),
    amount REAL NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL DEFAULT '',
    object TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    request_id INTEGER REFERENCES requests(id),
    income_id INTEGER REFERENCES incomes(id),
    file_id INTEGER REFERENCES files(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    removed_at INTEGER, removed_by INTEGER, remove_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS cash_ts ON cash_ops(ts);
  CREATE INDEX IF NOT EXISTS cash_req ON cash_ops(request_id);
  CREATE INDEX IF NOT EXISTS cash_inc ON cash_ops(income_id);

  -- Начальный остаток при старте работы: заявка → подтверждение руководителем.
  -- target: cash — наличные в кассе БХ; advance — деньги на руках у сотрудника (станут подотчётом).
  CREATE TABLE IF NOT EXISTS openings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    target TEXT NOT NULL CHECK (target IN ('cash','advance')),
    amount REAL NOT NULL CHECK (amount > 0),
    comment TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER, decided_by INTEGER, decision_comment TEXT NOT NULL DEFAULT '',
    cash_op_id INTEGER, request_id INTEGER
  );

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

  // Новые колонки в уже существующих базах (ALTER TABLE не поддерживает IF NOT EXISTS).
  function addColumn(table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
  addColumn('files', 'cash_op_id', 'cash_op_id INTEGER REFERENCES cash_ops(id)');
  addColumn('users', 'cashier', 'cashier INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'tg_chat_id', 'tg_chat_id TEXT');
  addColumn('users', 'tg_username', 'tg_username TEXT');
  addColumn('users', 'tg_link_code', 'tg_link_code TEXT');
  addColumn('users', 'tg_link_expires', 'tg_link_expires INTEGER');
  addColumn('requests', 'receipt_total', 'receipt_total REAL');
  addColumn('requests', 'report_comment', "report_comment TEXT NOT NULL DEFAULT ''");
  addColumn('requests', 'no_breakdown', 'no_breakdown INTEGER NOT NULL DEFAULT 0');
  addColumn('requests', 'paid_from', "paid_from TEXT NOT NULL DEFAULT ''");
  addColumn('cash_ops', 'delivery_id', 'delivery_id INTEGER');
  // Старые базы: в доставке разрешаем оплату «из кассы» (CHECK в SQLite меняется только пересозданием таблицы).
  {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get()?.sql || '';
    if (ddl && !ddl.includes("'cash'")) {
      const viewSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'delivery_costs'").get()?.sql;
      db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
      db.exec('DROP VIEW IF EXISTS delivery_costs');
      db.exec('ALTER TABLE deliveries RENAME TO deliveries_old');
      db.exec(ddl.replace("('advance','self','company')", "('advance','self','company','cash')"));
      db.exec('INSERT INTO deliveries SELECT * FROM deliveries_old; DROP TABLE deliveries_old;');
      if (viewSql) db.exec(viewSql);
      db.exec('CREATE INDEX IF NOT EXISTS deliveries_req ON deliveries(request_id); COMMIT; PRAGMA foreign_keys = ON;');
    }
  }
  addColumn('requests', 'issued_from_cash', 'issued_from_cash INTEGER NOT NULL DEFAULT 0');
  // Поступление: income — доход (продажа, услуга); funding — приход на нужды (деньги на покупки, зарплаты), не доход.
  addColumn('incomes', 'kind', "kind TEXT NOT NULL DEFAULT 'income'");
}

// ---------- подразделения ----------
// Основная база (bh.db) — подразделение «БХ» (slug main): в ней же список подразделений и сессии входа.
// Остальные подразделения — отдельные файлы div-<slug>.db: свои сотрудники, касса, заявки, доходы, журнал.
// Каждый запрос работает с базой своего подразделения через AsyncLocalStorage — `db` ниже это прокси.
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();
function openDb(file) {
  const d = new DatabaseSync(file);
  setupDb(d);
  return d;
}
const mainDb = openDb(process.env.DB_FILE || path.join(DATA_DIR, 'bh.db'));
mainDb.exec(`CREATE TABLE IF NOT EXISTS divisions (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, file TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, created_by INTEGER
)`);
if (!mainDb.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'division')) {
  mainDb.exec("ALTER TABLE sessions ADD COLUMN division TEXT NOT NULL DEFAULT 'main'");
}
const opened = new Map([['main', mainDb]]);
function divisionDb(slug) {
  if (opened.has(slug)) return opened.get(slug);
  const row = mainDb.prepare('SELECT * FROM divisions WHERE slug = ?').get(String(slug));
  if (!row) return null;
  const d = openDb(path.join(DATA_DIR, row.file));
  opened.set(slug, d);
  return d;
}
const divisionName = (d) => {
  const v = d.prepare("SELECT value FROM settings WHERE key = 'division_name'").get();
  try { return v ? JSON.parse(v.value) : 'БХ'; } catch { return 'БХ'; }
};
function listDivisions() {
  return [{ slug: 'main', name: divisionName(mainDb) },
    ...mainDb.prepare('SELECT slug FROM divisions ORDER BY created_at').all().map((r) => ({ slug: r.slug, name: divisionName(divisionDb(r.slug)) }))];
}
function createDivision(name, byUserId) {
  const slug = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const file = `div-${slug}.db`;
  mainDb.prepare('INSERT INTO divisions (slug, name, file, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(slug, name, file, Date.now(), byUserId || null);
  const d = divisionDb(slug);
  d.prepare("INSERT INTO settings (key, value) VALUES ('division_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(name));
  return slug;
}
const store = () => als.getStore();
const currentDb = () => store()?.db || mainDb;
const currentDivision = () => store()?.division || 'main';
// Переключить текущий запрос на базу подразделения.
function useDivision(slug) {
  const d = divisionDb(slug);
  const st = store();
  if (!d || !st) return false;
  st.db = d; st.division = slug;
  return true;
}
// Выполнить fn в контексте подразделения (для бота и фоновых задач).
const runInDivision = (slug, fn) => als.run({ db: divisionDb(slug) || mainDb, division: divisionDb(slug) ? slug : 'main' }, fn);
const db = new Proxy({}, {
  get(_, key) { const d = currentDb(); const v = d[key]; return typeof v === 'function' ? v.bind(d) : v; },
});

const DEFAULT_SETTINGS = {
  edit_hours: 2,               // окно самостоятельной правки
  price_alert_pct: 15,         // насколько цена выше обычной, чтобы подсветить
  overspend_alert_pct: 10,     // насколько факт выше согласованного
  categories: ['Материалы', 'Инструмент', 'Расходники', 'Электрика', 'Сантехника', 'Металл', 'Крепёж', 'Транспорт', 'Хозтовары', 'Прочее'],
  income_categories: ['Продажа продукции', 'Услуги', 'Изготовление на заказ', 'Металлолом', 'Прочее'],
  objects: ['База (общие нужды)'],
  division_name: 'БХ',
  cash_all: true,          // все доходы и расходы подразделения проходят через кассу
  units: ['шт', 'м', 'м²', 'м³', 'кг', 'т', 'л', 'уп', 'компл'],
  // ---- опции подразделения (по умолчанию — как в БХ) ----
  mod_incomes: true,           // раздел «Доходы»
  mod_cash: true,              // раздел «Касса»
  mod_delivery: true,          // доставка в заявках
  mod_money: true,             // заявки «Деньги под отчёт»
  mod_control: true,           // «Контроль» (проверка цен и замечания)
  use_objects: true,           // поле «Объект» в заявках и доходах
  label_object: 'Объект',      // как называть это поле: Объект / Клиент / Проект / Направление
  require_object: false,       // объект обязателен
  require_category: false,     // категория обязательна
  require_link: true,          // ссылка обязательна для онлайн-покупки
  require_receipt: true,       // без чека отчёт не принимается
  auto_approve_below: 0,       // заявки на покупку до этой суммы согласуются автоматически (0 — выкл.)
  income_confirm: true,        // доходы подтверждает руководитель
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

module.exports = { db, mainDb, als, DATA_DIR, UPLOAD_DIR, getSettings, setSetting, logEvent, nameKey, tx, DEFAULT_SETTINGS,
  divisionDb, listDivisions, createDivision, currentDivision, useDivision, runInDivision };
