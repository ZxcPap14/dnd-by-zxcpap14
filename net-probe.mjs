// Разведка каналов: что реально доступно из этой сети (РФ).
// Проверяем публичные MQTT-брокеры по WSS и CDN, откуда грузятся сетевые модули.
import mqtt from 'mqtt';

const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt'
];

const CDNS = [
  'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js',
  'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js',
  'https://esm.run/trystero@0.26.0',
  'https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm'
];

const probeBroker = url => new Promise(resolve => {
  const t0 = Date.now();
  let done = false;
  const c = mqtt.connect(url, { connectTimeout: 8000, reconnectPeriod: 0, clean: true, clientId: 'probe-' + Math.random().toString(16).slice(2) });
  const fin = (ok, note) => {
    if (done) return;
    done = true;
    resolve({ url, ok, ms: Date.now() - t0, note });
    try { c.end(true); } catch {}
  };
  c.on('connect', () => fin(true, 'ok'));
  c.on('error', e => fin(false, e.message));
  setTimeout(() => fin(false, 'timeout'), 9000);
});

const probeUrl = async url => {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    return { url, ok: r.ok, ms: Date.now() - t0, note: 'HTTP ' + r.status };
  } catch (e) { return { url, ok: false, ms: Date.now() - t0, note: e.name + ' ' + e.message }; }
};

const rows = await Promise.all([...BROKERS.map(probeBroker), ...CDNS.map(probeUrl)]);
for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + String(r.ms).padStart(5) + 'ms  ' + r.url + '  ' + r.note);
process.exit(0);
