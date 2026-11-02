// views.js — то, что видит игрок: видимые враги, бой, рюкзак, снапшот.
// Вынесено из game.js: чистые чтения состояния, ни одного изменения.

import { TILE } from './map.js';
import { playerAc } from './player.js';
import { storyVillain, storyGoal } from './story.js';
import { HERO_GLYPHS } from './game.js';

export function visibleMonsters(state, heroIdx = state.activeIdx) {
  const hero = state.heroes[heroIdx];
  if (!hero) return [];
  return state.monsters.filter(m => hero.fov.has(`${m.x},${m.y}`) && m.hp > 0);
}

export function engagedEnemies(state, heroIdx = state.activeIdx) {
  const hero = state.heroes[heroIdx];
  if (!hero || !hero.combat) return [];
  return Object.entries(hero.combat)
    .map(([id, turn]) => ({ id, turn, mon: state.monsters.find(m => m.id === id) }))
    .filter(e => e.mon && e.mon.hp > 0 && state.turn - e.turn <= 2)
    .sort((a, b) => b.turn - a.turn)
    .map(e => ({ id: e.mon.id, name: e.mon.name, hp: Math.max(0, e.mon.hp), maxHp: e.mon.maxHp, boss: !!e.mon.isBoss }));
}

export function abilityCooldownLeft(state, hero) {
  if (!hero?.ability?.active) return 0;
  return Math.max(0, (hero.abilityReady || 0) - state.turn);
}

export function renderInventory(player) {
  const lines = [`HP: ${player.hp}/${player.maxHp} | Ур.${player.level} | XP ${player.xp}/${player.level * 100} | Золото: ${player.gold}`];
  lines.push(`Оружие: ${player.equipment.weapon ? player.equipment.weapon.name : 'кулаки'} | Броня: ${player.equipment.armor ? player.equipment.armor.name : 'нет'} (AC ${playerAc(player)})`);
  lines.push('Рюкзак:');
  if (!player.inventory.length) lines.push('  (пусто)');
  for (const it of player.inventory) lines.push(`  - ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''}`);
  return lines.join('\n');
}

export function describeSurroundings(state, heroIdx = state.activeIdx) {
  const hero = state.heroes[heroIdx];
  const mons = visibleMonsters(state, heroIdx).map(m => `${m.name} (HP ${m.hp}/${m.maxHp})`);
  const items = state.floorItems.filter(it => hero.fov.has(`${it.x},${it.y}`));
  const party = state.heroes.filter((h, i) => i !== heroIdx && h.alive && h.fov.has(`${hero.pos.x},${hero.pos.y}`) && hero.fov.has(`${h.pos.x},${h.pos.y}`));
  const parts = [`${state.floorName}. `];
  if (party.length) parts.push(`Рядом товарищи: ${party.map(p => p.name).join(', ')}. `);
  if (mons.length) parts.push(`Рядом: ${mons.join(', ')}. `);
  if (items.length) parts.push(`На земле: ${items.map(i => i.name).join(', ')}. `);
  if (state.merchant) parts.push(`Неподалёку прилавок: ${state.merchant.name} торгует (скажи «торговец»). `);
  if (!mons.length && !items.length && !party.length && !state.merchant) parts.push('Пока ничего интересного.');
  return parts.join('');
}

export function exploredRows(state) {
  const rows = [];
  const seen = state.explored || new Set();
  for (let y = 0; y < state.dungeon.h; y++) {
    let row = '';
    for (let x = 0; x < state.dungeon.w; x++) {
      if (!seen.has(`${x},${y}`)) { row += ' '; continue; }
      const t = state.dungeon.grid[y][x];
      row += t === TILE.WALL ? '#' : t === TILE.STAIRS ? '>' : '.';
    }
    rows.push(row);
  }
  return rows;
}

export function buildSnapshot(state, heroIdx = state.activeIdx) {
  const hero = state.heroes[heroIdx];
  const cells = [];
  const monsters = [], items = [];
  for (let y = 0; y < state.dungeon.h; y++) {
    let row = '';
    for (let x = 0; x < state.dungeon.w; x++) {
      if (x === hero.pos.x && y === hero.pos.y) { row += '@'; continue; }
      if (!hero.fov.has(`${x},${y}`)) { row += ' '; continue; }
      const mon = state.monsters.find(m => m.hp > 0 && m.x === x && m.y === y);
      if (mon) {
        row += 'м';
        monsters.push({ name: mon.name, x, y, hp: mon.hp, maxHp: mon.maxHp });
        continue;
      }
      const otherIdx = state.heroes.findIndex((h, i) => i !== heroIdx && h.alive && h.pos.x === x && h.pos.y === y);
      if (otherIdx !== -1) { row += HERO_GLYPHS[otherIdx] || '?'; continue; }
      const item = state.floorItems.find(it => it.x === x && it.y === y);
      if (item) {
        row += item.type === 'gold' ? '$' : item.type === 'potion' ? '!' : '†';
        items.push({ name: item.name, type: item.type, x, y });
        continue;
      }
      const t = state.dungeon.grid[y][x];
      row += t === TILE.WALL ? '#' : t === TILE.STAIRS ? '>' : '.';
    }
    cells.push(row);
  }
  return {
    t: 'snapshot',
    depth: state.depth, floorName: state.floorName, turnOf: state.activeIdx,
    over: state.over, won: !!state.story?.won, epitaph: state.epitaph, mode: state.mode, worldDesc: state.worldDesc, quests: [...state.quests],
    worldBrief: state.worldBrief || '', cast: [...(state.cast || [])],
    story: state.story ? { act: state.story.act, acts: state.story.acts, floors: state.story.floors, villain: storyVillain(state), goal: storyGoal(state), bossSpawned: state.story.bossSpawned } : null,
    you: heroIdx,
    heroes: state.heroes.map((h, i) => ({
      idx: i, name: h.name, className: h.className, alive: h.alive,
      pos: { ...h.pos }, hp: h.hp, maxHp: h.maxHp, level: h.level, glyph: HERO_GLYPHS[i] || '?'
    })),
    self: {
      hp: hero.hp, maxHp: hero.maxHp, level: hero.level, xp: hero.xp,
      xpNext: hero.level * 100, gold: hero.gold, stats: { ...hero.stats },
      inventory: hero.inventory.map(i => ({ ...i })),
      equipment: {
        weapon: hero.equipment.weapon && { ...hero.equipment.weapon },
        armor: hero.equipment.armor && { ...hero.equipment.armor }
      },
      ac: playerAc(hero),
      ability: hero.ability ? { ...hero.ability } : null,
      abilityCd: abilityCooldownLeft(state, hero)
    },
    map: { w: state.dungeon.w, h: state.dungeon.h, cells, monsters, items },
    explored: exploredRows(state), // общая карта: у всех игроков одна и та же
    combat: engagedEnemies(state, heroIdx),
    merchant: state.merchant
      ? { name: state.merchant.name, greeting: state.merchant.greeting, stock: state.merchant.stock.map(it => ({ ...it })) }
      : null
  };
}
