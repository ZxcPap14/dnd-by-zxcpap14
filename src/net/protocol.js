// protocol.js — версия протокола и константы мультиплеера.

export const PROTOCOL_VER = 'mp2';
export const TURN_MS = 60000;          // таймер хода (0 = выключен)
export const FREE_COOLDOWN_MS = 3000;  // антиспам свободного текста (ключ хоста!) — 3с: свобода важнее паранойи
export const SAY_COOLDOWN_MS = 1200;   // реплики в чат партии: не тратят ход, но и спамить не дают
export const MAX_PLAYERS = 4;
export const RECONNECT_GRACE_MS = 180000; // сколько герой ждёт потерявшего связь игрока
