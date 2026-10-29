// player.js — персонаж: 6 статов D&D, XP/уровни, инвентарь, экипировка.

import { mod } from './rng.js';

// ре-экспорт для удобства потребителей
export { mod };

export const STAT_NAMES = {
  str: 'Сила', dex: 'Ловкость', int: 'Интеллект',
  con: 'Выносливость', cha: 'Харизма', luck: 'Удача'
};

let itemSeq = 0;

export function makeItem({ name, type, dmg = 0, ac = 0, heal = 0, bonus = 0, qty = 1, finesse = false }) {
  return { id: `it${++itemSeq}`, name, type, dmg, ac, heal, bonus, qty, finesse };
}

/**
 * Поднять счётчик id выше уже существующих. Нужен после загрузки сейва:
 * счётчик модуля сбрасывается в 0 при перезагрузке страницы, и новый предмет
 * получал бы id, который уже занят старым (removeItem тогда удаляет не тот).
 */
export function syncItemSeq(ids = []) {
  for (const id of ids) {
    const n = Number(String(id ?? '').replace(/\D+/g, ''));
    if (Number.isFinite(n) && n > itemSeq) itemSeq = n;
  }
}

/**
 * Создание героя.
 * @param {{name: string, className: string, stats?: Record<string,number>,
 *           ability?: {name?: string, active: string, power: number, cd: number, passive: string, passivePower: number}}} opts
 */
export function createPlayer({ name, className, stats, ability }) {
  const s = { str: 12, dex: 12, int: 12, con: 12, cha: 12, luck: 12, ...stats };
  const player = {
    name: name || 'Безымянный',
    className: className || 'Искатель приключений',
    level: 1,
    xp: 0,
    stats: s,
    maxHp: 12 + mod(s.con) * 2,
    hp: 0,
    gold: 0,
    inventory: [],
    equipment: { weapon: null, armor: null }
  };
  // способность класса (кастомные классы): актив + пассивка
  player.ability = sanitizeAbility(ability);
  // ход, с которого актив снова доступен (кулдаун считается по номеру хода —
  // так его нельзя «протикнуть» неудачными попытками)
  player.abilityReady = 0;
  player.hp = player.maxHp;
  return player;
}

const ACTIVE_TYPES = ['heal', 'smite', 'stun', 'dash'];
const PASSIVE_TYPES = ['crit', 'lifesteal', 'regen', 'gold', 'ac'];

/** Нормализация способности класса: мусор отбрасывается, числа зажимаются. */
export function sanitizeAbility(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  if (ACTIVE_TYPES.includes(a.active)) out.active = a.active;
  if (PASSIVE_TYPES.includes(a.passive)) out.passive = a.passive;
  if (!out.active && !out.passive) return null;
  out.name = String(a.name || '').slice(0, 30).trim() || 'Способность';
  if (out.active) {
    out.power = Math.max(1, Math.min(20, (a.power | 0) || 5));
    out.cd = Math.max(1, Math.min(20, (a.cd | 0) || 3));
  }
  if (out.passive) {
    out.passivePower = Math.max(1, Math.min(5, (a.passivePower | 0) || 2));
  }
  return out;
}

/** Диапазон крита пассивки: 1 = только nat20, 5 = 16-20. */
export function abilityCritRange(player) {
  const a = player?.ability;
  return a?.passive === 'crit' ? Math.max(1, Math.min(5, a.passivePower | 0)) : 1;
}

/** Вампиризм в процентах: 5..25. */
export function abilityLifesteal(player) {
  const a = player?.ability;
  return a?.passive === 'lifesteal' ? Math.max(0, Math.min(25, (a.passivePower | 0) * 5)) : 0;
}

/** Регенерация за свой ход: 0..3 HP. */
export function abilityRegen(player) {
  const a = player?.ability;
  return a?.passive === 'regen' ? Math.max(0, Math.min(3, a.passivePower | 0)) : 0;
}

/** Множитель золота: 1..2.25. */
export function abilityGoldMult(player) {
  const a = player?.ability;
  return a?.passive === 'gold' ? 1 + Math.max(0, Math.min(5, a.passivePower | 0)) * 0.25 : 1;
}

/** Сколько XP нужно для перехода на следующий уровень. */
export function xpForNextLevel(level) {
  return level * 100;
}

/**
 * Начисление XP (опыт за всё по спецификации).
 * rng — кубик партии: прибавка HP за уровень должна идти из того же
 * seeded-потока, иначе после загрузки сейва развитие героя расходится с забегом.
 * @returns {number} сколько уровней получено
 */
export function gainXp(player, amount, rng = null) {
  player.xp += Math.max(0, amount | 0);
  let levels = 0;
  while (player.xp >= xpForNextLevel(player.level)) {
    player.xp -= xpForNextLevel(player.level);
    player.level++;
    levels++;
    const roll = rng ? Math.floor(rng() * 3) : Math.floor(Math.random() * 3);
    const gain = 4 + roll + mod(player.stats.con);
    player.maxHp += gain;
    player.hp += gain;
  }
  return levels;
}

/** Защита: 10 + ловкость + броня (+ пассивка класса). */
export function playerAc(player) {
  let ac = 10 + mod(player.stats.dex);
  if (player.equipment.armor) ac += player.equipment.armor.ac;
  const a = player.ability;
  if (a?.passive === 'ac') ac += Math.max(1, Math.min(3, a.passivePower | 0));
  return ac;
}

/** Оружейный бонус к атаке и урон. Кулаки — общий объект: новый id на каждый удар не нужен. */
const FISTS = Object.freeze({ id: 'fists', name: 'кулаки', type: 'weapon', dmg: 2, ac: 0, heal: 0, bonus: 0, qty: 1, finesse: false });

export function playerWeapon(player) {
  return player.equipment.weapon || FISTS;
}

export function addItem(player, item) {
  const same = player.inventory.find(i => i.name === item.name && i.type === item.type);
  if (same && item.type === 'potion') { same.qty += item.qty; return same; }
  player.inventory.push(item);
  return item;
}

export function removeItem(player, itemId, qty = 1) {
  const idx = player.inventory.findIndex(i => i.id === itemId);
  if (idx === -1) return null;
  const item = player.inventory[idx];
  if (item.qty > qty) { item.qty -= qty; } else { player.inventory.splice(idx, 1); }
  return item;
}

export function findItem(player, namePart) {
  const q = (namePart || '').toLowerCase().trim();
  if (!q) return null;
  return player.inventory.find(i => i.name.toLowerCase().includes(q)) || null;
}

/**
 * Экипировка предмета (снимает прежний в слоте обратно в инвентарь).
 * @returns {{equipped: object|null, unequipped: object|null}}
 */
export function equipItem(player, item) {
  if (!item) return { equipped: null, unequipped: null };
  const slot = item.type === 'weapon' ? 'weapon' : item.type === 'armor' ? 'armor' : null;
  if (!slot) return { equipped: null, unequipped: null };
  const prev = player.equipment[slot];
  player.inventory = player.inventory.filter(i => i.id !== item.id);
  player.equipment[slot] = item;
  if (prev) player.inventory.push(prev);
  return { equipped: item, unequipped: prev };
}
