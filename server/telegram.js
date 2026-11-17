'use strict';
// Telegram-бот БХ Учёт: уведомления и быстрые решения кнопками.
// Включается переменной TELEGRAM_BOT_TOKEN (бот создаётся у @BotFather). Без неё всё работает, просто без уведомлений.
// Получение сообщений — long polling (getUpdates): не нужен вебхук и публичный адрес.
const crypto = require('node:crypto');
const { db, logEvent } = require('./db');
const L = require('./logic');

const BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const POLL_TIMEOUT = Number(process.env.TELEGRAM_POLL_TIMEOUT ?? 25);
let botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
let running = false;

const token = () => process.env.TELEGRAM_BOT_TOKEN || '';
const enabled = () => !!token();
const publicUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const h = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, body = {}, timeoutMs = 15000) {
  if (!enabled()) throw new Error('Telegram не подключён');
  const res = await fetch(`${BASE}/bot${token()}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) { const e = new Error(data.description || `Telegram ${res.status}`); e.code = data.error_code || res.status; throw e; }
  return data.result;
}

// ---------- привязка аккаунта ----------
function linkInfo(userId) {
  const u = db.prepare('SELECT tg_chat_id, tg_username FROM users WHERE id = ?').get(userId);
  return { enabled: enabled(), bot: botUsername, linked: !!u?.tg_chat_id, username: u?.tg_username || '' };
}
function createLink(userId) {
  if (!enabled()) throw new L.HttpError(503, 'Telegram-бот не подключён к системе (нужен TELEGRAM_BOT_TOKEN)');
  if (!botUsername) throw new L.HttpError(503, 'Бот ещё запускается, попробуйте через минуту');
  const code = crypto.randomBytes(12).toString('hex');
  db.prepare('UPDATE users SET tg_link_code = ?, tg_link_expires = ? WHERE id = ?').run(code, Date.now() + 15 * 60e3, userId);
  return { url: `https://t.me/${botUsername}?start=${code}`, bot: botUsername };
}
function unlink(userId) {
  db.prepare('UPDATE users SET tg_chat_id = NULL, tg_username = NULL WHERE id = ?').run(userId);
  logEvent(userId, 'auth', userId, 'telegram_unlinked', {});
}

// ---------- отправка ----------
const userByChat = (chatId) => db.prepare('SELECT * FROM users WHERE tg_chat_id = ? AND active = 1').get(String(chatId));
const heads = (exceptId) => db.prepare("SELECT id, tg_chat_id FROM users WHERE role = 'head' AND active = 1 AND tg_chat_id IS NOT NULL AND id != ?").all(exceptId || 0);
const userChat = (id) => db.prepare('SELECT tg_chat_id FROM users WHERE id = ? AND active = 1').get(id)?.tg_chat_id;

function keyboard(rows, link) {
  const kb = rows.filter((r) => r.length).map((r) => r.map(([text, data]) => ({ text, callback_data: data })));
  // Кнопка-ссылка: Telegram принимает только https-адреса.
  if (link && /^https:\/\//.test(publicUrl())) kb.push([{ text: 'Открыть в БХ Учёт', url: `${publicUrl()}/#${link}` }]);
  return kb.length ? { inline_keyboard: kb } : undefined;
}
async function send(chatId, text, rows = [], link = '') {
  if (!enabled() || !chatId) return;
  try {
    await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard(rows, link) });
  } catch (e) {
    // Пользователь заблокировал бота — отвязываем, чтобы не слать впустую.
    if (e.code === 403) db.prepare('UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ?').run(String(chatId));
    else console.error('Telegram:', e.message);
  }
}
const toHeads = (exceptId, text, rows, link) => Promise.all(heads(exceptId).map((u) => send(u.tg_chat_id, text, rows, link)));
const toUser = (id, text, rows, link) => send(userChat(id), text, rows, link);
const fire = (p) => { Promise.resolve(p).catch((e) => console.error('Telegram:', e.message)); };

// ---------- тексты уведомлений ----------
const fm = (n) => L.fm(n);
const kindText = (r) => (r.kind === 'money' ? 'Деньги под отчёт' : r.channel === 'offline' ? 'Покупка в магазине' : 'Покупка онлайн');
const userName = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || '';

