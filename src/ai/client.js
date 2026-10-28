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
     * @param {{temperature?: number, maxTokens?: number}} [opts]
     * @returns {Promise<string>} текст первого ответа
     */
    async chat(messages, opts = {}) {
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: opts.temperature ?? 0.9,
          max_tokens: opts.maxTokens ?? 600
        })
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`AI API ${res.status}: ${body.slice(0, 200)}`);
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
 * @returns {object|null}
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced && fenced[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch { /* пробуем дальше */ }
  }
  return null;
}
