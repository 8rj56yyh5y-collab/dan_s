'use strict';
// Аналитика для руководителя: доходы, расходы, прибыль, разрезы, контроль цен, подотчёт.
const { db, getSettings } = require('./db');
const { round2, median, flagsForRequest, itemsOf, reqNumber } = require('./logic');

const dayStart = (s) => Date.parse(`${s}T00:00:00`);
const ymd = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ym = (ts) => ymd(ts).slice(0, 7);

function range(q) {
  const now = new Date();
  let from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null;
  let to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : null;
  if (!from) from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  if (!to) to = ymd(now);
  if (from > to) [from, to] = [to, from];
  const fromTs = dayStart(from);
  const toTs = dayStart(to) + 864e5 - 1;
  // Прошлый период той же длины — для сравнения.
  const len = toTs - fromTs + 1;
  return { from, to, fromTs, toTs, prevFromTs: fromTs - len, prevToTs: fromTs - 1, prevFrom: ymd(fromTs - len), prevTo: ymd(fromTs - 1) };
}

function totals(fromTs, toTs, fromD, toD) {
  const exp = db.prepare("SELECT COALESCE(SUM(actual_total),0) s, COUNT(*) n FROM requests WHERE status='closed' AND closed_at BETWEEN ? AND ?").get(fromTs, toTs);
  const inc = db.prepare("SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM incomes WHERE status='confirmed' AND date BETWEEN ? AND ?").get(fromD, toD);
  return { expenses: round2(exp.s), expense_count: exp.n, income: round2(inc.s), income_count: inc.n, profit: round2(inc.s - exp.s) };
}

