// terminal.js — рендер карты/статов и печатная машинка для хроники.

import { blip } from './sound.js';
import { TILE } from '../engine/map.js';
import { playerAc } from '../engine/player.js';

/**
 * Печатная машинка: очередь строк, появляющихся посимвольно.
 * Клик по хронике — промотать мгновенно.
 */
export function createTyper(el) {
  const queue = [];
  const finishers = [];
  let cur = null;
  let timer = null;

  function pump() {
    if (cur || !queue.length) return;
    cur = queue.shift();
    const line = document.createElement('div');
    line.className = 'line kind-' + cur.kind;
    el.appendChild(line);
    let i = 0;

    const finish = () => {
      line.textContent = cur.text;
      el.scrollTop = el.scrollHeight;
      cur = null;
      if (queue.length) {
        pump();
      } else {
        timer = null;
        while (finishers.length) finishers.shift()();
      }
    };

    const step = () => {
      if (!cur) return;
      if (cur.skip) { finish(); return; }
      i++;
      line.textContent = cur.text.slice(0, i);
      if (i % 4 === 0) blip();
      el.scrollTop = el.scrollHeight;
      if (i >= cur.text.length) finish();
      else timer = setTimeout(step, 9);
    };
    step();
  }

  return {
    add(kind, text) {
      queue.push({ kind, text, skip: false });
      pump();
    },
    skipAll() {
      for (const item of queue) item.skip = true;
      if (cur) cur.skip = true;
    },
    get busy() { return !!(cur || queue.length); },
    /** колбэк, когда всё напечатано */
    onFinish(fn) {
      if (!this.busy) fn();
      else finishers.push(fn);
    },
    clear() {
      queue.length = 0;
      finishers.length = 0;
      cur = null;
      if (timer) clearTimeout(timer);
      timer = null;
      el.innerHTML = '';
    }
  };
}

/**
 * Рендер карты с туманом войны в <pre>.
 */
export function renderMap(pre, state) {
  const parts = [];
  for (let y = 0; y < state.dungeon.h; y++) {
    for (let x = 0; x < state.dungeon.w; x++) {
      if (x === state.pos.x && y === state.pos.y) {
        parts.push('<span class="m-pl">@</span>');
        continue;
      }
      if (!state.fov.has(`${x},${y}`)) { parts.push(' '); continue; }
      const tile = state.dungeon.grid[y][x];
      if (tile === TILE.WALL) { parts.push('<span class="m-wall">#</span>'); continue; }
      const mon = state.monsters.find(m => m.hp > 0 && m.x === x && m.y === y);
      if (mon) { parts.push(`<span class="m-mon" title="${mon.name}">м</span>`); continue; }
      const item = state.floorItems.find(it => it.x === x && it.y === y);
      if (item) {
        const ch = item.type === 'gold' ? '$' : item.type === 'potion' ? '!' : '†';
        parts.push(`<span class="m-item" title="${item.name}">${ch}</span>`);
        continue;
      }
      if (tile === TILE.STAIRS) { parts.push('<span class="m-stair">&gt;</span>'); continue; }
      parts.push('<span class="m-floor">.</span>');
    }
    parts.push('\n');
  }
  pre.innerHTML = parts.join('');
}

/** Полоска HP из блоков. */
export function hpBar(player, width = 10) {
  const filled = Math.round((Math.max(0, player.hp) / player.maxHp) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderStats(el, state) {
  const p = state.player;
  el.innerHTML = `
    <div class="stat-row"><span class="stat-label">${p.name}</span><span>${p.className} · ур.${p.level}</span></div>
    <div class="stat-row"><span class="stat-label">HP</span><span class="hp">${hpBar(p)} ${p.hp}/${p.maxHp}</span></div>
    <div class="stat-row"><span class="stat-label">AC / XP</span><span>${playerAc(p)} · ${p.xp}/${p.level * 100} · золото ${p.gold}</span></div>
    <div class="stat-row"><span class="stat-label">Оружие</span><span>${p.equipment.weapon ? p.equipment.weapon.name : 'кулаки'}</span></div>
    <div class="stat-row"><span class="stat-label">Броня</span><span>${p.equipment.armor ? p.equipment.armor.name : 'нет'}</span></div>
    <div class="stat-row stats-line">${Object.entries(p.stats).map(([k, v]) => `${k.toUpperCase()}${v}`).join(' ')}</div>
  `;
}

export function renderQuests(el, state) {
  el.innerHTML = state.quests.length
    ? state.quests.map(q => `<div class="quest">◆ ${q}</div>`).join('')
    : '<div class="quest quest-empty">Журнал пуст — судьба ещё не наградила тебя поручениями</div>';
}

// ---------- рендеры из сетевого снапшота (кооп) ----------

const CELL_CLASS = {
  '#': 'm-wall', '.': 'm-floor', 'м': 'm-mon', '!': 'm-item',
  '†': 'm-item', '$': 'm-item', '>': 'm-stair', '@': 'm-pl'
};

/** Карта из персонального снапшота (символы уже вырезаны на хосте). */
export function renderSnapshotMap(pre, snap) {
  const parts = [];
  for (const row of snap.map.cells) {
    for (const ch of row) {
      const cls = CELL_CLASS[ch];
      parts.push(cls ? `<span class="${cls}">${ch === '>' ? '&gt;' : ch}</span>` : ' ');
    }
    parts.push('\n');
  }
  pre.innerHTML = parts.join('');
}

/** Статы + список партии из снапшота. */
export function renderStatsSnap(el, snap) {
  const s = snap.self;
  const filled = Math.round((Math.max(0, s.hp) / s.maxHp) * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const party = snap.heroes.map(h => {
    const dead = h.alive ? '' : ' <span class="hof-epitaph">☠</span>';
    const you = h.idx === snap.you ? ' (ты)' : '';
    return `<div class="stat-row"><span class="stat-label">${h.glyph} ${h.name}${you}</span><span>ур.${h.level} · ${h.hp}/${h.maxHp} HP${dead}</span></div>`;
  }).join('');
  el.innerHTML = `
    <div class="stat-row"><span class="stat-label">Уровень ${s.level}</span><span>XP ${s.xp}/${s.xpNext} · золото ${s.gold}</span></div>
    <div class="stat-row"><span class="stat-label">HP</span><span class="hp">${bar} ${s.hp}/${s.maxHp}</span></div>
    <div class="stat-row"><span class="stat-label">Оружие</span><span>${s.equipment.weapon ? s.equipment.weapon.name : 'кулаки'}</span></div>
    <div class="stat-row"><span class="stat-label">Броня</span><span>${s.equipment.armor ? s.equipment.armor.name : 'нет'} (AC ${s.ac})</span></div>
    <div class="stat-row stats-line">${Object.entries(s.stats).map(([k, v]) => `${k.toUpperCase()}${v}`).join(' ')}</div>
    ${party}
  `;
}
