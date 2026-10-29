// save.js — сохранение и продолжение забега.
// Хранится в localStorage одним JSON: хост/соло может закрыть вкладку и вернуться.
// Состояние движка почти целиком JSON-совместимо; отдельно приходится
// разворачивать Set (туман войны), rng (замыкание) и геттеры state.player/pos/fov.

import { createRng, makeDice } from './rng.js';
import { attachAccessors, syncMonSeq } from './game.js';
import { syncItemSeq } from './player.js';

export const SAVE_KEY = 'dnd_run_v1';
export const SAVE_VER = 1;

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' ? v : {});

/** Явный «плоский» слепок состояния: функции, сеты и геттеры сюда не попадают. */
export function serializeRun(state, meta = {}) {
  if (!state || !Array.isArray(state.heroes) || !state.dungeon) return null;
  return {
    v: SAVE_VER,
    ts: Date.now(),
    seed: state.seed,
    rng: typeof state.rng?.getState === 'function' ? state.rng.getState() : null,
    meta: {
      mode: state.mode,
      world: state.worldDesc,
      floorName: state.floorName,
      depth: state.depth,
      turn: state.turn,
      party: state.heroes.map(h => h.name),
      alive: state.heroes.filter(h => h.alive).length,
      hp: state.heroes.map(h => `${Math.max(0, h.hp)}/${h.maxHp}`),
      ...meta
    },
    body: {
      mode: state.mode,
      worldDesc: state.worldDesc,
      backstory: state.backstory || '',
      depth: state.depth,
      over: !!state.over,
      epitaph: state.epitaph || null,
      deathCause: state.deathCause || null,
      turn: state.turn,
      quests: arr(state.quests).slice(),
      floorName: state.floorName,
      activeIdx: state.activeIdx | 0,
      memory: arr(state.memory).slice(),
      recentRolls: arr(state.recentRolls).slice(),
      explored: [...(state.explored || [])], // общая карта партии (Set → массив)
      story: state.story ? { ...state.story } : null,
      merchant: state.merchant
        ? { ...state.merchant, stock: arr(state.merchant.stock).map(it => ({ ...it })) }
        : null,
      dungeon: {
        w: state.dungeon.w,
        h: state.dungeon.h,
        grid: arr(state.dungeon.grid).map(row => arr(row).slice()),
        rooms: arr(state.dungeon.rooms).map(r => ({ ...r })),
        stairs: { ...obj(state.dungeon.stairs) }
      },
      monsters: arr(state.monsters).map(m => ({ ...m })),
      floorItems: arr(state.floorItems).map(i => ({ ...i })),
      heroes: state.heroes.map(h => ({
        ...h,
        fov: [...(h.fov || [])],
        combat: { ...obj(h.combat) }
      }))
    }
  };
}

/** Обратная сборка. Возвращает живое состояние или null, если сейв битый. */
export function deserializeRun(data) {
  if (!data || data.v !== SAVE_VER || !data.body) return null;
  const b = data.body;
  if (!Array.isArray(b.heroes) || !b.heroes.length) return null;
  if (!b.dungeon || !Array.isArray(b.dungeon.grid) || !b.dungeon.grid.length) return null;

  const state = {
    ...b,
    seed: data.seed,
    rng: createRng(data.seed || 1),
    dice: null,
    quests: arr(b.quests).slice(),
    memory: arr(b.memory).slice()
  };
  if (data.rng != null && typeof state.rng.setState === 'function') state.rng.setState(data.rng);
  state.dice = makeDice(state.rng);
  state.heroes = arr(b.heroes).map(h => ({
    ...h,
    fov: new Set(arr(h.fov)),
    combat: { ...obj(h.combat) }
  }));
  state.monsters = arr(b.monsters).map(m => ({ ...m }));
  state.floorItems = arr(b.floorItems).map(i => ({ ...i }));
  state.dungeon = {
    ...b.dungeon,
    grid: arr(b.dungeon.grid).map(row => arr(row).slice()),
    rooms: arr(b.dungeon.rooms).map(r => ({ ...r })),
    stairs: { ...obj(b.dungeon.stairs) }
  };
  if (state.activeIdx >= state.heroes.length) state.activeIdx = 0;
  // общая карта: в старых сейвах её нет — собираем из личных fov героев
  state.explored = new Set(arr(b.explored));
  if (!state.explored.size) {
    for (const h of state.heroes) for (const key of h.fov) state.explored.add(key);
  }
  // счётчики id модулей живут в памяти процесса: после перезагрузки страницы
  // они начинаются с нуля и выдают id, которые уже заняты в сейве
  const itemIds = [];
  for (const h of state.heroes) {
    arr(h.inventory).forEach(i => itemIds.push(i.id));
    if (h.equipment?.weapon) itemIds.push(h.equipment.weapon.id);
    if (h.equipment?.armor) itemIds.push(h.equipment.armor.id);
  }
  state.floorItems.forEach(i => itemIds.push(i.id));
  arr(state.merchant?.stock).forEach(i => itemIds.push(i.id));
  syncItemSeq(itemIds);
  syncMonSeq(state.monsters.map(m => m.id));
  attachAccessors(state);
  return state;
}

function defaultStore() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** Сохранить забег. meta: {coop, room, hero}. */
export function saveRun(state, meta = {}, store = defaultStore()) {
  if (!store) return false;
  const data = serializeRun(state, meta);
  if (!data) return false;
  try {
    store.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false; // переполнение квоты — игра важнее сейва
  }
}

/** Сырой сейв (для проверки наличия и сводки). */
export function loadRunRaw(store = defaultStore()) {
  if (!store) return null;
  try {
    const raw = store.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && data.v === SAVE_VER ? data : null;
  } catch {
    return null;
  }
}

/** Полный сейв: { state, meta, ts } или null. */
export function loadRun(store = defaultStore()) {
  const data = loadRunRaw(store);
  if (!data) return null;
  const state = deserializeRun(data);
  if (!state) return null;
  return { state, meta: data.meta || {}, ts: data.ts || 0 };
}

export function clearRun(store = defaultStore()) {
  try { store.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

/** Человеческая строка для кнопки «продолжить». */
export function runSummary(meta = {}) {
  if (!meta || !meta.party) return '';
  const party = arr(meta.party).join(' · ');
  const mode = meta.mode === 'sandbox' ? 'песочница' : 'сюжет';
  const coop = meta.coop ? ` · кооп ${meta.room ? `(${meta.room})` : ''}` : '';
  return `${party} · ${meta.floorName || 'этаж ?'} · ход ${meta.turn ?? 0} · ${mode}${coop}`;
}