function overview(q) {
  const r = range(q);
  const cur = totals(r.fromTs, r.toTs, r.from, r.to);
  const prev = totals(r.prevFromTs, r.prevToTs, r.prevFrom, r.prevTo);

  const pipeline = db.prepare(`SELECT status, COUNT(*) n, COALESCE(SUM(COALESCE(approved_amount, amount)),0) s FROM requests
    WHERE status IN ('pending','revision','approved','issued','review','report_revision') GROUP BY status`).all();
  const pendingIncome = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM incomes WHERE status='new'").get();
  const corrections = db.prepare("SELECT COUNT(*) n FROM corrections WHERE status='pending'").get().n;

  // Помесячно за 12 месяцев, заканчивая месяцем «по».
  const end = new Date(dayStart(r.to));
  const months = [];
  for (let k = 11; k >= 0; k--) {
    const d = new Date(end.getFullYear(), end.getMonth() - k, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const m0 = Date.parse(`${months[0]}-01T00:00:00`);
  const byMonth = Object.fromEntries(months.map((m) => [m, { month: m, income: 0, expenses: 0 }]));
  for (const row of db.prepare("SELECT closed_at, actual_total FROM requests WHERE status='closed' AND closed_at >= ?").all(m0)) {
    const k = ym(row.closed_at); if (byMonth[k]) byMonth[k].expenses += row.actual_total || 0;
  }
  for (const row of db.prepare("SELECT date, amount FROM incomes WHERE status='confirmed' AND date >= ?").all(`${months[0]}-01`)) {
    const k = row.date.slice(0, 7); if (byMonth[k]) byMonth[k].income += row.amount;
  }
  const monthly = months.map((m) => ({ ...byMonth[m], income: round2(byMonth[m].income), expenses: round2(byMonth[m].expenses), profit: round2(byMonth[m].income - byMonth[m].expenses) }));

  const closedIn = "status='closed' AND closed_at BETWEEN ? AND ?";
  const byCategory = db.prepare(`SELECT COALESCE(NULLIF(category,''),'Без категории') k, SUM(actual_total) s, COUNT(*) n FROM requests WHERE ${closedIn} GROUP BY k ORDER BY s DESC`).all(r.fromTs, r.toTs);
  const byChannel = db.prepare(`SELECT channel k, SUM(actual_total) s, COUNT(*) n FROM requests WHERE ${closedIn} GROUP BY k`).all(r.fromTs, r.toTs);
  const byStaff = db.prepare(`SELECT u.id, u.name k, SUM(r.actual_total) s, COUNT(*) n,
      SUM(COALESCE(r.approved_amount, r.amount)) planned
    FROM requests r JOIN users u ON u.id = r.user_id WHERE r.status='closed' AND r.closed_at BETWEEN ? AND ? GROUP BY u.id ORDER BY s DESC`).all(r.fromTs, r.toTs);

  // Объекты: доход − расход = прибыль объекта.
  const objMap = new Map();
  const touch = (k) => { if (!objMap.has(k)) objMap.set(k, { k, income: 0, expenses: 0 }); return objMap.get(k); };
  for (const row of db.prepare(`SELECT COALESCE(NULLIF(object,''),'Без объекта') k, SUM(actual_total) s FROM requests WHERE ${closedIn} GROUP BY k`).all(r.fromTs, r.toTs)) touch(row.k).expenses = round2(row.s);
  for (const row of db.prepare("SELECT COALESCE(NULLIF(object,''),'Без объекта') k, SUM(amount) s FROM incomes WHERE status='confirmed' AND date BETWEEN ? AND ? GROUP BY k").all(r.from, r.to)) touch(row.k).income = round2(row.s);
  const byObject = [...objMap.values()].map((o) => ({ ...o, profit: round2(o.income - o.expenses) })).sort((a, b) => b.income + b.expenses - (a.income + a.expenses));

  const incomeByCategory = db.prepare("SELECT COALESCE(NULLIF(category,''),'Без категории') k, SUM(amount) s, COUNT(*) n FROM incomes WHERE status='confirmed' AND date BETWEEN ? AND ? GROUP BY k ORDER BY s DESC").all(r.from, r.to);

  const topItems = db.prepare(`SELECT i.name, i.unit, SUM(COALESCE(i.actual_qty, i.qty)) qty, SUM(COALESCE(i.actual_qty, i.qty) * COALESCE(i.actual_price, i.price)) s, COUNT(*) n
    FROM request_items i JOIN requests r ON r.id = i.request_id WHERE r.status='closed' AND r.closed_at BETWEEN ? AND ?
    GROUP BY i.name_key ORDER BY s DESC LIMIT 10`).all(r.fromTs, r.toTs);

  // Среднее время согласования (часы).
  const appr = db.prepare("SELECT AVG(decided_at - created_at) a FROM requests WHERE decided_at IS NOT NULL AND created_at BETWEEN ? AND ?").get(r.fromTs, r.toTs).a;
  // Экономия: согласовано больше, чем потратили.
  const saved = db.prepare(`SELECT COALESCE(SUM(COALESCE(approved_amount, amount) - actual_total),0) s FROM requests WHERE ${closedIn}`).get(r.fromTs, r.toTs).s;

  const fix = (rows) => rows.map((x) => ({ ...x, s: round2(x.s || 0), planned: x.planned != null ? round2(x.planned) : undefined }));
  return {
    range: r, current: cur, previous: prev,
    pipeline, pending_income: { n: pendingIncome.n, s: round2(pendingIncome.s) }, corrections,
    monthly, by_category: fix(byCategory), by_channel: fix(byChannel), by_staff: fix(byStaff), by_object: byObject,
    income_by_category: fix(incomeByCategory), top_items: fix(topItems).map((x) => ({ ...x, qty: round2(x.qty) })),
    approval_hours: appr ? round2(appr / 3600e3) : null, saved: round2(saved),
    advances: advances(),
  };
}

// Подотчёт: сколько денег у сотрудника на руках без отчёта.
function advances(userId) {
  const where = userId ? 'AND r.user_id = ?' : '';
  const args = userId ? [userId] : [];
  const rows = db.prepare(`SELECT u.id, u.name,
      SUM(CASE WHEN r.status IN ('issued','review','report_revision') THEN r.issued_amount ELSE 0 END) open_amount,
      SUM(CASE WHEN r.status IN ('issued','review','report_revision') THEN 1 ELSE 0 END) open_count,
      SUM(CASE WHEN r.status='closed' AND r.issued_amount IS NOT NULL THEN r.issued_amount - COALESCE(r.actual_total,0) - COALESCE(r.returned_amount,0) ELSE 0 END) closed_diff
    FROM requests r JOIN users u ON u.id = r.user_id WHERE r.issued_amount IS NOT NULL ${where} GROUP BY u.id ORDER BY open_amount DESC`).all(...args);
  return rows.map((x) => ({ ...x, open_amount: round2(x.open_amount || 0), closed_diff: round2(x.closed_diff || 0), balance: round2((x.open_amount || 0) + (x.closed_diff || 0)) }));
}

// Справочник цен: все купленные позиции, разброс цен, кто и где покупал.
function priceCatalog(q = {}) {
  const term = String(q.q || '').toLowerCase().trim();
  const rows = db.prepare(`SELECT i.name, i.name_key, i.unit, COALESCE(i.actual_price, i.price) p, COALESCE(i.actual_qty, i.qty) qty, i.shop, i.url,
      r.id rid, r.closed_at, u.name user_name, u.id user_id
    FROM request_items i JOIN requests r ON r.id = i.request_id JOIN users u ON u.id = r.user_id
    WHERE r.status = 'closed' AND COALESCE(i.actual_price, i.price) > 0 ORDER BY r.closed_at`).all();
  const map = new Map();
  for (const x of rows) {
    if (term && !x.name_key.includes(term)) continue;
    if (!map.has(x.name_key)) map.set(x.name_key, { name: x.name, unit: x.unit, buys: [] });
    map.get(x.name_key).buys.push({ price: x.p, qty: x.qty, shop: x.shop, url: x.url, rid: x.rid, number: reqNumber(x.rid), date: x.closed_at, user: x.user_name, user_id: x.user_id });
  }
  const pct = Number(getSettings().price_alert_pct) || 15;
  const out = [...map.values()].map((g) => {
    const prices = g.buys.map((b) => b.price);
    const med = median(prices);
    const last = g.buys[g.buys.length - 1];
    const first = g.buys[0];
    const byUser = {};
    for (const b of g.buys) { (byUser[b.user] ||= []).push(b.price); }
    const users = Object.entries(byUser).map(([name, ps]) => ({ name, median: round2(median(ps)), n: ps.length, delta: med ? round2((median(ps) / med - 1) * 100) : 0 }));
    return {
      name: g.name, unit: g.unit, count: g.buys.length,
      min: round2(Math.min(...prices)), max: round2(Math.max(...prices)), median: round2(med), last: round2(last.price),
      spread: med ? round2((Math.max(...prices) / Math.min(...prices) - 1) * 100) : 0,
      trend: first.price ? round2((last.price / first.price - 1) * 100) : 0,
      above: g.buys.filter((b) => b.price > med * (1 + pct / 100)).length,
      total: round2(g.buys.reduce((s, b) => s + b.price * b.qty, 0)),
      users, buys: g.buys.slice(-30).reverse(),
    };
  });
  out.sort((a, b) => b.above - a.above || b.spread - a.spread || b.total - a.total);
  return out.slice(0, 300);
}

// Все заявки с флагами — лента «Требует внимания» для контроля.
function controlFeed() {
  const settings = getSettings();
  const list = db.prepare(`SELECT r.*, u.name user_name FROM requests r JOIN users u ON u.id = r.user_id
    WHERE r.status NOT IN ('cancelled','rejected') ORDER BY r.updated_at DESC LIMIT 300`).all();
  const out = [];
  for (const r of list) {
    const items = itemsOf(r.id);
    const files = db.prepare("SELECT * FROM files WHERE request_id = ? AND kind != 'removed'").all(r.id);
    const flags = flagsForRequest(r, items, files, settings);
    if (flags.length) out.push({ id: r.id, number: reqNumber(r.id), title: r.title, status: r.status, user_name: r.user_name, amount: r.amount, actual_total: r.actual_total, updated_at: r.updated_at, flags });
  }
  const weight = { high: 3, mid: 2, low: 1 };
  out.sort((a, b) => Math.max(...b.flags.map((f) => weight[f.level])) - Math.max(...a.flags.map((f) => weight[f.level])) || b.updated_at - a.updated_at);
  // Сводка по сотрудникам: доля покупок с завышенной ценой.
  const staff = {};
  for (const x of out) {
    const s = (staff[x.user_name] ||= { name: x.user_name, requests: 0, high: 0, price: 0 });
    s.requests++;
    if (x.flags.some((f) => f.level === 'high')) s.high++;
    if (x.flags.some((f) => f.code === 'price_high')) s.price++;
  }
  return { items: out, staff: Object.values(staff).sort((a, b) => b.high - a.high) };
}

module.exports = { overview, advances, priceCatalog, controlFeed, range };
