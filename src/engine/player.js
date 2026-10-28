// player.js — персонаж: 6 статов D&D, XP/уровни, инвентарь, экипировка.

import { mod } from './rng.js';

// ре-экспорт для удобства потребителей
export { mod };

export const STAT_NAMES = {
  str: 'Сила', dex: 'Ловкость', int: 'Интеллект',
  con: 'Выносливость', cha: 'Харизма', luck: 'Удача'
};

let itemSeq = 0;

export function makeItem({ name, type, dmg = 0, ac = 0, heal = 0, bonus = 0, qty = 1 }) {
  return { id: `it${++itemSeq}`, name, type, dmg, ac, heal, bonus, qty };
}

/**
 * Создание героя.
 * @param {{name: string, className: string, stats?: Record<string,number>}} opts
 */
export function createPlayer({ name, className, stats }) {
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
  player.hp = player.maxHp;
  return player;
}

/** Сколько XP нужно для перехода на следующий уровень. */
export function xpForNextLevel(level) {
  return level * 100;
}

/**
 * Начисление XP (опыт за всё по спецификации).
 * @returns {number} сколько уровней получено
 */
export function gainXp(player, amount) {
  player.xp += Math.max(0, amount | 0);
  let levels = 0;
  while (player.xp >= xpForNextLevel(player.level)) {
    player.xp -= xpForNextLevel(player.level);
    player.level++;
    levels++;
    const gain = 4 + Math.floor(Math.random() * 3) + mod(player.stats.con);
    player.maxHp += gain;
    player.hp += gain;
  }
  return levels;
}

/** Защита: 10 + ловкость + броня. */
export function playerAc(player) {
  let ac = 10 + mod(player.stats.dex);
  if (player.equipment.armor) ac += player.equipment.armor.ac;
  return ac;
}

/** Оружейный бонус к атаке и урон. */
export function playerWeapon(player) {
  return player.equipment.weapon || makeItem({ name: 'кулаки', type: 'weapon', dmg: 2 });
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
