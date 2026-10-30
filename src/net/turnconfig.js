// turnconfig.js — пользовательский TURN-сервер.
//
// Почему он нужен: бесплатный публичный TURN «Open Relay» (openrelay.metered.ca)
// закрылся — его домен теперь отдаёт фейковые адреса (192.0.2.1 / 100::1,
// зарезервированные RFC 5737/6666), а живых бесплатных TURN без регистрации
// не осталось. Без TURN ICE между двумя разными сетями за NAT/CGNAT умирает
// молча: сигналинг проходит (offer/answer видны в релеях), а соединение не
// открывается — найдено HAR-логом реального клиента.
//
// Выход: игрок вписывает свой TURN в настройках («СЕТЬ»), например бесплатный
// от Cloudflare Calls TURN (developers.cloudflare.com/calls/turn/). Оба
// транспорта — Trystero и PeerJS — подхватывают его при следующем подключении.

const TURN_KEY = 'dnd-turn-v1';
let turnMemory = null; // в node (тесты) localStorage нет — храним в памяти

/** Привести пользовательский ввод к {urls, username, credential} или null. */
export function normalizeTurn(t) {
  if (!t || typeof t !== 'object') return null;
  const isTurnUrl = u => typeof u === 'string' && /^turns?:/.test(u);
  const urls = Array.isArray(t.urls) ? t.urls.filter(isTurnUrl)
    : isTurnUrl(t.urls) ? [t.urls] : null;
  if (!urls || !urls.length || !t.username || !t.credential) return null;
  return { urls, username: String(t.username), credential: String(t.credential) };
}

export function loadCustomTurn() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TURN_KEY) : turnMemory;
    return raw ? normalizeTurn(JSON.parse(raw)) : null;
  } catch { return null; }
}

export function clearCustomTurn() {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(TURN_KEY); } catch { /* ignore */ }
  turnMemory = null;
}

/**
 * Сохранить TURN из строки настроек. Два формата:
 *   turn:host:port?transport=tcp|логин|пароль     (несколько url — через запятую)
 *   {"urls": [...], "username": "...", "credential": "..."}
 * Пустая строка сбрасывает настройку.
 */
export function saveCustomTurn(text) {
  const s = String(text || '').trim();
  if (!s) { clearCustomTurn(); return { ok: true, turn: null }; }
  let t;
  if (s.startsWith('{')) {
    try { t = JSON.parse(s); } catch {
      return { ok: false, error: 'Это не JSON. Формат: {"urls":["turn:..."],"username":"...","credential":"..."}' };
    }
  } else {
    const parts = s.split('|').map(p => p.trim());
    if (parts.length !== 3 || parts.some(p => !p)) {
      return { ok: false, error: 'Формат: turn:host:port|логин|пароль (несколько url — через запятую)' };
    }
    t = { urls: parts[0].split(',').map(x => x.trim()).filter(Boolean), username: parts[1], credential: parts[2] };
  }
  const turn = normalizeTurn(t);
  if (!turn) return { ok: false, error: 'Нужны urls с turn:/turns:, username и credential' };
  const raw = JSON.stringify(turn);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TURN_KEY, raw); else turnMemory = raw;
  } catch { turnMemory = raw; }
  return { ok: true, turn };
}

/** ICE-серверы для обоих транспортов: STUN + пользовательский TURN (если вписан). */
export function iceServers() {
  const stun = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] };
  const turn = loadCustomTurn();
  return turn ? [stun, { urls: turn.urls, username: turn.username, credential: turn.credential }] : [stun];
}
