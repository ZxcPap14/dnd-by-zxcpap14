// terminal.js — рендер карты/статов и печатная машинка для хроники.

import { blip } from './sound.js';
import { TILE } from '../engine/map.js';
import { playerAc } from '../engine/player.js';
import { asciiAvatar } from './avatar.js';

/** Наборы символов карты (переключаются в настройках). */
export const GLYPH_SETS = {
  classic: { wall: '#', floor: '.', stair: '>', mon: 'м', gold: '$', potion: '!', item: '†' },
  pseudo:  { wall: '║', floor: '∙', stair: '»', mon: 'м', gold: '$', potion: '!', item: '†' },
  blocky:  { wall: '▓', floor: '·', stair: '≡', mon: 'м', gold: '$', potion: '!', item: '†' }
};

/** По умолчанию — классика NetHack. */
function glyphOf(setName) {
  return GLYPH_SETS[setName] || GLYPH_SETS.classic;
}

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
 * Рендер карты с туманом войны в <pre>. glyphs — набор символов из GLYPH_SETS.
 */
export function renderMap(pre, state, glyphSetName = 'classic') {
  const g = glyphOf(glyphSetName);
  const parts = [];
  for (let y = 0; y < state.dungeon.h; y++) {
    for (let x = 0; x < state.dungeon.w; x++) {
      if (x === state.pos.x && y === state.pos.y) {
        parts.push('<span class="m-pl">@</span>');
        continue;
      }
      if (!state.fov.has(`${x},${y}`)) { parts.push(' '); continue; }
      const tile = state.dungeon.grid[y][x];
      if (tile === TILE.WALL) { parts.push(`<span class="m-wall">${g.wall}</span>`); continue; }
      const mon = state.monsters.find(m => m.hp > 0 && m.x === x && m.y === y);
      if (mon) { parts.push(`<span class="m-mon" title="${escHtml(mon.name)}">${g.mon}</span>`); continue; }
      const item = state.floorItems.find(it => it.x === x && it.y === y);
      if (item) {
        const ch = item.type === 'gold' ? g.gold : item.type === 'potion' ? g.potion : g.item;
        parts.push(`<span class="m-item" title="${escHtml(item.name)}">${ch}</span>`);
        continue;
      }
      if (tile === TILE.STAIRS) { parts.push(`<span class="m-stair">${escGlyph(g.stair)}</span>`); continue; }
      parts.push(`<span class="m-floor">${g.floor}</span>`);
    }
    parts.push('\n');
  }
  pre.innerHTML = parts.join('');
}

