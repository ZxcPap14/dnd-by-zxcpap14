// relayroom.js — правила одной комнаты релея.
//
// Одна и та же логика крутится и в Cloudflare Durable Object
// (server/relay-worker.mjs), и в локальном Node-сервере (server/relay-server.mjs),
// поэтому поведение в тестах и в бою совпадает.
//
// Зачем сервер: P2P через WebRTC не пробивается между мобильным интернетом и
// домашним Wi-Fi (CGNAT), а игровой трафик крошечный. Релей просто пересылает
// конверты между хостом и игроками, поэтому держит любой NAT.
//
// Сокет здесь — абстракция: { id, send(obj), close() }. Так комната не знает ни
// про WebSocket в браузере, ни про Durable Object на сервере.

const PING_MS = 15000;       // клиенты шлют ping, чтобы не отваливаться в тишине
const SILENCE_MS = 45000;    // столько тишины = игрок ушёл (мобильная сеть съела сокет)
const PRUNE_MS = 15000;

export class Room {
  constructor({ onEmpty = null } = {}) {
    this.host = null;
    this.clients = new Map();       // id -> socket
    this.lastSeen = new Map();      // id -> ts
    this.onEmpty = onEmpty;
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_MS);
    this.pruneTimer.unref?.();
  }

  send(sock, obj) {
    try { sock.send(obj); } catch { /* сокет уже закрыт */ }
  }

  /**
   * Подключить сокет к комнате. Роль 'host' — единственная, второй хост в ту же
   * комнату не пускаем: иначе игроки попадут не к своему «рефери».
   */
  attach(role, id, sock) {
    sock.id = id;
    this.lastSeen.set(id, Date.now());

    if (role === 'host') {
      if (this.host) {
        this.send(sock, { t: 'err', error: 'В этой комнате уже есть хост' });
        sock.close();
        return false;
      }
      this.host = sock;
      // Игроки, которые ждали хоста, узнают о нём сразу — без опроса сервера.
      for (const [cid] of this.clients) {
        this.send(sock, { t: 'join', id: cid });
        this.send(this.clients.get(cid), { t: 'host', id });
      }
      return true;
    }

    // Переподключение тем же id (оборвался Wi-Fi) — старый сокет выкидываем.
    const prev = this.clients.get(id);
    if (prev && prev !== sock) {
      this.clients.delete(id);
      try { prev.close(); } catch { /* ignore */ }
    }
    this.clients.set(id, sock);
    if (this.host) {
      this.send(sock, { t: 'host', id: this.host.id });
      this.send(this.host, { t: 'join', id });
    } else {
      this.send(sock, { t: 'nohost' });
    }
    return true;
  }

  /** Конверт от сокета. Всё незнакомое молча игнорируем — это публичный сервер. */
  receive(sock, raw) {
    let env;
    try { env = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { return; }
    if (!env || typeof env !== 'object') return;
    this.lastSeen.set(sock.id, Date.now());

    if (env.t === 'ping') { this.send(sock, { t: 'pong' }); return; }
    if (env.t !== 'msg' || !env.msg || typeof env.msg !== 'object') return;

    // Хост — «рефери»: его сообщение broadcast либо адресное игроку.
    if (sock === this.host) {
      if (env.to) {
        const target = this.clients.get(env.to);
        if (target) this.send(target, { t: 'msg', msg: env.msg });
      } else {
        for (const c of this.clients.values()) this.send(c, { t: 'msg', msg: env.msg });
      }
      return;
    }
    if (!this.host) { this.send(sock, { t: 'nohost' }); return; }
    this.send(this.host, { t: 'msg', from: sock.id, msg: env.msg });
  }

  detach(sock) {
    if (sock === this.host) {
      this.host = null;
      this.lastSeen.delete(sock.id);
      // Хост ушёл — игрокам дальше ждать нечего, пусть ищут другой канал.
      for (const c of [...this.clients.values()]) {
        this.send(c, { t: 'bye' });
        try { c.close(); } catch { /* ignore */ }
      }
      this.clients.clear();
      this.lastSeen.clear();
    } else if (this.clients.get(sock.id) === sock) {
      this.clients.delete(sock.id);
      this.lastSeen.delete(sock.id);
      if (this.host) this.send(this.host, { t: 'leave', id: sock.id });
    }
    this.checkEmpty();
  }

  /** Молчащие сокеты — мёртвые: мобильный NAT рвёт их без close-события. */
  prune() {
    const now = Date.now();
    for (const [id, ts] of this.lastSeen) {
      if (now - ts < SILENCE_MS) continue;
      const sock = id === this.host?.id ? this.host : this.clients.get(id);
      if (!sock) { this.lastSeen.delete(id); continue; }
      try { sock.close(); } catch { /* ignore */ }
      // close() в некоторых средах не даёт события — подчищаем руками.
      this.detach(sock);
    }
    this.checkEmpty();
  }

  get empty() { return !this.host && this.clients.size === 0; }

  checkEmpty() {
    if (!this.empty) return;
    clearInterval(this.pruneTimer);
    if (this.onEmpty) this.onEmpty();
  }
}
