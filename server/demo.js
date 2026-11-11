'use strict';
// Демо-данные: вымышленные сотрудники и закупки за 5 месяцев. Запуск: npm run demo (или DEMO=1 npm start на пустой базе).
const fs = require('node:fs');
const path = require('node:path');
const { db, nameKey, setSetting, getSettings, logEvent, UPLOAD_DIR } = require('./db');
const auth = require('./auth');

const OBJECTS = ['База (общие нужды)', 'Цех металлообработки', 'Заказ: навесы для склада', 'Заказ: стеллажи', 'Ремонт техники'];
const CATALOG = [
  ['Профильная труба 40×20, 6 м', 'шт', 420, 'Металлобаза', 'Металл'],
  ['Лист стальной 2 мм 1250×2500', 'шт', 2350, 'Металлобаза', 'Металл'],
  ['Электроды АНО-21 3 мм, 2.5 кг', 'уп', 390, 'Эпицентр', 'Расходники'],
  ['Круг отрезной 125×1.2', 'шт', 32, 'Эпицентр', 'Расходники'],
  ['Круг зачистной 125×6', 'шт', 58, 'Эпицентр', 'Расходники'],
  ['Грунт-эмаль 3 в 1, 2.8 кг', 'шт', 610, 'Эпицентр', 'Материалы'],
  ['Растворитель 646, 1 л', 'шт', 115, 'Эпицентр', 'Материалы'],
  ['Саморез кровельный 5.5×25, 250 шт', 'уп', 290, 'Rozetka', 'Крепёж'],
  ['Анкер 10×100', 'шт', 14, 'Rozetka', 'Крепёж'],
  ['Кабель ВВГнг 3×2.5', 'м', 46, 'Rozetka', 'Электрика'],
  ['Автомат 1P 16A', 'шт', 165, 'Rozetka', 'Электрика'],
  ['Перчатки х/б с ПВХ', 'уп', 210, 'Prom', 'Хозтовары'],
  ['Пропан, баллон 50 л (заправка)', 'шт', 980, 'АЗС', 'Расходники'],
  ['Масло моторное 10W-40, 5 л', 'шт', 890, 'Автомагазин', 'Прочее'],
  ['Сверло по металлу 8 мм', 'шт', 48, 'Rozetka', 'Инструмент'],
  ['Болгарка 125 мм 1100 Вт', 'шт', 2450, 'Rozetka', 'Инструмент'],
];