function requestText(r, title) {
  const items = L.itemsOf(r.id);
  const lines = [`${title} <b>${h(L.reqNumber(r.id))}</b> · ${h(userName(r.user_id))}`, `<b>${h(r.title)}</b>`,
    `${h(kindText(r))}${r.object ? ` · ${h(r.object)}` : ''}`, `Сумма: <b>${h(fm(r.approved_amount ?? r.amount))}</b>`];
  if (items.length && r.kind === 'purchase') {
    lines.push('', ...items.slice(0, 6).map((i) => `• ${h(i.name)} — ${h(i.qty)} ${h(i.unit)} × ${h(fm(i.price))}`));
    if (items.length > 6) lines.push(`…и ещё ${items.length - 6}`);
  }
  if (r.purpose) lines.push('', `<i>${h(r.purpose.slice(0, 300))}</i>`);
  return lines.join('\n');
}
function flagsText(r) {
  const files = db.prepare("SELECT * FROM files WHERE request_id = ? AND kind != 'removed'").all(r.id);
  const flags = L.flagsForRequest(r, L.itemsOf(r.id), files).filter((f) => f.level !== 'low');
  return flags.length ? `\n\n⚠️ <b>Проверка:</b>\n${flags.slice(0, 4).map((f) => `• ${h(f.text)}`).join('\n')}` : '';
}

