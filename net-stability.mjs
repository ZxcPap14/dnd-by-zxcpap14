// Живучесть публичного брокера: держим хоста 90 с без клиента, потом подключаем
// клиента и смотрим, дошло ли retained-присутствие и обычное сообщение.
import mqtt from 'mqtt';

const URL = process.env.BROKER || 'wss://broker.emqx.io:8084/mqtt';
const ROOM = 'dndzxc14/v2/probe/' + Math.random().toString(16).slice(2, 6);
const HOST = 'h-probe';
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

const host = mqtt.connect(URL, { clientId: 'probe-host', clean: true, keepalive: 30, reconnectPeriod: 0 });
host.on('connect', () => console.log(stamp(), 'host connected'));
host.on('close', () => console.log(stamp(), 'host CLOSE, connected=', host.connected));
host.on('offline', () => console.log(stamp(), 'host OFFLINE'));
host.on('error', e => console.log(stamp(), 'host error', e.message));

await new Promise(r => host.on('connect', r));
host.publish(ROOM, JSON.stringify({ kind: 'host-here', from: HOST, ts: Date.now() }), { qos: 1, retain: true }, e => console.log(stamp(), 'presence', e ? e.message : 'ok'));

await new Promise(r => setTimeout(r, 90000));
console.log(stamp(), 'after 90s idle: connected =', host.connected);

const client = mqtt.connect(URL, { clientId: 'probe-client', clean: true, keepalive: 30, reconnectPeriod: 0 });
await new Promise(r => client.on('connect', r));
let gotPresence = false, gotMsg = false;
client.on('message', (t, raw) => {
  const env = JSON.parse(raw.toString());
  if (env.kind === 'host-here') { gotPresence = true; console.log(stamp(), 'client got presence, age', ((Date.now() - env.ts) / 1000).toFixed(1) + 's'); }
  if (env.kind === 'msg') { gotMsg = true; console.log(stamp(), 'client got msg, bytes', raw.length); }
});
client.subscribe(ROOM, { qos: 1 });
await new Promise(r => setTimeout(r, 1500));

// 4 КБ — размер реального снапшота партии
host.publish(ROOM, JSON.stringify({ kind: 'msg', from: HOST, msg: { t: 'snapshot', pad: 'x'.repeat(4000) } }), { qos: 1 }, e => console.log(stamp(), 'snapshot publish', e ? e.message : 'ok'));
await new Promise(r => setTimeout(r, 3000));

// серия из 5 снапшотов подряд, как при череде ходов
for (let i = 0; i < 5; i++) host.publish(ROOM, JSON.stringify({ kind: 'msg', from: HOST, msg: { t: 'snapshot', i, pad: 'x'.repeat(3600) } }), { qos: 1 });
await new Promise(r => setTimeout(r, 4000));

console.log(stamp(), 'RESULT presence =', gotPresence, '| snapshot =', gotMsg, '| host connected =', host.connected);
host.publish(ROOM, '', { retain: true });
await new Promise(r => setTimeout(r, 500));
host.end(true); client.end(true);
process.exit(0);