function escGlyph(ch) {
  return ch === '>' ? '&gt;' : ch;
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Полоска HP из блоков. */
export function hpBar(player, width = 10) {
  const filled = Math.round((Math.max(0, player.hp) / player.maxHp) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderStats(el, state) {
  const p = state.player;
  const cd = p.ability?.active ? Math.max(0, (p.abilityReady || 0) - state.turn) : 0;
  const abilityRow = p.ability
    ? `<div class="stat-row"><span class="stat-label">Способность</span><span>${escHtml(p.ability.name)}${p.ability.active ? (cd > 0 ? ` · КД ${cd}` : ' · <span style="color:var(--loot)">ГОТОВО</span>') : ''}</span></div>`
    : '';
  el.innerHTML = `
    <div class="stat-row stat-hero">
      <pre class="avatar avatar-sm">${asciiAvatar(p.name)}</pre>
      <span class="stat-label">${escHtml(p.name)}</span><span>${escHtml(p.className)} · ур.${p.level}</span>
    </div>
    <div class="stat-row"><span class="stat-label">HP</span><span class="hp">${hpBar(p)} ${p.hp}/${p.maxHp}</span></div>
    <div class="stat-row"><span class="stat-label">AC / XP</span><span>${playerAc(p)} · ${p.xp}/${p.level * 100} · золото ${p.gold}</span></div>
    <div class="stat-row"><span class="stat-label">Оружие</span><span>${escHtml(p.equipment.weapon ? p.equipment.weapon.name : 'кулаки')}</span></div>
    <div class="stat-row"><span class="stat-label">Броня</span><span>${escHtml(p.equipment.armor ? p.equipment.armor.name : 'нет')}</span></div>
    ${abilityRow}
    <div class="stat-row stats-line">${Object.entries(p.stats).map(([k, v]) => `${k.toUpperCase()}${v}`).join(' ')}</div>
  `;
}

/**
 * Рюкзак: список предметов с кнопками действий.
 * Кнопка — это просто подсказка движку: клик отправляет «выпить …» / «надеть …».
 * opts.sell — рядом с предметом появляется кнопка «продать» (когда есть торговец).
 */
export function renderInventoryPanel(el, items, opts = {}) {
  if (!el) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    el.innerHTML = '<div class="inv-empty">Пусто. Даже мышь не позарилась.</div>';
    return;
  }
  el.innerHTML = list.map((it, i) => {
    const act = it.type === 'potion' ? 'выпить'
      : (it.type === 'weapon' || it.type === 'armor') ? 'надеть' : null;
    const meta = it.type === 'potion' ? `+${it.heal || 8} HP`
      : it.type === 'weapon' ? `урон ${it.dmg || 1}${it.bonus ? ` +${it.bonus}` : ''}`
        : it.type === 'armor' ? `AC +${it.ac || 1}` : '';
    const sell = opts.sell
      ? `<button class="inv-btn inv-sell" data-i="${i}" data-act="продать">ПРОДАТЬ</button>`
      : '';
    return `<div class="inv-row">
      <span class="inv-name" title="${escHtml(it.name)}">${escHtml(it.name)}${it.qty > 1 ? ` ×${it.qty}` : ''}</span>
      <span class="inv-meta">${meta}</span>
      ${sell}
      ${act ? `<button class="inv-btn" data-i="${i}" data-act="${act}">${act === 'выпить' ? 'ВЫПИТЬ' : 'НАДЕТЬ'}</button>` : ''}
    </div>`;
  }).join('');
}

/**
 * Прилавок торговца: товары с ценами и кнопкой «купить».
 * Кнопка снова лишь подсказка движку — «купить <название>».
 */
export function renderShop(panelEl, listEl, merchant) {
  if (!panelEl || !listEl) return;
  if (!merchant || !Array.isArray(merchant.stock) || !merchant.stock.length) {
    panelEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }
  panelEl.style.display = 'block';
  listEl.innerHTML = merchant.stock.map((it, i) => {
    const meta = it.type === 'potion' ? `+${it.heal || 8} HP`
      : it.type === 'weapon' ? `урон ${it.dmg || 1}`
        : it.type === 'armor' ? `AC +${it.ac || 1}` : '';
    return `<div class="inv-row">
      <span class="inv-name" title="${escHtml(it.name)}">${escHtml(it.name)}</span>
      <span class="inv-meta">${meta}</span>
      <span class="shop-price">${it.price} зм</span>
      <button class="inv-btn shop-btn" data-i="${i}" data-act="купить">КУПИТЬ</button>
    </div>`;
  }).join('');
}

export function renderQuests(el, state) {
  el.innerHTML = state.quests.length
    ? state.quests.map(q => `<div class="quest">◆ ${escHtml(q)}</div>`).join('')
    : '<div class="quest quest-empty">Журнал пуст — судьба ещё не наградила тебя поручениями</div>';
}

// ---------- рендеры из сетевого снапшота (кооп) ----------

const CELL_CLASS = {
  '#': 'm-wall', '.': 'm-floor', 'м': 'm-mon', '!': 'm-item',
  '†': 'm-item', '$': 'm-item', '>': 'm-stair', '@': 'm-pl'
};

/** Карта из персонального снапшота (символы уже вырезаны на хосте; глифы подменяются локально). */
export function renderSnapshotMap(pre, snap, glyphSetName = 'classic') {
  const g = glyphOf(glyphSetName);
  const SUB = { '#': g.wall, '.': g.floor, 'м': g.mon, '!': g.potion, '†': g.item, '$': g.gold, '>': escGlyph(g.stair), '@': '@' };
  const parts = [];
  for (const row of snap.map.cells) {
    for (const ch of row) {
      const sub = SUB[ch];
      if (!sub) { parts.push(' '); continue; }
      const cls = CELL_CLASS[ch];
      parts.push(cls ? `<span class="${cls}">${sub}</span>` : sub);
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
    return `<div class="stat-row"><span class="stat-label">${h.glyph} ${escHtml(h.name)}${you}</span><span>ур.${h.level} · ${h.hp}/${h.maxHp} HP${dead}</span></div>`;
  }).join('');
  el.innerHTML = `
    <div class="stat-row stat-hero">
      <pre class="avatar avatar-sm">${asciiAvatar((snap.heroes[snap.you] || {}).name || '')}</pre>
      <span class="stat-label">Уровень ${s.level}</span><span>XP ${s.xp}/${s.xpNext} · золото ${s.gold}</span>
    </div>
    <div class="stat-row"><span class="stat-label">HP</span><span class="hp">${bar} ${s.hp}/${s.maxHp}</span></div>
    <div class="stat-row"><span class="stat-label">Оружие</span><span>${escHtml(s.equipment.weapon ? s.equipment.weapon.name : 'кулаки')}</span></div>
    <div class="stat-row"><span class="stat-label">Броня</span><span>${escHtml(s.equipment.armor ? s.equipment.armor.name : 'нет')} (AC ${s.ac})</span></div>
    ${s.ability ? `<div class="stat-row"><span class="stat-label">Способность</span><span>${escHtml(s.ability.name)}${s.ability.active ? (s.abilityCd > 0 ? ` · КД ${s.abilityCd}` : ' · <span style="color:var(--loot)">ГОТОВО</span>') : ''}</span></div>` : ''}
    <div class="stat-row stats-line">${Object.entries(s.stats).map(([k, v]) => `${k.toUpperCase()}${v}`).join(' ')}</div>
    ${party}
  `;
}

/**
 * Боевое окно: враги, с которыми герой дерётся прямо сейчас.
 * Пустой список → панель скрыта (появляется после первой атаки, исчезает после боя).
 */
export function renderCombat(el, list) {
  if (!el) return;
  const foes = Array.isArray(list) ? list : [];
  if (!foes.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'block';
  el.innerHTML =
    '<div class="combat-title">⚔ БОЙ</div>' +
    foes.map(foe => {
      const pct = Math.max(0, Math.min(100, Math.round((foe.hp / (foe.maxHp || 1)) * 100)));
      const cls = pct > 60 ? '' : pct > 30 ? ' mid' : ' low';
      const label = foe.boss ? `☠ ${escHtml(foe.name)}` : escHtml(foe.name);
      return `<div class="combat-row${foe.boss ? ' boss' : ''}">` +
        `<span class="combat-name">${label}</span>` +
        `<div class="combat-bar"><div class="combat-fill${cls}" style="width:${pct}%"></div></div>` +
        `<span class="combat-hp">${foe.hp}/${foe.maxHp} HP</span>` +
        '</div>';
    }).join('');
}