const notify = {
  requestCreated(id, again = false) {
    const r = L.loadRequest(id);
    fire(toHeads(r.user_id, requestText(r, again ? '🔁 Заявка снова на согласовании' : '🆕 Новая заявка') + flagsText(r),
      [[['✅ Согласовать', `h:approve:r:${id}`]], [['↩️ На доработку', `h:return:r:${id}`], ['❌ Отклонить', `h:reject:r:${id}`]]], `/r/${id}`));
  },
  reportSubmitted(id) {
    const r = L.loadRequest(id);
    const plan = r.approved_amount ?? r.amount;
    const text = [`🧾 Отчёт по заявке <b>${h(L.reqNumber(id))}</b> · ${h(userName(r.user_id))}`, `<b>${h(r.title)}</b>`,
      `Потрачено по чеку: <b>${h(fm(r.actual_total))}</b> (согласовано ${h(fm(plan))})`,
      r.actual_total > plan + 0.5 ? `⚠️ <b>Превышение на ${h(fm(r.actual_total - plan))}</b> — сотрудник просит согласовать` : '',
      r.report_comment ? `Комментарий: <i>${h(r.report_comment)}</i>` : '',
      r.no_breakdown ? 'Отчёт одной суммой, без цен по позициям' : '',
      r.returned_amount ? `Возвращает остаток: ${h(fm(r.returned_amount))}` : ''].filter(Boolean).join('\n') + flagsText(r);
    fire(toHeads(r.user_id, text, [[['✅ Провести', `h:close:r:${id}`], ['↩️ Вернуть отчёт', `h:return:r:${id}`]]], `/r/${id}`));
  },
  requestDecided(id, action, actorId, comment = '') {
    const r = L.loadRequest(id);
    if (r.user_id === actorId) return;
    const num = `<b>${h(L.reqNumber(id))}</b> «${h(r.title)}»`;
    const why = r.head_comment ? `\nКомментарий: <i>${h(r.head_comment)}</i>` : '';
    const texts = {
      approve: `✅ Заявка ${num} согласована на ${h(fm(r.approved_amount))}.${r.kind === 'purchase' ? '\nМожно покупать. После покупки внесите цены по чеку, приложите чек и отправьте отчёт.' : ''}${why}`,
      reject: `❌ Заявка ${num} отклонена.${why}`,
      return: r.status === 'report_revision' ? `↩️ Отчёт по заявке ${num} возвращён на доработку.${why}` : `↩️ Заявка ${num} возвращена на доработку.${why}`,
      issue: `💵 По заявке ${num} выданы деньги: <b>${h(fm(r.issued_amount))}</b>.\nПосле покупок — отчёт с чеками.`,
      close: `🏁 Заявка ${num} проведена. Потрачено ${h(fm(r.actual_total))}.`,
      accept: `🏁 Заявка ${num} проведена руководителем по чеку. Потрачено ${h(fm(r.actual_total))}.`,
      comment: `💬 Комментарий руководителя к заявке ${num}:\n<i>${h(comment)}</i>`,
    };
    if (texts[action]) fire(toUser(r.user_id, texts[action], [], `/r/${id}`));
  },
  incomeCreated(id) {
    const i = L.loadIncome(id);
    fire(toHeads(i.user_id, [`💰 Новый доход <b>${h(L.incNumber(id))}</b> · ${h(userName(i.user_id))}`, `<b>${h(i.title)}</b>`,
      `Сумма: <b>${h(fm(i.amount))}</b> · ${h({ cash: 'наличные', card: 'карта', account: 'на счёт' }[i.method])} · ${h(i.date)}`, i.client ? `Клиент: ${h(i.client)}` : ''].filter(Boolean).join('\n'),
    [[['✅ Подтвердить', `h:confirm:i:${id}`], ['❌ Отклонить', `h:reject:i:${id}`]]], `/income/${id}`));
  },
  incomeDecided(id, action, actorId) {
    const i = L.loadIncome(id);
    if (i.user_id === actorId || !['confirm', 'reject'].includes(action)) return;
    fire(toUser(i.user_id, action === 'confirm' ? `✅ Доход <b>${h(L.incNumber(id))}</b> «${h(i.title)}» подтверждён.` : `❌ Доход <b>${h(L.incNumber(id))}</b> «${h(i.title)}» отклонён.\nПричина: <i>${h(i.head_comment)}</i>`, [], `/income/${id}`));
  },
  correctionRequested(cid) {
    const c = db.prepare('SELECT * FROM corrections WHERE id = ?').get(cid);
    const num = c.entity === 'request' ? L.reqNumber(c.entity_id) : L.incNumber(c.entity_id);
    fire(toHeads(c.user_id, `✏️ Запрос на корректировку <b>${h(num)}</b> · ${h(userName(c.user_id))}\n<i>${h(c.reason)}</i>`,
      [[['✅ Разрешить', `h:corr1:c:${cid}`], ['❌ Отказать', `h:corr0:c:${cid}`]]], c.entity === 'request' ? `/r/${c.entity_id}` : `/income/${c.entity_id}`));
  },
  correctionDecided(cid) {
    const c = db.prepare('SELECT * FROM corrections WHERE id = ?').get(cid);
    const num = c.entity === 'request' ? L.reqNumber(c.entity_id) : L.incNumber(c.entity_id);
    fire(toUser(c.user_id, c.status === 'approved' ? `🔓 Корректировка <b>${h(num)}</b> разрешена — можно исправить в течение времени на правку.` : `🔒 В корректировке <b>${h(num)}</b> отказано.${c.decision_comment ? `\n<i>${h(c.decision_comment)}</i>` : ''}`,
      [], c.entity === 'request' ? `/r/${c.entity_id}` : `/income/${c.entity_id}`));
  },
  openingRequested(oid) {
    const o = db.prepare('SELECT * FROM openings WHERE id = ?').get(oid);
    fire(toHeads(o.user_id, `🏦 Начальный остаток на подтверждение · ${h(userName(o.user_id))}\n${h(o.target === 'cash' ? 'Наличные в кассе БХ' : 'Деньги на руках (под отчёт)')}: <b>${h(fm(o.amount))}</b>\n<i>${h(o.comment)}</i>`,
      [[['✅ Подтвердить', `h:op1:o:${oid}`], ['❌ Отклонить', `h:op0:o:${oid}`]]], '/cash'));
  },
  openingDecided(oid) {
    const o = db.prepare('SELECT * FROM openings WHERE id = ?').get(oid);
    fire(toUser(o.user_id, o.status === 'approved'
      ? `✅ Начальный остаток ${h(fm(o.amount))} подтверждён.${o.target === 'advance' ? ' Он числится за вами под отчётом — отчитайтесь чеками по заявке «Начальный остаток на руках».' : ''}`
      : `❌ Начальный остаток ${h(fm(o.amount))} не подтверждён.${o.decision_comment ? `\n<i>${h(o.decision_comment)}</i>` : ''}`, [], o.request_id ? `/r/${o.request_id}` : '/'));
  },
  cashOp(opId, actorId, kind, diff) {
    const u = db.prepare('SELECT role, name FROM users WHERE id = ?').get(actorId);
    const bal = L.cashBalance();
    if (kind === 'recount' && !opId) { if (u.role !== 'head') fire(toHeads(actorId, `🧮 Пересчёт кассы сошёлся · ${h(u.name)}\nВ кассе: <b>${h(fm(bal))}</b>`, [], '/cash')); return; }
    const o = opId && db.prepare('SELECT * FROM cash_ops WHERE id = ?').get(opId);
    if (!o || u.role === 'head') return;
    const titles = { topup: '➕ Пополнение кассы', expense: '➖ Расход из кассы', withdraw: '📤 Сдано из кассы', recount: diff > 0 ? '🧮 Пересчёт: излишек' : '⚠️ Пересчёт: недостача' };
    fire(toHeads(actorId, `${titles[kind] || 'Касса'} · ${h(u.name)}\n<b>${o.direction === 'in' ? '+' : '−'}${h(fm(o.amount))}</b>${o.category ? ` · ${h(o.category)}` : ''}${o.comment ? `\n<i>${h(o.comment)}</i>` : ''}\nВ кассе теперь: <b>${h(fm(bal))}</b>`, [], '/cash'));
  },
  deliveryAdded(rid, actorId, amount) {
    const r = L.loadRequest(rid);
    if (r.status !== 'closed') return;
    fire(toHeads(actorId, `🚚 К проведённой заявке <b>${h(L.reqNumber(rid))}</b> «${h(r.title)}» добавлена доставка: <b>${h(fm(amount))}</b> · ${h(userName(actorId))}`, [], `/r/${rid}`));
  },
};

