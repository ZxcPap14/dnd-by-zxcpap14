// relay-server.mjs — Node-версия релея (локально / свой VPS).
//
// Логика комнаты одна и та же, что и в Cloudflare-версии: src/net/relayroom.js.
// Этот файл нужен для локальной проверки и для тех, у кого есть сервер.
//
// Запуск: npm run relay        (порт PORT, по умолчанию 9001)
// Адрес для игры: http://127.0.0.1:9001 (на сервере — https://relay.example.com)

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Room } from '../src/net/relayroom.js';

const PORT = Number(process.env.PORT || 9001);
const rooms = new Map(); // code -> Room (комната живёт, пока в ней есть сокеты)

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('dnd relay ok\n');
});

const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay');
  const m = url.pathname.match(/^\/room\/([^/]+)\/?$/);
  if (!m) { socket.destroy(); return; }
  const code = decodeURIComponent(m[1]).toLowerCase();

  wss.handleUpgrade(req, socket, head, ws => {
    let room = rooms.get(code);
    if (!room) {
      room = new Room({ onEmpty: () => rooms.delete(code) });
      rooms.set(code, room);
    }
    const sock = {
      id: url.searchParams.get('id') || 'anon',
      send: obj => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      close: () => { try { ws.close(); } catch { /* ignore */ } }
    };
    ws.on('message', raw => room.receive(sock, raw.toString()));
    ws.on('close', () => room.detach(sock));
    room.attach(url.searchParams.get('role') === 'host' ? 'host' : 'client', sock.id, sock);
  });
});

http.listen(PORT, () => console.log('relay: http://127.0.0.1:' + PORT + '  (wss в бою — через https)'));
setInterval(() => {
  if (rooms.size) console.log(new Date().toISOString().slice(11, 19), 'комнат:', rooms.size);
}, 60000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    wss.close();
    http.close(() => process.exit(0));
  });
}
