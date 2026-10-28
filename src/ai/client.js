// client.js — тонкий клиент любого OpenAI-совместимого API.
// fetch инжектится для тестируемости (в браузере — глобальный fetch).

/**
 * @param {{baseUrl: string, apiKey: string, model: string, fetch?: typeof fetch}} cfg
 */
export function createClient(cfg) {
  const doFetch = cfg.fetch || globalThis.fetch;
  const baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    model: cfg.model,
    /**
     * @param {Array<{role:string, content:string}>} messages
     * @param {{temperature?: number, maxTokens?: number, jsonMode?: boolean}} [opts]
     * @returns {Promise<string>} текст первого ответа
     */
    async chat(messages, opts = {}) {
      const body = {
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0.9,
        max_tokens: opts.maxTokens ?? 600
      };
      if (opts.jsonMode) body.response_format = { type: 'json_object' };

      let res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body)
      });

      // провайдер не знает response_format — повторяем без него
      if (res.status === 400 && opts.jsonMode) {
        const errText = await res.text().catch(() => '');
        if (/response_format|json_object/i.test(errText)) {
          delete body.response_format;
          res = await doFetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cfg.apiKey}`
            },
            body: JSON.stringify(body)
          });
        } else {
          return Promise.reject(new Error(`AI API 400: ${errText.slice(0, 200)}`));
        }
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`AI API ${res.status}: ${bodyText.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Пустой ответ от ИИ');
      return content;
    }
  };
}

/**
 * Достать JSON из ответа модели (устойчиво к ```json обёрткам и болтовне).
 * Умеет спасать JSON, обрезанный по лимиту токенов (finish_reason=length).
 * @returns {object|null}
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const c of [fenced && fenced[1], text]) {
    if (!c) continue;
    const obj = tryParseJson(c);
    if (obj) return obj;
  }
  return null;
}

function tryParseJson(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  const body = s.slice(start);

  // 1) точный парс
  const end = body.lastIndexOf('}');
  if (end > 0) {
    try { return JSON.parse(body.slice(0, end + 1)); } catch { /* пробуем дальше */ }
  }

  // 2) спасение обрезанного: сканируем и закрываем незакрытые строку/скобки
  let depth = 0, inStr = false, esc = false, lastComplete = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') { inStr = false; lastComplete = i; }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { try { return JSON.parse(body.slice(0, i + 1)); } catch { break; } }
      lastComplete = i;
    }
  }
  let out = body;
  if (inStr) out += '"';
  if (depth > 0) out += '}'.repeat(depth);
  out = out.replace(/,\s*([\]}])/g, '$1');          // висячая запятая
  try { return JSON.parse(out); } catch { /* дальше грубее */ }

  // 3) грубая зачистка: отрезаем хвост по последнему разделителю и пробуем снова
  let s3 = body;
  for (let i = 0; i < 50 && s3.length > 2; i++) {
    const cut = Math.max(s3.lastIndexOf(','), s3.lastIndexOf('"'));
    if (cut <= 0) return null;
    s3 = s3.slice(0, cut);
    try { return JSON.parse(s3.replace(/,\s*$/, '') + '}'); } catch { /* ещё короче */ }
  }
  return null;
}