// ---------- входящие: привязка, кнопки, причины ----------
const pendingReason = new Map(); // chatId → { action, entity, id, until, messageId }
const NEED_REASON = { 'reject:r': 'Причина отказа', 'return:r': 'Что нужно исправить', 'reject:i': 'Причина отказа', 'corr0:c': 'Причина отказа', 'op0:o': 'Причина отказа' };
const DONE_TEXT = { approve: '✅ Согласовано', reject: '❌ Отклонено', return: '↩️ Возвращено', close: '🏁 Проведено', confirm: '✅ Подтверждено', corr1: '🔓 Разрешено', corr0: '🔒 Отказано', op1: '✅ Подтверждено', op0: '❌ Отклонено' };

function perform(user, action, entity, id, comment = '') {
  const cash = require('./cash');
  if (entity === 'r') {
    L.headAction(user, id, action, { comment });
    notify.requestDecided(id, action, user.id, comment);
  } else if (entity === 'i') {
    L.headIncomeAction(user, id, action, { comment });
    notify.incomeDecided(id, action, user.id);
  } else if (entity === 'c') {
    L.decideCorrection(user, id, action === 'corr1', comment);
    notify.correctionDecided(id);
  } else if (entity === 'o') {
    cash.decideOpening(user, id, action === 'op1', comment);
    notify.openingDecided(id);
  } else throw new L.HttpError(400, 'Неизвестное действие');
}

