'use strict';
// Распознавание чеков через Claude (необязательно). Включается переменной ANTHROPIC_API_KEY.
// Без ключа и без установленного пакета @anthropic-ai/sdk система работает как обычно, кнопка ИИ просто скрыта.
const fs = require('node:fs');
const path = require('node:path');
const { db, UPLOAD_DIR, logEvent } = require('./db');
const { HttpError, round2 } = require('./logic');

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic || mod;
    client = new Anthropic();
    return client;
  } catch { return null; }
}
const enabled = () => !!getClient();

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_receipt', 'store', 'date', 'currency', 'items', 'total', 'notes'],
  properties: {
    is_receipt: { type: 'boolean', description: 'true, если это чек, накладная или счёт' },
    store: { type: 'string', description: 'Магазин / продавец, как написано в документе' },
    date: { type: 'string', description: 'Дата покупки ГГГГ-ММ-ДД или пусто' },
    currency: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'qty', 'unit_price', 'sum'],
        properties: { name: { type: 'string' }, qty: { type: 'number' }, unit_price: { type: 'number' }, sum: { type: 'number' } },
      },
    },
    total: { type: 'number', description: 'Итог к оплате по документу' },
    notes: { type: 'string', description: 'Что нечитаемо, исправлено вручную или выглядит подозрительно; пусто, если всё чисто' },
  },
};

const PROMPT = `Это фото или скан документа об оплате (чек магазина, накладная, счёт) для учёта закупок.
Перепиши позиции ровно как в документе: название, количество, цена за единицу, сумма по строке, и итог к оплате.
Не придумывай того, чего не видно: если цифру не прочитать, поставь 0 и напиши об этом в notes.
В notes также отметь признаки правок (зачёркнуто, дописано от руки, разный шрифт), если они есть.`;

async function parseReceipt(user, fileId) {
  const c = getClient();
  if (!c) throw new HttpError(503, 'Распознавание чеков не подключено (нужен ANTHROPIC_API_KEY)');
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(fileId));
  if (!f) throw new HttpError(404, 'Файл не найден');
  if (f.ai_json) return JSON.parse(f.ai_json);
  if (f.mime === 'image/heic') throw new HttpError(415, 'HEIC ИИ не читает — сохраните фото как JPG');
  const data = fs.readFileSync(path.join(UPLOAD_DIR, f.stored)).toString('base64');
  const block = f.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: f.mime, data } };

  let res;
  try {
    res = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
    });
  } catch (e) {
    const status = e?.status;
    if (status === 429) throw new HttpError(503, 'ИИ сейчас перегружен, попробуйте через минуту');
    if (status === 401 || status === 403) throw new HttpError(503, 'Ключ ИИ не подошёл — проверьте ANTHROPIC_API_KEY');
    throw new HttpError(502, 'Не удалось распознать чек, попробуйте ещё раз');
  }
  if (res.stop_reason === 'refusal') throw new HttpError(422, 'ИИ отказался обрабатывать этот файл');
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new HttpError(502, 'ИИ вернул непонятный ответ, попробуйте ещё раз'); }
  out.total = round2(out.total || 0);
  out.items = (out.items || []).slice(0, 100).map((i) => ({ name: String(i.name || '').slice(0, 200), qty: Number(i.qty) || 0, unit_price: round2(i.unit_price || 0), sum: round2(i.sum || 0) }));
  out.parsed_at = Date.now();
  db.prepare('UPDATE files SET ai_json = ? WHERE id = ?').run(JSON.stringify(out), f.id);
  logEvent(user.id, f.request_id ? 'request' : 'income', f.request_id || f.income_id, 'ai_receipt', { file_id: f.id, total: out.total, items: out.items.length });
  return out;
}

module.exports = { enabled, parseReceipt };
