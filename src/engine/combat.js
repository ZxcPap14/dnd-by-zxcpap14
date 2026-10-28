// combat.js — бои в стиле D&D: инициатива, атаки d20, криты 20/1, таблица дропа.
// Кубики только отсюда: «ИИ предлагает — код решает».

import { mod } from './rng.js';
import { makeItem } from './player.js';

/**
 * Инициатива: d20 + ловкость.
 */
export function rollInitiative(dice, dexStat) {
  const { raw, total } = dice.check(mod(dexStat));
  return { raw, total };
}

/**
 * Атака игрока.
 * @returns {{raw:number, total:number, hit:boolean, crit:boolean, fumble:boolean}}
 */
export function attackRoll(dice, attackerStats, weapon, targetAc) {
  const ability = weapon.type === 'weapon' && weapon.finesse ? 'dex' : 'str';
  const m = mod(attackerStats[ability]) + (weapon.bonus || 0);
  const raw = dice.d20();
  const total = raw + m;
  return {
    raw,
    total,
    crit: raw === 20,
    fumble: raw === 1,
    hit: raw === 20 || (raw !== 1 && total >= targetAc)
  };
}

/**
 * Урон. На крите — двойной бросок кубиков.
 * @returns {{rolls:number[], total:number, crit:boolean}}
 */
export function damageRoll(dice, weapon, strStat, crit = false) {
  const base = Math.max(1, weapon.dmg || 2);
  const count = (crit ? 2 : 1) * base;
  const { rolls, total } = dice.roll(count, 4); // Nd4 — олдскульно и кроваво
  const bonus = mod(strStat) * (crit ? 2 : 1);
  return { rolls, total: Math.max(1, total + bonus), crit };
}

/**
 * Атака монстра по игроку.
 * @param monster {{toHit:number, dmg:number, name:string}}
 * @returns {{raw:number, total:number, hit:boolean, crit:boolean, dmg:number}}
 */
export function monsterAttack(dice, monster, playerAcValue) {
  const raw = dice.d20();
  const total = raw + (monster.toHit || 1);
  const hit = raw === 20 || (raw !== 1 && total >= playerAcValue);
  const crit = raw === 20;
  const dmg = hit ? Math.max(1, dice.roll(crit ? monster.dmg * 2 : monster.dmg, 4).total) : 0;
  return { raw, total, hit, crit, dmg };
}

/**
 * Таблица дропа: [{chance, item}] — chance в [0..1], проверяются по порядку.
 * Ничего не выпало → null.
 */
export function rollDrop(dice, dropTable, depth = 1) {
  for (const entry of dropTable) {
    if (dice.d(100) / 100 <= entry.chance) {
      const base = entry.item;
      // глубокие этажи — чуть злее лут
      const scaled = { ...base };
      if (base.type === 'weapon' && depth > 2 && dice.d(3) === 1) {
        scaled.name = `${base.name} (заточенное)`;
        scaled.dmg = base.dmg + 1;
        scaled.bonus = (base.bonus || 0) + 1;
      }
      return makeItem(scaled);
    }
  }
  return null;
}

export const BASIC_DROP_TABLE = [
  { chance: 0.25, item: { name: 'Зелье лечения', type: 'potion', heal: 8, qty: 1 } },
  { chance: 0.15, item: { name: 'Кинжал', type: 'weapon', dmg: 2, finesse: true } },
  { chance: 0.10, item: { name: 'Кожаная броня', type: 'armor', ac: 2 } },
  { chance: 0.08, item: { name: 'Короткий меч', type: 'weapon', dmg: 3 } },
  { chance: 0.20, item: { name: 'Горсть монет', type: 'gold', qty: 15 } }
];