async function finishMessage(chatId, messageId, originalText, suffix) {
  try { await call('editMessageText', { chat_id: chatId, message_id: messageId, text: `${originalText}\n\n${suffix}`, parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch { try { await call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); } catch { /* сообщение могло устареть */ } }
}

async function onCallback(q) {
  const chatId = q.message?.chat?.id ?? q.from?.id;
  const user = userByChat(chatId);
  const answer = (text, alert = false) => call('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert }).catch(() => {});
  if (!user) return answer('Этот Telegram не привязан к БХ Учёт', true);
  if (user.role !== 'head') return answer('Решения принимает руководитель', true);
  const m = /^h:([a-z0-9]+):([rico]):(\d+)$/.exec(String(q.data || ''));
  if (!m) return answer('Кнопка устарела', true);
  const [, action, entity, idStr] = m; const id = Number(idStr);
  const orig = h(q.message?.text || '');
  if (NEED_REASON[`${action}:${entity}`]) {
    pendingReason.set(String(chatId), { action, entity, id, until: Date.now() + 10 * 60e3, messageId: q.message?.message_id, orig });
    await answer('Напишите причину');
    await call('sendMessage', { chat_id: chatId, text: `${NEED_REASON[`${action}:${entity}`]}? Напишите одним сообщением (или /cancel).`, reply_markup: { force_reply: true } }).catch(() => {});
    return;
  }
  try {
    perform(user, action, entity, id);
    await answer(DONE_TEXT[action] || 'Готово');
    await finishMessage(chatId, q.message?.message_id, orig, `${DONE_TEXT[action] || 'Готово'} · ${h(user.name)}`);
  } catch (e) {
    await answer(e.status ? e.message : 'Не получилось, попробуйте в БХ Учёт', true);
    if (e.status === 409) await finishMessage(chatId, q.message?.message_id, orig, `ℹ️ ${h(e.message)}`);
  }
}

async function onMessage(msg) {
  const chatId = msg.chat?.id; const text = String(msg.text || '').trim();
  if (!chatId || msg.chat.type !== 'private') return;
  const startCode = /^\/start(?:\s+([a-f0-9]{24}))?$/.exec(text);
  if (startCode) {
    const code = startCode[1];
    const u = code && db.prepare('SELECT * FROM users WHERE tg_link_code = ? AND tg_link_expires > ? AND active = 1').get(code, Date.now());
    if (!u) return send(chatId, '👋 Это бот БХ Учёт.\nЧтобы получать уведомления, откройте БХ Учёт → <b>Профиль</b> → <b>Подключить Telegram</b>.');
    db.prepare('UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ?').run(String(chatId));
    db.prepare('UPDATE users SET tg_chat_id = ?, tg_username = ?, tg_link_code = NULL, tg_link_expires = NULL WHERE id = ?').run(String(chatId), msg.from?.username || '', u.id);
    logEvent(u.id, 'auth', u.id, 'telegram_linked', { username: msg.from?.username || '' });
    return send(chatId, `✅ Готово, ${h(u.name)}! Уведомления БХ Учёт будут приходить сюда.${u.role === 'head' ? '\nНовые заявки, отчёты и доходы можно согласовывать прямо кнопками в сообщении.' : '\nСюда придут решения по вашим заявкам.'}\n\nОтключить: /stop`);
  }
  if (text === '/stop') {
    const u = userByChat(chatId);
    if (u) unlink(u.id);
    return send(chatId, 'Уведомления отключены. Подключить снова можно в профиле БХ Учёт.');
  }
  if (text === '/cancel') { pendingReason.delete(String(chatId)); return send(chatId, 'Отменено.'); }
  const p = pendingReason.get(String(chatId));
  if (p && p.until > Date.now() && text && !text.startsWith('/')) {
    pendingReason.delete(String(chatId));
    const user = userByChat(chatId);
    if (!user || user.role !== 'head') return;
    try {
      perform(user, p.action, p.entity, p.id, text.slice(0, 1000));
      await send(chatId, `${DONE_TEXT[p.action] || 'Готово'}. Причина записана.`);
      await finishMessage(chatId, p.messageId, p.orig, `${DONE_TEXT[p.action] || 'Готово'} · ${h(user.name)}\n<i>${h(text.slice(0, 300))}</i>`);
    } catch (e) { await send(chatId, `⚠️ ${h(e.status ? e.message : 'Не получилось, попробуйте в БХ Учёт')}`); }
    return;
  }
  if (userByChat(chatId)) return send(chatId, 'Я присылаю уведомления и кнопки для решений. Всё остальное — в БХ Учёт.');
  return send(chatId, '👋 Это бот БХ Учёт. Подключить: БХ Учёт → <b>Профиль</b> → <b>Подключить Telegram</b>.');
}

async function handleUpdate(u) {
  try {
    if (u.callback_query) await onCallback(u.callback_query);
    else if (u.message) await onMessage(u.message);
  } catch (e) { console.error('Telegram update:', e.message); }
}

async function start() {
  if (!enabled() || running) return;
  running = true;
  try {
    const me = await call('getMe');
    botUsername = me.username;
    await call('deleteWebhook', { drop_pending_updates: false });
    console.log(`Telegram-бот @${botUsername} подключён`);
  } catch (e) { console.error('Telegram: не удалось подключить бота —', e.message); }
  let offset = 0;
  (async () => {
    while (running) {
      try {
        if (!botUsername) { const me = await call('getMe'); botUsername = me.username; }
        const updates = await call('getUpdates', { offset, timeout: POLL_TIMEOUT, allowed_updates: ['message', 'callback_query'] }, (POLL_TIMEOUT + 10) * 1000);
        for (const u of updates) { offset = u.update_id + 1; await handleUpdate(u); }
      } catch (e) {
        if (!running) break;
        // 409 — параллельно работает другой экземпляр (например, во время обновления на Render).
        await sleep(e.code === 409 ? 10000 : 5000);
      }
    }
  })();
}
const stop = () => { running = false; };

module.exports = { enabled, start, stop, linkInfo, createLink, unlink, notify, handleUpdate };
