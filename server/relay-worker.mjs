// relay-worker.mjs — Cloudflare Workers: релей, который живёт без вашего сервера.
//
// Почему так: GitHub Pages — только файлы, там сервер запустить нельзя. Workers
// держат код всегда онлайн, бесплатного тарифа хватает с запасом: комната = один
// Durable Object, трафик — одна пересылка JSON на ход.
//
// Деплой один раз:
//   npm install --save-dev wrangler
//   npx wrangler deploy
// Получится адрес https://dnd-relay.<аккаунт>.workers.dev — его вписывают в игре
// в поле «СЕТЬ → Релей» (или в ссылку ?relay=https://...). Больше ничего
// запускать не нужно.
//
// Логика комнаты общая с Node-версией — src/net/relayroom.js.

import { Room } from '../src/net/relayroom.js';

export class RelayRoom {
  constructor() {
    this.room = new Room();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('dnd relay room ok\n');
    }

    const role = url.searchParams.get('role') === 'host' ? 'host' : 'client';
    const id = url.searchParams.get('id') || 'anon';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const sock = {
      id,
      send: obj => { try { server.send(JSON.stringify(obj)); } catch { /* закрыт */ } },
      close: () => { try { server.close(); } catch { /* ignore */ } }
    };
    server.addEventListener('message', e => this.room.receive(sock, e.data));
    server.addEventListener('close', () => this.room.detach(sock));
    this.room.attach(role, id, sock);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([^/]+)\/?$/);
    if (!m) return new Response('dnd relay ok\n');
    // Код комнаты = имя Durable Object, поэтому все игроки одной комнаты
    // попадают в один и тот же объект.
    const room = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(decodeURIComponent(m[1]).toLowerCase()));
    return room.fetch(request);
  }
};
