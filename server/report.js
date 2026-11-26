'use strict';
// Отчёт по кассе за период: данные для экрана/печати и файл Excel.
const { db, getSettings } = require('./db');
const cash = require('./cash');
const A = require('./analytics');
const xlsx = require('./xlsx');
const { round2 } = require('./logic');

const TZ = process.env.REPORT_TZ || 'Europe/Kyiv';
const dt = (ts) => new Date(ts).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dOnly = (ymd) => ymd.split('-').reverse().join('.');

// Вид операции простыми словами и группа для сводки.
function opKind(o) {
  if (o.kind === 'expense') return o.delivery_id ? 'Доставка' : o.request_id ? 'Покупка по заявке' : 'Расход из кассы';
  if (o.kind === 'income' && o.income_kind === 'funding') return 'Приход на нужды';
  if (o.kind === 'recount') return o.direction === 'in' ? 'Излишек при пересчёте' : 'Недостача при пересчёте';
  return { topup: 'Пополнение', income: 'Доход', return: 'Возврат остатка', issue: 'Выдано под отчёт', withdraw: 'Сдано из кассы' }[o.kind] || o.kind_text;
}
const GROUP_ORDER = {
  in: ['Доход', 'Приход на нужды', 'Пополнение', 'Возврат остатка', 'Излишек при пересчёте'],
  out: ['Покупка по заявке', 'Доставка', 'Расход из кассы', 'Выдано под отчёт', 'Сдано из кассы', 'Недостача при пересчёте'],
};
const GROUP_TITLE = { 'Доход': 'Доходы', 'Приход на нужды': 'Приходы на нужды (не доход)', 'Пополнение': 'Пополнения кассы', 'Возврат остатка': 'Возвраты остатков подотчёта', 'Излишек при пересчёте': 'Излишек при пересчёте',
  'Покупка по заявке': 'Покупки по заявкам', 'Доставка': 'Доставка', 'Расход из кассы': 'Прочие расходы из кассы', 'Выдано под отчёт': 'Выдано под отчёт',
  'Сдано из кассы': 'Сдано из кассы', 'Недостача при пересчёте': 'Недостача при пересчёте' };

function reportData(q = {}) {
  const rep = cash.report({ from: q.from, to: q.to });
  // «Кто» — тот, кто потратил или принёс деньги (автор заявки или дохода), а не тот, кто провёл.
  const reqUser = db.prepare('SELECT u.name FROM requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?');
  const incUser = db.prepare('SELECT u.name FROM incomes i JOIN users u ON u.id = i.user_id WHERE i.id = ?');
  const items = rep.items.filter((o) => !o.removed_at).reverse().map((o) => ({ ...o, op: opKind(o), date: dt(o.ts),
    user_name: (o.request_id && reqUser.get(o.request_id)?.name) || (o.income_id && incUser.get(o.income_id)?.name) || o.user_name }));
  const sums = { in: {}, out: {} };
  for (const o of items) sums[o.direction][o.op] = round2((sums[o.direction][o.op] || 0) + o.amount);
  const groups = (dir) => GROUP_ORDER[dir].filter((k) => sums[dir][k]).map((k) => ({ title: GROUP_TITLE[k], amount: sums[dir][k] }));
  const ov = A.overview({ from: rep.range.from, to: rep.range.to });
  return {
    division: getSettings().division_name, range: { from: rep.range.from, to: rep.range.to }, generated_at: Date.now(), generated: dt(Date.now()),
    opening: rep.opening, closing: rep.closing, cash_in: rep.totals.in, cash_out: rep.totals.out,
    groups_in: groups('in'), groups_out: groups('out'),
    pl: { income: ov.current.income, expenses: ov.current.expenses, profit: ov.current.profit },
    by_category: ov.by_category.map((x) => ({ k: x.k, s: x.s, n: x.n })), income_by_category: ov.income_by_category.map((x) => ({ k: x.k, s: x.s, n: x.n })),
    by_object: ov.by_object, items,
  };
}

