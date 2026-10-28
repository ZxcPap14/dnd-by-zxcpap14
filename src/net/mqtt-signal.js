// mqtt-signal.js — сигналинг через публичные MQTT-брокеры по WebSocket.
// 0.peerjs.com недоступен из РФ без VPN (плейтест), а EMQX/HiveMQ — доступны.
// MQTT используется ТОЛЬКО как рандеву (SDP/ICE), игровой трафик идёт по P2P WebRTC.

const MQTT_CDNS = [
  'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js',
  'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js'
];

// Порядок = приоритет. EMQX первый: стабильно работает из РФ и Китая.
export const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];

const BROKER_TIMEOUT_MS = 7000;

export const NS = 'dndzxc14/v1';
export const roomTopic = code => `${NS}/r/${String(code).toLowerCase()}`;
export const clientTopic = id => `${NS}/c/${id}`;

/** Валидация конверта сигналинга. Возвращает нормализованный объект или null. */
export function parseEnvelope(raw) {
  let env = raw;
  if (typeof raw === 'string') {
    try { env = JSON.parse(raw); } catch { return null; }
  }
  if (!env || typeof env !== 'object') return null;
  if (typeof env.kind !== 'string') return null;
  if (typeof env.from !== 'string' || !env.from) return null;
  if (!['host-here', 'offer', 'answer', 'ice', 'bye', 'relay-hello', 'relay-msg', 'relay-bye', 'relay-ping'].includes(env.kind)) return null;
  if (env.kind === 'relay-msg' && typeof env.msg !== 'object') return null;
  return env;
}

export function loadMqtt() {
  if (globalThis.mqtt) return Promise.resolve();
  let i = 0;
  return new Promise((resolve, reject) => {
    const tryNext = () => {
      if (i >= MQTT_CDNS.length) {
        reject(new Error('Не удалось загрузить MQTT-клиент — проверь интернет'));
        return;
      }
      const s = document.createElement('script');
      s.src = MQTT_CDNS[i++];
      s.onload = () => { if (globalThis.mqtt) resolve(); else tryNext(); };
      s.onerror = () => tryNext();
      document.head.appendChild(s);
    };
    tryNext();
  });
}

/**
 * Подключение к первому живому брокеру из списка (или к customUrl — для тестов).
 * Публичные брокеры иногда флакают/лимитируют — потому перебор.
 * opts.will — MQTT-завещание {topic, payload} на случай обрыва связи.
 */
export async function connectMqttBroker(customUrl, opts = {}) {
  await loadMqtt();
  const list = customUrl ? [customUrl] : MQTT_BROKERS;
  let lastErr = null;
  for (const url of list) {
    try {
      return await new Promise((resolve, reject) => {
        const client = globalThis.mqtt.connect(url, {
          clientId: 'dnd-' + Math.random().toString(36).slice(2, 10),
          connectTimeout: BROKER_TIMEOUT_MS,
          keepalive: 30,
          clean: true,
          ...(opts.will ? { will: { qos: 0, retain: false, ...opts.will } } : {})
        });
        const t = setTimeout(() => { try { client.end(true); } catch { /* ignore */ } reject(new Error('timeout ' + url)); }, BROKER_TIMEOUT_MS);
        client.on('connect', () => { clearTimeout(t); resolve(client); });
        client.on('error', e => { clearTimeout(t); try { client.end(true); } catch { /* ignore */ } reject(e); });
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('Ни один MQTT-брокер не ответил (' + (lastErr && lastErr.message || 'нет сети') + ')');
}