function seed() {
  const now = Date.now();
  const day = 864e5;
  setSetting('objects', OBJECTS);
  const receipt = fs.readFileSync(path.join(__dirname, 'demo-receipt.jpg'));
  fs.writeFileSync(path.join(UPLOAD_DIR, 'demo-receipt.jpg'), receipt);
  const mk = (login, name, position, role, pw) => {
    const ex = db.prepare('SELECT id FROM users WHERE login = ?').get(login);
    if (ex) return ex.id;
    return Number(db.prepare('INSERT INTO users (login, name, position, role, pass_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(login, name, position, role, auth.hashPassword(pw), now - 160 * day).lastInsertRowid);
  };
  const head = db.prepare("SELECT id FROM users WHERE role='head' ORDER BY id LIMIT 1").get()?.id || mk('head', 'Руководитель БХ', 'Руководитель подразделения', 'head', 'demo12345');
  db.prepare("UPDATE users SET pass_hash = ?, must_change_pw = 0 WHERE id = ?").run(auth.hashPassword('demo12345'), head);
  const staff = [
    { id: mk('engineer', 'Инженер (демо)', 'Инженер', 'staff', 'demo12345'), markup: 1.32 },  // в демо цены систематически выше
    { id: mk('master', 'Мастер цеха (демо)', 'Мастер цеха', 'staff', 'demo12345'), markup: 1.0 },
    { id: mk('welder', 'Сварщик (демо)', 'Сварщик', 'staff', 'demo12345'), markup: 1.03 },
  ];

  let seedN = 7;
  const rnd = () => { seedN = (seedN * 16807) % 2147483647; return (seedN - 1) / 2147483646; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const insReq = db.prepare(`INSERT INTO requests (kind, channel, title, purpose, object, category, user_id, status, amount, approved_amount, issued_amount, actual_total, returned_amount,
      edit_until, created_at, updated_at, decided_at, decided_by, reported_at, closed_at, closed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insItem = db.prepare('INSERT INTO request_items (request_id, pos, name, name_key, qty, unit, price, url, shop, actual_qty, actual_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insFile = db.prepare("INSERT INTO files (request_id, user_id, kind, orig_name, mime, size, stored, sha256, created_at) VALUES (?, ?, 'receipt', ?, 'image/jpeg', ?, 'demo-receipt.jpg', ?, ?)");

  db.exec('BEGIN');
  for (let k = 0; k < 70; k++) {
    const s = staff[k % 3];
    const created = now - Math.floor((148 - k * 2.25) * day) - Math.floor(rnd() * 8 * 3600e3);
    const lines = 1 + Math.floor(rnd() * 4);
    const items = [];
    for (let j = 0; j < lines; j++) {
      const [name, unit, base, shop, cat] = pick(CATALOG);
      if (items.some((i) => i.name === name)) continue;
      const qty = unit === 'м' ? 10 + Math.floor(rnd() * 60) : 1 + Math.floor(rnd() * 12);
      const drift = 1 + (k / 70) * 0.06; // лёгкий рост цен со временем
      const price = Math.round(base * drift * s.markup * (0.95 + rnd() * 0.1));
      items.push({ name, unit, qty, price, shop, cat, url: shop === 'Rozetka' || shop === 'Prom' ? `https://example.com/${encodeURIComponent(nameKey(name))}` : '' });
    }
    const online = items.every((i) => i.url);
    const amount = items.reduce((a, i) => a + i.qty * i.price, 0);
    const kind = !online && rnd() < 0.5 ? 'money' : 'purchase';
    const recent = k >= 64;
    const status = recent ? ['pending', 'pending', 'review', 'issued', 'approved', 'review'][k - 64] : rnd() < 0.06 ? 'rejected' : 'closed';
    const approved = status === 'pending' || status === 'rejected' ? null : amount;
    const issued = kind === 'money' && ['issued', 'review', 'closed'].includes(status) ? Math.ceil(amount / 100) * 100 : null;
    const done = ['review', 'closed'].includes(status);
    const actual = done ? items.reduce((a, i) => a + i.qty * Math.round(i.price * (0.97 + rnd() * 0.05)), 0) : null;
    const title = items.length === 1 ? items[0].name : `${items[0].name.split(',')[0]} и ещё ${items.length - 1}`;
    const r = insReq.run(kind, online ? 'online' : 'offline', title, kind === 'money' ? 'Закупка на месте, оплата наличными' : '', pick(OBJECTS), items[0].cat, s.id, status,
      amount, approved, issued, actual, issued && actual != null && status === 'closed' ? Math.max(0, issued - actual) : null,
      created + 2 * 3600e3, created, created + day, approved ? created + 3 * 3600e3 : status === 'rejected' ? created + 3600e3 : null, approved || status === 'rejected' ? head : null,
      done ? created + 2 * day : null, status === 'closed' ? created + 3 * day : null, status === 'closed' ? head : null);
    const rid = Number(r.lastInsertRowid);
    items.forEach((i, pos) => insItem.run(rid, pos, i.name, nameKey(i.name), i.qty, i.unit, i.price, i.url, i.shop, done ? i.qty : null,
      done ? Math.round(i.price * (0.97 + rnd() * 0.05)) : null));
    if (done) {
      insFile.run(rid, s.id, `чек-${rid}.jpg`, receipt.length, `demo-${rid}`, created + 2 * day);
      // Пересчёт факта точно по позициям.
      const t = db.prepare('SELECT SUM(COALESCE(actual_qty, qty) * actual_price) t FROM request_items WHERE request_id = ?').get(rid).t;
      db.prepare('UPDATE requests SET actual_total = ? WHERE id = ?').run(t, rid);
    }
    db.prepare('INSERT INTO events (ts, user_id, entity, entity_id, action, data) VALUES (?, ?, ?, ?, ?, ?)').run(created, s.id, 'request', rid, 'created', JSON.stringify({ kind, amount, demo: true }));
    if (status === 'closed') db.prepare('INSERT INTO events (ts, user_id, entity, entity_id, action, data) VALUES (?, ?, ?, ?, ?, ?)').run(created + 3 * day, head, 'request', rid, 'closed', JSON.stringify({ demo: true }));
  }
  // Доходы
  const titles = [['Навес 6×4 м, изготовление и монтаж', 'Изготовление на заказ'], ['Стеллажи металлические, 8 секций', 'Продажа продукции'], ['Сдача металлолома', 'Металлолом'],
    ['Ремонт ворот', 'Услуги'], ['Мангалы, партия', 'Продажа продукции'], ['Резка и гибка металла', 'Услуги']];
  for (let k = 0; k < 34; k++) {
    const created = now - Math.floor((140 - k * 4.2) * day);
    const [title, cat] = pick(titles);
    const amount = Math.round((cat === 'Металлолом' ? 6000 : 9000) + rnd() * 38000);
    const date = new Date(created).toISOString().slice(0, 10);
    const status = k >= 32 ? 'new' : 'confirmed';
    db.prepare(`INSERT INTO incomes (date, title, client, object, category, amount, method, user_id, status, edit_until, created_at, updated_at, decided_at, decided_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(date, title, pick(['ФЛП Клиент А', 'ООО «Заказчик»', 'Частный клиент', 'Пункт приёма']), cat === 'Металлолом' ? OBJECTS[0] : pick(OBJECTS.slice(1)), cat, amount,
        pick(['cash', 'card', 'account']), staff[k % 3].id, status, created + 2 * 3600e3, created, created, status === 'confirmed' ? created + day : null, status === 'confirmed' ? head : null);
  }
  db.exec('COMMIT');
  logEvent(head, 'settings', null, 'demo_seeded', {});
  console.log('Демо-данные созданы. Входы: head / engineer / master / welder, пароль demo12345');
  return getSettings();
}

if (require.main === module) {
  require('./index').bootstrap();
  seed();
}
module.exports = { seed };