function reportXlsx(q = {}) {
  const r = reportData(q);
  const period = `Период: ${dOnly(r.range.from)} — ${dOnly(r.range.to)} · сформирован ${r.generated}`;
  // ---- лист «Сводка» ----
  const S = []; const merges = [];
  const title = (t) => { S.push([{ v: t, s: 'title' }]); };
  const section = (t, w = 4) => { S.push(Array.from({ length: w }, (_, i) => ({ v: i ? '' : t, s: 'section' }))); };
  title(`Отчёт по кассе · ${r.division}`);
  S.push([{ v: period, s: 'subtitle' }]); S.push([]);
  section('Касса');
  S.push([{ v: 'Остаток на начало периода', s: 'bold' }, { v: r.opening, s: 'moneyBold' }]);
  S.push([{ v: 'Приход', s: 'bold' }, { v: r.cash_in, s: 'moneyIn' }]);
  for (const g of r.groups_in) S.push([{ v: `   ${g.title}`, s: 'muted' }, { v: g.amount, s: 'money' }]);
  S.push([{ v: 'Расход', s: 'bold' }, { v: -r.cash_out, s: 'moneyOut' }]);
  for (const g of r.groups_out) S.push([{ v: `   ${g.title}`, s: 'muted' }, { v: -g.amount, s: 'money' }]);
  S.push([{ v: 'Остаток на конец периода', s: 'totalLabel' }, { v: r.closing, s: 'moneyTotal' }]);
  S.push([]);
  section('Доходы и расходы за период');
  S.push([{ v: 'Доходы (подтверждённые)', s: 'default' }, { v: r.pl.income, s: 'moneyIn' }]);
  S.push([{ v: 'Расходы (проведённые заявки, доставка, расходы из кассы)', s: 'default' }, { v: -r.pl.expenses, s: 'money' }]);
  S.push([{ v: 'Результат', s: 'totalLabel' }, { v: r.pl.profit, s: 'moneyTotal' }]);
  S.push([]);
  if (r.by_category.length) {
    section('Расходы по категориям');
    S.push([{ v: 'Категория', s: 'header' }, { v: 'Сумма', s: 'header' }, { v: 'Операций', s: 'header' }]);
    for (const c of r.by_category) S.push([c.k, { v: c.s, s: 'money' }, c.n]);
    S.push([]);
  }
  if (r.income_by_category.length) {
    section('Доходы по категориям');
    S.push([{ v: 'Категория', s: 'header' }, { v: 'Сумма', s: 'header' }, { v: 'Операций', s: 'header' }]);
    for (const c of r.income_by_category) S.push([c.k, { v: c.s, s: 'money' }, c.n]);
    S.push([]);
  }
  if (r.by_object.length) {
    section('По объектам');
    S.push([{ v: 'Объект', s: 'header' }, { v: 'Доход', s: 'header' }, { v: 'Расход', s: 'header' }, { v: 'Прибыль', s: 'header' }]);
    for (const o of r.by_object) S.push([o.k, { v: o.income, s: 'money' }, { v: o.expenses, s: 'money' }, { v: o.profit, s: 'moneyBold' }]);
  }
  merges.push('A1:D1', 'A2:D2');
  // ---- лист «Операции кассы» ----
  const O = [];
  O.push([{ v: `Операции кассы · ${r.division}`, s: 'title' }]);
  O.push([{ v: period, s: 'subtitle' }]); O.push([]);
  const head = ['Дата', 'Операция', 'Описание', 'Основание', 'Категория', 'Объект', 'Кто', 'Приход', 'Расход', 'Остаток'];
  O.push(head.map((h) => ({ v: h, s: 'header' })));
  O.push([{ v: '', s: 'muted' }, { v: 'Остаток на начало', s: 'muted' }, '', '', '', '', '', '', '', { v: r.opening, s: 'moneyBold' }]);
  for (const o of r.items) {
    O.push([o.date, o.op, o.comment || o.kind_text, o.request_number || o.income_number || '', o.category || '', o.object || '', o.user_name || '',
      o.direction === 'in' ? { v: o.amount, s: 'moneyIn' } : '', o.direction === 'out' ? { v: o.amount, s: 'moneyOut' } : '', { v: o.balance_after, s: 'money' }]);
  }
  const last = O.length;
  O.push([{ v: 'Итого за период', s: 'totalLabel' }, { v: '', s: 'totalLabel' }, { v: `${r.items.length} операций`, s: 'totalLabel' }, { v: '', s: 'totalLabel' }, { v: '', s: 'totalLabel' },
    { v: '', s: 'totalLabel' }, { v: '', s: 'totalLabel' }, { v: r.cash_in, s: 'moneyTotal' }, { v: r.cash_out, s: 'moneyTotal' }, { v: r.closing, s: 'moneyTotal' }]);
  const file = xlsx.build([
    { name: 'Сводка', rows: S, cols: [52, 18, 18, 18], merges, heights: { 0: 28 } },
    { name: 'Операции кассы', rows: O, cols: [17, 22, 46, 11, 16, 20, 18, 15, 15, 16], freezeRow: 4, filter: `A4:J${last}`, landscape: true, merges: ['A1:F1', 'A2:F2'], heights: { 0: 28, 3: 22 } },
  ], `Отчёт по кассе · ${r.division}`);
  const name = `Касса ${r.division} ${dOnly(r.range.from)}-${dOnly(r.range.to)}.xlsx`;
  return { file, name };
}

module.exports = { reportData, reportXlsx };
