// relay-broker.mjs — свой MQTT-брокер по WebSocket.
//
// Зачем: публичные брокеры не годятся как постоянный канал из РФ. Замеры
// (broker.emqx.io, wss:8084): соединение умирает на ~45-й секунде с
// «Keepalive timeout» даже когда клиент исправно шлёт PINGREQ; hivemq и
// mosquitto из РФ вообще не отвечают connack. Свой брокер держит сессию,
// пока живы игроки.
//
// Запуск:  npm install && node server/relay-broker.mjs
// Порт:    PORT (по умолчанию 9001), путь /mqtt
//
// Наружу нужен TLS, иначе браузер со страницы https:// не подключится.
// Любой из вариантов:
//   Caddy:      relay.example.com { reverse_proxy 127.0.0.1:9001 }
//   Nginx:      location /mqtt { proxy_pass http://127.0.0.1:9001; proxy_http_version 1.1;
//                                proxy_set_header Upgrade $http_upgrade;
//                                proxy_set_header Connection "upgrade"; }
//   Cloudflare Tunnel: cloudflared tunnel --url http://127.0.0.1:9001
// Итоговый адрес для игры: wss://relay.example.com/mqtt
// Его вписывают в настройках «СЕТЬ → MQTT-релей» (или в ссылке ?relay=...).

import { createServer } from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import aedesFactory from 'aedes';

const PORT = Number(process.env.PORT || 9001);
const broker = aedesFactory();

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('relay broker ok\n');
});

const wss = new WebSocketServer({ server: http, path: '/mqtt' });
wss.on('connection', ws => {
  const stream = createWebSocketStream(ws);
  broker.handle(stream);
});

// Диагностика: сколько живых сессий, чтобы понимать, что брокер не пуст.
setInterval(() => {
  const n = Object.keys(broker.clients || {}).length;
  if (n) console.log(new Date().toISOString().slice(11, 19), 'sessions:', n);
}, 60000).unref();

http.listen(PORT, () => console.log('relay broker: ws://127.0.0.1:' + PORT + '/mqtt'));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('stopping…');
    wss.close();
    http.close(() => broker.close(() => process.exit(0)));
  });
}
