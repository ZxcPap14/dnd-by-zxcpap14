// relay.js — гарантированный канал через собственный WebSocket-релей.
//
// Зачем: P2P (Trystero/STUN) не пробивается через CGNAT и мобильный интернет —
// хост виден, а ICE умирает молча. Игровой трафик тут крошечный (ходы +
// снапшот), поэтому релею хватает одного сокета на игрока и он работает за
// любым NAT. Это НЕ замена P2P: hybrid.js пробует P2P первым, релей — фолбэк.
//
// Сервер: server/relay-worker.mjs (Cloudflare Workers, бесплатно, всегда онлайн)
// или server/relay-server.mjs (обычный Node). Правила комнаты у них общие —
// src/net/relayroom.js. Браузер про сервер ничего не знает и говорит только
// на этом протоколе.
//
// Интерфейсы 1:1 с peer.js/trystero.js, host.js и client.js о канале не знают.

const RELAY_KEY = 'dnd-relay-v1';
let relayMemory = null; // в node (тесты) localStorage нет — храним в памяти

// Адрес релея по умолчанию. Заполняется после деплоя воркера, и тогда игрокам
// вообще ничего не надо настраивать: открыл сайт — играешь.
export const DEFAULT_RELAY_URL = 'https://dnd-relay.deniskaz-80.workers.dev';

const OPEN_TIMEOUT_MS = 9000;
const RETRIES = 6;
const PING_MS = 10000;

const relayId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

/** ?relay=https://... — оверрайд для e2e и быстрой ссылки другу. */
export function relayUrlOverride() {
  try {
    const q = new URLSearchParams(globalThis.location.search);
    return q.get('relay') || q.get('mqtt') || undefined;
  } catch { return undefined; }
}

/** Адрес релея, сохранённый в настройках («СЕТЬ»). Пустая строка — сброс. */
export function loadRelayUrl() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RELAY_KEY) : relayMemory;
    return raw || '';
  } catch { return ''; }
}

export function saveRelayUrl(text) {
  const s = String(text || '').trim();
  if (s && !/^(wss?|https?):\/\/\S+$/.test(s)) {
    return { ok: false, error: 'Нужен адрес вида https://relay.example.workers.dev' };
  }
  try {
    if (typeof localStorage !== 'undefined') {
      if (s) localStorage.setItem(RELAY_KEY, s); else localStorage.removeItem(RELAY_KEY);
    } else relayMemory = s;
  } catch { relayMemory = s; }
  return { ok: true, url: s };
}

/** Базовый адрес релея: аргумент → ?relay= → сохранённый → встроенный. */
export function relayBase(custom) {
  const raw = custom || relayUrlOverride() || loadRelayUrl() || DEFAULT_RELAY_URL;
  if (!raw) throw new Error('Релей не настроен — впиши адрес в настройках СЕТИ');
  return String(raw).split(',')[0].trim();
}

export function shortRelay(base) {
  try { return new URL(base.replace(/^ws/, 'http')).hostname; } catch { return String(base); }
}

/** https://host → wss://host/room/CODE?role=... (браузер не пустит ws:// со https-страницы). */
export function roomUrl(base, code, role, id) {
  const clean = String(base).trim().replace(/\/+$/, '').replace(/\/room\/.*$/, '');
  const proto = clean.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return `${proto}/room/${encodeURIComponent(String(code).toLowerCase())}?role=${role}&id=${encodeURIComponent(id)}`;
}

/**
 * Сокет комнаты с автопереподключением.
 * onFrame — входящий конверт; onDead — переподключиться не удалось (канал мёртв).
 * Переподключение нужно из-за мобильных сетей: сокет рвётся на минуту и
 * возвращается, а комната и партия живут дальше.
 */
function linkSocket(url, { onOpen, onFrame, onDead }) {
  let ws = null, dead = false, tries = 0, retryTimer = null, openTimer = null;

  const schedule = () => {
    if (dead) return;
    if (++tries > RETRIES) { dead = true; onDead(); return; }
    retryTimer = setTimeout(open, Math.min(4000, 700 * tries));
  };

  function open() {
    try { ws = new WebSocket(url); } catch { schedule(); return; }
    openTimer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, OPEN_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(openTimer); tries = 0; if (onOpen) onOpen(); };
    ws.onmessage = e => {
      let env;
      try { env = JSON.parse(e.data); } catch { return; }
      onFrame(env);
    };
    ws.onclose = () => { clearTimeout(openTimer); schedule(); };
  }

  open();

  return {
    send(env) {
      if (dead || !ws || ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(env)); } catch { /* ignore */ }
    },
    close() {
      dead = true;
      clearTimeout(retryTimer);
      clearTimeout(openTimer);
      try { if (ws) ws.close(); } catch { /* ignore */ }
    },
    get dead() { return dead; }
  };
}

/**
 * Сеть хоста через релей.
 * Интерфейс: { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave, close, transport }
 */
export async function createRelayHostNet(code, { relayUrl } = {}) {
  const base = relayBase(relayUrl);
  const hostId = 'h-' + relayId();
  const url = roomUrl(base, code, 'host', hostId);
  const players = new Set();
  let onMsg = null, onJoin = null, onLeave = null, session = null;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('релей не ответил: ' + shortRelay(base))), OPEN_TIMEOUT_MS);
    session = linkSocket(url, {
      onOpen() { clearTimeout(timer); resolve(); },
      onFrame(env) {
        if (env.t === 'join') { players.add(env.id); if (onJoin) onJoin(env.id); return; }
        if (env.t === 'leave') { players.delete(env.id); if (onLeave) onLeave(env.id); return; }
        if (env.t === 'msg' && onMsg) onMsg(env.from, env.msg);
        if (env.t === 'err') clearTimeout(timer), reject(new Error(env.error));
      },
      onDead() { clearTimeout(timer); reject(new Error('релей отвалился: ' + shortRelay(base))); }
    });
  });

  const ping = setInterval(() => session.send({ t: 'ping' }), PING_MS);

  return {
    transport: 'relay',
    relay: shortRelay(base),
    broadcast(msg) {
      if (players.size) session.send({ t: 'msg', msg });
    },
    sendTo(id, msg) {
      if (players.has(id)) session.send({ t: 'msg', to: id, msg });
    },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    close() {
      clearInterval(ping);
      if (!session) return;
      // bye в этом протоколе не нужен: сервер сам рассылает leave при закрытии.
      session.close();
    }
  };
}

/**
 * Линк клиента через релей.
 * Интерфейс: { send, onMessage, onClose, close, transport }
 */
export async function createRelayClientLink(code, { relayUrl, hostWaitMs = 10000 } = {}) {
  const base = relayBase(relayUrl);
  const myId = 'c-' + relayId();
  const url = roomUrl(base, code, 'client', myId);
  const inbox = [];
  let onMsg = null, onClose = null, ready = false, closed = false, session = null, ping = null;

  const make = () => ({
    transport: 'relay',
    relay: shortRelay(base),
    send(msg) { if (!closed) session.send({ t: 'msg', msg }); },
    onMessage(cb) {
      onMsg = cb;
      inbox.splice(0).forEach(m => cb(m));
    },
    onClose(cb) { onClose = cb; },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      session.close();
    }
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(arg);
    };
    const deadline = setTimeout(() => {
      if (session) session.close();
      const err = new Error('Хост не найден через релей (' + shortRelay(base) + ') — проверь код комнаты');
      err.relayNoHost = true;
      finish(reject, err);
    }, hostWaitMs);

    session = linkSocket(url, {
      onFrame(env) {
        if (env.t === 'host') {
          if (!ready) {
            ready = true;
            ping = setInterval(() => session.send({ t: 'ping' }), PING_MS);
            finish(resolve, make());
          }
          return;
        }
        // 'nohost' — хоста ещё нет, сокет остаётся открытым: сервер пришлёт
        // 'host', как только хост появится.
        if (env.t === 'nohost') return;
        if (env.t === 'bye') { if (!closed) { closed = true; clearInterval(ping); if (onClose) onClose(); } return; }
        if (env.t === 'msg') { if (onMsg) onMsg(env.msg); else inbox.push(env.msg); }
      },
      onDead() {
        if (!ready) {
          const err = new Error('релей недоступен: ' + shortRelay(base));
          err.relayNoHost = true;
          finish(reject, err);
          return;
        }
        if (closed) return;
        closed = true;
        clearInterval(ping);
        if (onClose) onClose();
      }
    });
  });
}
