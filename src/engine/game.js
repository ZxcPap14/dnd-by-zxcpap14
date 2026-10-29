// game.js — оркестратор: состояние партии, парсер русских команд, применение интентов.
// v0.5: мультигеройность — heroes[], очерёдность ходов, смерть партии.
// Принцип «ИИ предлагает — код решает»: любые изменения состояния проходят отсюда.

import { createRng, makeDice, mod } from './rng.js';
import { generateDungeon, randomFloor, computeFov, dist, TILE } from './map.js';
import {
  createPlayer, gainXp, addItem, removeItem, findItem, equipItem,
  playerAc, playerWeapon, makeItem,
  abilityCritRange, abilityLifesteal, abilityRegen, abilityGoldMult
} from './player.js';
import {
  rollInitiative, attackRoll, damageRoll, monsterAttack, rollDrop, BASIC_DROP_TABLE
} from './combat.js';
import { DIRS, W, parseCommand } from './parser.js';
import { openMerchant, buyFromMerchant, sellToMerchant, closeMerchant, shopText, removeCurse } from './merchant.js';
import {
  maybeCurse, isCursed, isUnknown, revealCurse, curseMods, curseById, stuckItem, itemNameWithCurse
} from './curses.js';

// ре-экспорт: снаружи (host.js, тесты) парсер по-прежнему берут из game.js
export { DIRS, parseCommand };

export const HERO_GLYPHS = ['@', '#', 'Ω', 'Φ'];

// ---------- сюжетный режим ----------

export const STORY_FLOORS = 6;   // длина сюжетного забега
export const STORY_ACTS = 3;     // три акта: завязка, развитие, финал

/** Номер акта по глубине: 1–2 → акт I, 3–4 → акт II, 5–6 → акт III. */
export function storyAct(depth) {
  return Math.min(STORY_ACTS, Math.ceil(depth / (STORY_FLOORS / STORY_ACTS)));
}

const OFFLINE_VILLAINS = [
  { villain: 'Костяной Король', goal: 'собрать армию мёртвых и выйти на поверхность' },
  { villain: 'Тот-Кто-Считает Часы', goal: 'остановить время для всего живого' },
  { villain: 'Мясник Пустых Залов', goal: 'накормить подземелье героями' },
  { villain: 'Хозяин Финальной Двери', goal: 'впустить в мир то, что за дверью' }
];

let monSeq = 0;

/**
 * Поднять счётчик монстров выше уже существующих (после загрузки сейва).
 * Иначе новый монстр получал бы id из прошлой жизни, и боевое окно
 * (`hero.combat[id]`) показывало бы чужого врага.
 */
export function syncMonSeq(ids = []) {
  for (const id of ids) {
    const n = Number(String(id ?? '').replace(/\D+/g, ''));
    if (Number.isFinite(n) && n > monSeq) monSeq = n;
  }
}

/** Офлайн-спавн: монстры и лут по этажу. */
export function populateFloor(state) {
  const rng = state.rng;
  state.monsters = [];
  state.floorItems = [];

  const depthBoost = state.depth;
  const count = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    const pos = randomFloor(rng, state.dungeon);
    if (dist(pos.x, pos.y, state.heroes[0].pos.x, state.heroes[0].pos.y) < 4) continue;
    const hpBase = 4 + depthBoost;
    state.monsters.push({
      id: `m${++monSeq}`,
      name: pickMonsterName(rng, state.worldDesc),
      x: pos.x, y: pos.y,
      hp: hpBase, maxHp: hpBase,
      toHit: 1 + Math.floor(depthBoost / 2),
      dmg: 1 + Math.floor(depthBoost / 2),
      xp: 20 + depthBoost * 10
    });
  }
  for (let i = 0; i < 2 + Math.floor(rng() * 2); i++) {
    const pos = randomFloor(rng, state.dungeon);
    const drop = rollDrop(state.dice, BASIC_DROP_TABLE, state.depth);
    // часть лута проклята: находка «слишком хороша» — повод для паранойи, а не радости
    if (drop) state.floorItems.push({ ...maybeCurse(drop, rng, state.depth), x: pos.x, y: pos.y });
  }
}

function pickMonsterName(rng, worldDesc) {
  const generic = ['крыса-мутант', 'скелет', 'гоблин-мародёр', 'слизь', 'летучая мышь-убийца', 'злой дух'];
  if (rng() < 0.5) return generic[Math.floor(rng() * generic.length)];
  const words = (worldDesc || '').split(/\s+/).filter(w => w.length > 4 && /[а-яёa-z]/i.test(w));
  if (words.length) {
    const w = words[Math.floor(rng() * words.length)].toLowerCase().replace(/[.,!?]/g, '');
    return `озлобленный ${w}`;
  }
  return generic[Math.floor(rng() * generic.length)];
}

/**
 * Новая партия.
 * @param {{seed?: number, mode?: string, worldDesc: string, players: Array<{name,className,stats?}>,
 *           name?: string, className?: string, stats?: object}} opts
 *   (opts.name/className/stats — совместимость с соло-вызовом)
 */
export function newGame(opts) {
  const seed = opts.seed ?? (Date.now() ^ (Math.random() * 0xffffffff));
  const players = opts.players || [
    { name: opts.name || 'Безымянный', className: opts.className || 'Искатель приключений', stats: opts.stats }
  ].filter(Boolean);

  const state = {
    seed,
    rng: createRng(seed),
    dice: null,
    mode: opts.mode || 'story',
    worldDesc: opts.worldDesc || 'Классическое тёмное фэнтези',
    // предыстория — канон партии: игрок правит её до старта, ДМ обязан её соблюдать
    backstory: String(opts.backstory || '').slice(0, 2400).trim(),
    depth: 1,
    over: false,
    epitaph: null,
    turn: 0,
    quests: [],
    floorName: `Этаж 1`,
    heroes: [],
    activeIdx: 0,
    monsters: [],
    floorItems: [],
    merchant: null, // торговец текущего этажа (см. merchant.js)
    recentRolls: [], // последние броски — их видит ИИ-ДМ
    memory: [], // кольцевой журнал последних событий — память ИИ-ДМа между ходами
    // общая карта партии: союз виден всем, туман рассеивается один раз на всех.
    // Мини-карта у всех игроков поэтому одинаковая — это не личный FOV героя.
    explored: new Set()
  };
  // сюжет: арка с злодеем, тремя актами и финальным боссом
  if (state.mode === 'story') {
    const v = OFFLINE_VILLAINS[Math.floor(state.rng() * OFFLINE_VILLAINS.length)];
    state.story = {
      act: 1, acts: STORY_ACTS, floors: STORY_FLOORS,
      villain: null, villainGoal: null, // приходит от ИИ-интро (или заглушки)
      fallbackVillain: v,
      bossSpawned: false, won: false
    };
  }
  state.dice = makeDice(state.rng);

  // герои — createPlayer + позиция/FOV/жизнь
  const taken = new Set();
  state.dungeon = generateDungeon(state.rng);
  state.heroes = players.map(pd => {
    const hero = { ...createPlayer(pd), pos: { x: 0, y: 0 }, fov: new Set(), alive: true, epitaph: null, combat: {} };
    let spot = randomFloor(state.rng, state.dungeon);
    let tries = 0;
    while (taken.has(`${spot.x},${spot.y}`) && tries++ < 50) spot = randomFloor(state.rng, state.dungeon);
    taken.add(`${spot.x},${spot.y}`);
    hero.pos = spot;
    revealFov(state, hero);
    return hero;
  });

  // совместимость: state.player / state.pos / state.fov → активный герой
  attachAccessors(state);

  populateFloor(state);
  return state;
}

/**
 * Геттеры «активный герой» навешиваются и при новой игре, и при загрузке сейва
 * (после JSON-раундтрипа их нет — они не enumerable и в JSON не попадают).
 */
export function attachAccessors(state) {
  Object.defineProperties(state, {
    player: { get() { return state.heroes[state.activeIdx]; }, configurable: true },
    pos: {
      get() { return state.heroes[state.activeIdx].pos; },
      set(v) { state.heroes[state.activeIdx].pos = v; },
      configurable: true
    },
    fov: {
      get() { return state.heroes[state.activeIdx].fov; },
      set(v) { state.heroes[state.activeIdx].fov = v; },
      configurable: true
    }
  });
  return state;
}

/**
 * Пересчитать личный обзор героя И записать увиденное в общую карту партии.
 * Личный fov — для «кто кого видит» и тумана в бою; explored — для мини-карты,
 * которая у всех игроков одинаковая (союзник подсвечивает клетки всем).
 */
export function revealFov(state, hero) {
  const fov = computeFov(state.dungeon, hero.pos.x, hero.pos.y);
  hero.fov = fov;
  if (!state.explored) state.explored = new Set();
  for (const key of fov) state.explored.add(key);
  return fov;
}

/** Передать ход следующему живому герою. */
export function advanceTurn(state) {
  if (state.heroes.length <= 1) return;
  const n = state.heroes.length;
  for (let i = 1; i <= n; i++) {
    const idx = (state.activeIdx + i) % n;
    if (state.heroes[idx].alive) { state.activeIdx = idx; return; }
  }
}


/** Событие для лога/ИИ. kind: dm|system|roll|combat|loot|death|levelup */
export function ev(kind, text) {
  return { kind, text, turn: 0 };
}

const ROLL_MEMORY = 6;

/**
 * Последние проверки кубиков — их видит ИИ-ДМ (блок «ПРОВЕРКИ ДВИЖКА»).
 * Без этого ДМ выдумывал исходы, не зная, что реально выпало.
 */
export function recordRoll(state, text) {
  if (!Array.isArray(state.recentRolls)) state.recentRolls = [];
  state.recentRolls.push(String(text).slice(0, 80));
  if (state.recentRolls.length > ROLL_MEMORY) state.recentRolls.splice(0, state.recentRolls.length - ROLL_MEMORY);
}

/** Монстры в зоне видимости героя. */
export function visibleMonsters(state, heroIdx = state.activeIdx) {
  const hero = state.heroes[heroIdx];
  if (!hero) return [];
  return state.monsters.filter(m => hero.fov.has(`${m.x},${m.y}`) && m.hp > 0);
}

/** Пометить: этот герой сейчас дерётся с этим монстром (для боевого окна UI). */
function markCombat(state, hero, monster) {
  if (!hero || !monster?.id) return;
  if (!hero.combat) hero.combat = {};
  hero.combat[monster.id] = state.turn;
}

/**
 * Враги в бою с героем: те, с кем была драка за последние 2 хода.
 * Мёртвые пропадают сразу, уцелевшие — через 2 хода без драки.
 */
export function engagedEnemies(state, heroIdx = state.activeIdx) {
  const hero = state.heroes[heroIdx];
  if (!hero || !hero.combat) return [];
  return Object.entries(hero.combat)
    .map(([id, turn]) => ({ id, turn, mon: state.monsters.find(m => m.id === id) }))
    .filter(e => e.mon && e.mon.hp > 0 && state.turn - e.turn <= 2)
    .sort((a, b) => b.turn - a.turn)
    .map(e => ({ id: e.mon.id, name: e.mon.name, hp: Math.max(0, e.mon.hp), maxHp: e.mon.maxHp, boss: !!e.mon.isBoss }));
}

/** Все живые герои на лестнице? (правило общего спуска) */
export function allOnStairs(state) {
  const s = state.dungeon.stairs;
  return state.heroes.filter(h => h.alive).every(h => h.pos.x === s.x && h.pos.y === s.y);
}

/** Сколько ходов осталось до готовности активной способности (0 — можно жать). */
export function abilityCooldownLeft(state, hero) {
  if (!hero?.ability?.active) return 0;
  return Math.max(0, (hero.abilityReady || 0) - state.turn);
}

/** Множитель золота: пассивка класса × жадность проклятой вещи. */
export function heroGoldMult(hero) {
  return abilityGoldMult(hero) * curseMods(hero).goldMult;
}

/** Направление из текста игрока (для рывка «рвусь на север»). */
function dirFromText(text) {
  const t = (text || '').toLowerCase();
  for (const [word, d] of Object.entries(DIRS)) {
    if (W(word).test(t)) return d;
  }
  return null;
}

/**
 * Активная способность класса. Возвращает { events, ok }.
 * ok=false — действие не состоялось (движок передаст его ДМу, ход не сгорит).
 */
function useActiveAbility(state, hero, intent, heroIdx) {
  const a = hero.ability;
  const events = [];
  const push = (kind, text) => events.push(ev(kind, text));
  const dice = state.dice;
  const power = a.power || 5;

  // --- лечение ---
  if (a.active === 'heal') {
    const before = hero.hp;
    hero.hp = Math.min(hero.maxHp, hero.hp + power);
    const healed = hero.hp - before;
    push('loot', healed > 0
      ? `${hero.name} применяет «${a.name}»: +${healed} HP (${hero.hp}/${hero.maxHp}). Раны затягиваются с неприличным хлюпаньем.`
      : `${hero.name} применяет «${a.name}», но лечить нечего — здоровье и так на максимуме. Сила уходит в воздух.`);
    return { events, ok: true };
  }

  // --- рывок ---
  if (a.active === 'dash') {
    const foes = visibleMonsters(state, heroIdx);
    let dirVec = dirFromText(intent.raw);
    if (!dirVec && foes.length) {
      // без направления — прочь от ближайшего врага
      const foe = foes[0];
      dirVec = [Math.sign(hero.pos.x - foe.x), Math.sign(hero.pos.y - foe.y)];
      if (!dirVec[0] && !dirVec[1]) dirVec = [1, 0];
    }
    dirVec = dirVec || [1, 0];
    let moved = 0;
    for (let step = 0; step < 2; step++) {
      const nx = hero.pos.x + dirVec[0], ny = hero.pos.y + dirVec[1];
      if (nx < 0 || ny < 0 || nx >= state.dungeon.w || ny >= state.dungeon.h) break;
      if (state.dungeon.grid[ny][nx] === TILE.WALL) break;
      if (state.monsters.some(m => m.hp > 0 && m.x === nx && m.y === ny)) break; // не влетаем в монстра
      hero.pos = { x: nx, y: ny };
      moved++;
    }
    if (!moved) {
      push('unhandled', `${hero.name} разбегается для рывка и врезается в стену. Впечатляюще, но нет.`);
      return { events, ok: false };
    }
    hero.combat = {}; // рывок разрывает бой — боевое окно гаснет
    revealFov(state, hero);
    gainXp(hero, 2, state.rng);
    push('system', `${hero.name} использует «${a.name}» и перемахивает ${moved === 1 ? 'клетку' : 'клетки'} — только пыль осталась.`);
    return { events, ok: true };
  }

  // --- кара и оглушение требуют врага перед глазами ---
  const foes = visibleMonsters(state, heroIdx);
  if (!foes.length) {
    push('unhandled', `«${a.name}» требует врага перед глазами, а перед глазами только пустота и твои сожаления.`);
    return { events, ok: false };
  }
  const wanted = (intent.target || '').toLowerCase();
  const target = (wanted && foes.find(m => m.name.toLowerCase().includes(wanted))) || foes[0];

  if (a.active === 'smite') {
    push('system', `${hero.name} обрушивает «${a.name}» на ${target.name} (+${power} урона).`);
    events.push(...resolveCombatRound(state, hero, target, dice, { bonusDmg: power }));
    return { events, ok: true };
  }

  // --- оглушение ---
  const dmg = Math.max(1, Math.ceil(power / 2));
  target.hp -= dmg;
  markCombat(state, hero, target);
  if (target.hp <= 0) {
    push('combat', `${hero.name} бьёт «${a.name}» по ${target.name}: -${dmg} HP, и ${target.name} разваливается.`);
    const levels = gainXp(hero, target.xp, state.rng);
    push('loot', `${hero.name} получает ${target.xp} опыта.` + (levels ? ` УРОВЕНЬ ${hero.level}!` : ''));
    const drop = rollDrop(dice, BASIC_DROP_TABLE, state.depth);
    if (drop) {
      const loot = maybeCurse(drop, state.rng, state.depth);
      state.floorItems.push({ ...loot, x: target.x, y: target.y });
      push('loot', `${target.name} роняет: ${loot.name}.`);
    }
    if (target.isBoss) grantVictory(state, hero, push);
  } else {
    target.stun = 1; // пропустит ближайший ход монстров
    push('combat', `${hero.name} бьёт «${a.name}» по ${target.name}: -${dmg} HP. ${target.name} оглушён и пропустит ход (осталось ${target.hp} HP).`);
  }
  return { events, ok: true };
}

/**
 * Применение интента к состоянию от конкретного героя. Возвращает события.
 * Действовать может только активный герой (очередь ходов).
 */
export function applyIntent(state, intent, heroIdx = state.activeIdx) {
  if (state.over || intent.intent === 'none') return [];
  const speaker = state.heroes[heroIdx];
  if (!speaker || !speaker.alive) return [];

  // Реплика партии — не действие: ход не тратится, очередь не ждётся.
  // Свобода общения важнее формальной очерёдности (в коопе это единственный
  // способ договориться, не сжигая ход).
  if (intent.intent === 'say') {
    const said = String(intent.text ?? '').slice(0, 240).trim();
    if (!said) return [];
    const events = [ev('say', `${speaker.name} ${intent.verb || 'говорит'}: «${said}»`)];
    rememberEvents(state, events);
    return events;
  }

  if (heroIdx !== state.activeIdx) return []; // не твой ход
  const hero = state.heroes[heroIdx];
  if (!hero || !hero.alive) return [];

  const events = [];
  const push = (kind, text) => events.push(ev(kind, text));
  const dice = state.dice;
  state.turn++;

  switch (intent.intent) {
    case 'move': {
      const [dx, dy] = intent.dirVec;
      const nx = hero.pos.x + dx, ny = hero.pos.y + dy;
      if (nx < 0 || ny < 0 || nx >= state.dungeon.w || ny >= state.dungeon.h ||
          state.dungeon.grid[ny][nx] === TILE.WALL) {
        // не глухая стена, а вопрос ДМу: он обыграет попытку с контекстом
        push('unhandled', 'Ты упираешься в холодную стену. Она не впечатлена.');
        break;
      }
      const monster = state.monsters.find(m => m.hp > 0 && m.x === nx && m.y === ny);
      if (monster) {
        push('combat', `Путь преграждает ${monster.name}. Бой!`);
        events.push(...resolveCombatRound(state, hero, monster, dice));
        break;
      }
      hero.pos = { x: nx, y: ny };
      const tile = state.dungeon.grid[ny][nx];
      if (tile === TILE.STAIRS) push('system', 'Ты стоишь на лестнице вниз. (Скажи «спускаюсь» — когда вся партия будет готова)');
      gainXp(hero, 2, state.rng); // опыт за исследование
      revealFov(state, hero);
      const here = state.floorItems.find(it => it.x === nx && it.y === ny);
      if (here) events.push(...pickupItem(state, hero, here));
      break;
    }

    case 'attack': {
      const targets = visibleMonsters(state, heroIdx);
      if (!targets.length) {
        // «убиваю дрона за углом» — пусть ДМ расскажет, что реально рядом
        push('unhandled', 'Ты угрожающе машешь оружием в пустоту. Пустота не в счёт.');
        break;
      }
      let target = targets[0];
      if (intent.target) {
        const found = targets.find(m => m.name.toLowerCase().includes(intent.target.toLowerCase()));
        if (found) target = found;
      }
      push('combat', `${hero.name} бросается на ${target.name}!`);
      events.push(...resolveCombatRound(state, hero, target, dice));
      break;
    }

    case 'use': {
      const item = findItem(hero, intent.target);
      if (!item) { push('unhandled', `Среди вещей ${hero.name} нет ничего похожего на «${intent.target}».`); break; }
      if (item.type === 'potion') {
        removeItem(hero, item.id);
        const heal = item.heal || 8;
        hero.hp = Math.min(hero.maxHp, hero.hp + heal);
        push('loot', `${hero.name} вливает в себя ${item.name} (+${heal} HP). Жизнь налаживается.`);
      } else if (item.type === 'weapon' || item.type === 'armor') {
        // без рекурсии: иначе «надеть меч» через «использую» тратит два хода
        if (!equipInto(hero, item, push)) { state.turn--; rememberEvents(state, events); return events; }
      } else {
        push('system', `${item.name}: на вкус как побитая жизнь. Больше не будем.`);
      }
      break;
    }

    case 'equip': {
      const item = findItem(hero, intent.target);
      if (!item) { push('unhandled', `${hero.name} не нашёл «${intent.target}» в инвентаре.`); break; }
      if (!equipInto(hero, item, push)) {
        // проклятая вещь не отпускает: это не действие, ход не сгорает
        state.turn--;
        rememberEvents(state, events);
        return events;
      }
      break;
    }

    case 'pickup': {
      const here = state.floorItems.find(it => it.x === hero.pos.x && it.y === hero.pos.y);
      if (!here) { push('unhandled', 'Под ногами пусто. Даже пыли нет.'); break; }
      events.push(...pickupItem(state, hero, here));
      break;
    }

    case 'descend': {
      if (state.dungeon.grid[hero.pos.y][hero.pos.x] !== TILE.STAIRS) {
        // «спускаюсь» как часть замысла игрока — ДМ подскажет, куда реально вниз
        push('unhandled', 'Чтобы спуститься, нужно сначала найти лестницу. Она не под тобой.');
        break;
      }
      if (!allOnStairs(state)) {
        push('system', 'Партия не собрана: не все живые герои на лестнице. Ждём отстающих.');
        break;
      }
      state.depth++;
      state.dungeon = generateDungeon(state.rng);
      state.explored = new Set(); // новый этаж — карта снова в тумане (у всех сразу)
      const taken = new Set();
      state.heroes.forEach(h => {
        h.combat = {}; // новый этаж — старые драки остались наверху
        let spot = randomFloor(state.rng, state.dungeon);
        let tries = 0;
        while (taken.has(`${spot.x},${spot.y}`) && tries++ < 50) spot = randomFloor(state.rng, state.dungeon);
        taken.add(`${spot.x},${spot.y}`);
        h.pos = spot;
        revealFov(state, h);
      });
      state.floorName = `Этаж ${state.depth}`;
      populateFloor(state);
      // торговец ждёт на новом этаже: золото снова есть куда потратить
      state.merchant = openMerchant(state);
      gainXp(hero, 30, state.rng);
      push('system', `Партия спускается глубже. ${state.floorName}. Воздух гуще, тьма наглее.`);
      push('system', `⚖ Здесь торгует ${state.merchant.name}. Скажи «торговец» — покажет прилавок.`);
      // сюжет: смена акта и финальный босс
      if (state.story) {
        const act = storyAct(state.depth);
        if (act !== state.story.act) {
          state.story.act = act;
          const beats = {
            2: `АКТ II: следы ${storyVillain(state)} становятся яснее. ${storyGoal(state)} — время поджимает.`,
            3: `АКТ III: ты у дна. Дальше — логово ${storyVillain(state)}.`
          };
          push('victory', `⚜ ${beats[act] || 'Сюжет движется.'}`);
        }
        if (state.depth >= state.story.floors) spawnStoryBoss(state, events);
      }
      break;
    }

    case 'inventory':
      push('system', renderInventory(hero));
      break;

    case 'quests':
      push('system', state.quests.length
        ? 'Журнал:\n' + state.quests.map((q, i) => `  ${i + 1}. ${q}`).join('\n')
        : 'Журнал пуст. Судьба пока не оставила тебе поручений.');
      break;

    case 'map': {
      const total = state.dungeon.w * state.dungeon.h;
      const seen = state.explored?.size || 0;
      push('system', `Карта слева — общая на всю партию: что увидел один, видят все. Исследовано ${Math.min(100, Math.round(seen / total * 100))}%.`);
      break;
    }

    case 'look':
      push('system', describeSurroundings(state, heroIdx));
      break;

    case 'wait':
      push('system', 'Ты стоишь и слушаешь тишину. Тишина слушает в ответ.');
      break;

    case 'flee': {
      const foes = visibleMonsters(state, heroIdx);
      // игрок может указать направление («убегаю на север») — уважаем выбор
      let dirVec = null;
      for (const [word, d] of Object.entries(DIRS)) {
        if (W(word).test((intent.raw || '').toLowerCase())) { dirVec = d; break; }
      }
      let best = null, bestScore = -Infinity;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = hero.pos.x + dx, ny = hero.pos.y + dy;
        if (nx < 0 || ny < 0 || nx >= state.dungeon.w || ny >= state.dungeon.h ||
            state.dungeon.grid[ny][nx] === TILE.WALL) continue;
        if (state.monsters.some(m => m.hp > 0 && m.x === nx && m.y === ny)) continue; // не убегаем В пасть
        const minFoe = foes.length ? Math.min(...foes.map(f => dist(nx, ny, f.x, f.y))) : 99;
        const score = (dirVec && dirVec[0] === dx && dirVec[1] === dy ? 100 : 0) + minFoe + state.rng() * 0.5;
        if (score > bestScore) { bestScore = score; best = { x: nx, y: ny }; }
      }
      if (!best) {
        push('unhandled', 'Бежать некуда: стены и зубы со всех сторон.');
        break;
      }
      hero.pos = { x: best.x, y: best.y };
      revealFov(state, hero);
      gainXp(hero, 1, state.rng);
      const foeName = foes.length ? foes[0].name : null;
      push('system', `${hero.name} ретируется${foeName ? ` от ${foeName}` : ''} со скоростью, достойной легенды. Дерзость — тоже тактика.`);
      break;
    }

    // ---- торговец ----
    case 'trade': {
      if (!state.merchant) { push('unhandled', 'Торговца поблизости нет — только эхо и сырость.'); break; }
      push('system', shopText(state, hero));
      break;
    }

    case 'buy': {
      if (!state.merchant) { push('unhandled', 'Покупать не у кого: торговец остался на прошлом этаже.'); break; }
      const res = buyFromMerchant(state, hero, intent.target);
      events.push(...res.events);
      if (!res.ok) break;          // тупик → ДМу, ход не сгорает
      state.turn--;                // покупка — разговор, а не ход
      rememberEvents(state, events);
      return events;
    }

    case 'sell': {
      if (!state.merchant) { push('unhandled', 'Продавать некому: вокруг только тьма.'); break; }
      const res = sellToMerchant(state, hero, intent.target);
      events.push(...res.events);
      if (!res.ok) break;
      state.turn--;
      rememberEvents(state, events);
      return events;
    }

    case 'leave': {
      if (!state.merchant) { push('unhandled', intent.raw || 'Ты уходишь в темноту.'); break; }
      events.push(...closeMerchant(state));
      state.turn--;
      rememberEvents(state, events);
      return events;
    }

    case 'uncurse': {
      if (!state.merchant) { push('unhandled', 'Снять проклятие может только торговец — а его здесь нет. Ищи прилавок ниже.'); break; }
      const res = removeCurse(state, hero);
      events.push(...res.events);
      if (!res.ok) { state.turn--; rememberEvents(state, events); return events; } // нечего снимать — ход не сгорает
      state.turn--;
      rememberEvents(state, events);
      return events;
    }

    case 'ability': {
      const a = hero.ability;
      if (!a || !a.active) {
        push('unhandled', `${hero.name} не владеет активными способностями — только обаянием и наглостью.`);
        break;
      }
      const left = abilityCooldownLeft(state, hero);
      if (left > 0) {
        push('system', `«${a.name}» ещё восстанавливается: ${left} ${left === 1 ? 'ход' : 'хода'}. Пока — только кулаки и надежда.`);
        state.turn--; // ход не тратим: способность просто не готова
        rememberEvents(state, events);
        return events;
      }
      const res = useActiveAbility(state, hero, intent, heroIdx);
      events.push(...res.events);
      if (!res.ok) break; // тупик → уйдёт ДМу, ход не сгорит
      hero.abilityReady = state.turn + a.cd;
      break;
    }

    case 'free':
      // свободный текст — обрабатывает ИИ-слой (или офлайн-заглушка)
      push('dm', `__FREE__${intent.text}`);
      break;
  }

  // тупик движка (стена / нет предмета / не та лестница / пустая атака)?
  // отдаём ДМу ОРИГИНАЛЬНЫЙ текст игрока — он знает контекст и подстроится.
  // Ход при этом НЕ сгорает и монстры не ходят: действия как такового не было.
  const stuck = events.find(e => e.kind === 'unhandled');
  if (stuck) {
    const i = events.indexOf(stuck);
    events.splice(i, 1, ev('dm', `__FREE__${intent.raw || stuck.text}`));
    state.turn--;
    rememberEvents(state, events);
    return events;
  }

  // пассивка «регенерация»: организм сам латает дырки после каждого действия
  const regen = abilityRegen(hero);
  if (regen > 0 && hero.alive && hero.hp > 0 && hero.hp < hero.maxHp) {
    const before = hero.hp;
    hero.hp = Math.min(hero.maxHp, hero.hp + regen);
    if (hero.hp > before) push('system', `${hero.name} регенерирует: +${hero.hp - before} HP (${hero.hp}/${hero.maxHp}).`);
  }

  // мир живёт: монстры ходят и нападают после действия героя
  events.push(...monsterTurns(state));

  // проклятая вещь тянет силы владельца каждый ход — цена за её «щедрость»
  const curses = curseMods(hero);
  if (curses.drain > 0 && hero.alive && hero.hp > 0) {
    hero.hp -= curses.drain;
    push('combat', `Проклятие пьёт силы ${hero.name}: -${curses.drain} HP (осталось ${Math.max(0, hero.hp)}/${hero.maxHp}).`);
  }

  // смерть героя? (победа в сюжете важнее героической смерти)
  if (hero.hp <= 0 && hero.alive && !state.story?.won) {
    hero.alive = false;
    hero.epitaph = state.deathCause || 'умер при невыясненных обстоятельствах';
    push('death', `☠ ${hero.name} мёртв. Эпитафия: ${hero.epitaph}`);
    if (state.heroes.every(h => !h.alive)) {
      state.over = true;
      state.epitaph = hero.epitaph;
      push('death', `☠ Партия уничтожена. Подземелье победило.`);
    }
  }

  if (!state.over) advanceTurn(state);
  rememberEvents(state, events);
  return events;
}

/**
 * Надеть предмет. Возвращает false, если проклятая вещь в слоте не отпускает
 * (тогда вызывающий откатывает ход: попытка не состоялась).
 * Общая точка для «надеть» и «использую» — иначе второе тратило два хода.
 */
function equipInto(hero, item, push) {
  const slot = item.type === 'weapon' ? 'weapon' : item.type === 'armor' ? 'armor' : null;
  if (!slot) { push('system', `${item.name} нельзя надеть. Разве что как украшение.`); return true; }
  const stuck = stuckItem(hero, slot);
  if (stuck) {
    push('system', `${stuck.name} не отпускает: пальцы сами сжимаются обратно. Проклятие «${stuck.curseName || '?'}» крепче стали. Снять — только у торговца.`);
    return false;
  }
  const wasUnknown = isUnknown(item);
  const { equipped, unequipped } = equipItem(hero, item);
  if (!equipped) { push('system', `${item.name} нельзя надеть. Разве что как украшение.`); return true; }
  push('loot', `Экипировано: ${equipped.name}` + (unequipped ? ` (в рюкзак уходит ${unequipped.name})` : ''));
  if (wasUnknown) {
    // первое касание раскрывает проклятие: до этого игрок видел только «?»
    revealCurse(equipped);
    const c = curseById(equipped.curse);
    push('combat', `⚠ Проклятие «${c?.name || '?'}»: ${c?.hint || 'вещь не та, чем кажется'}. Теперь оно твоё — снять можно только у торговца.`);
  }
  return true;
}

function pickupItem(state, hero, item) {
  const events = [];
  state.floorItems = state.floorItems.filter(it => it !== item);
  if (item.type === 'gold') {
    const amount = Math.max(1, Math.round(item.qty * heroGoldMult(hero)));
    hero.gold += amount;
    events.push(ev('loot', `${hero.name} подбирает ${amount} золота. Капиталист внутри доволен.`));
  } else {
    addItem(hero, item);
    events.push(ev('loot', `${hero.name} подбирает: ${itemNameWithCurse(item)}${item.qty > 1 ? ` x${item.qty}` : ''}.`));
  }
  gainXp(hero, 5, state.rng);
  return events;
}

/**
 * Один раунд боя: герой бьёт, если враг жив — враг отвечает ближайшему видимому герою.
 * opts.bonusDmg — добавка к урону (карательный удар способности класса).
 */
export function resolveCombatRound(state, hero, monster, dice, opts = {}) {
  const events = [];
  const push = (kind, text) => events.push(ev(kind, text));
  const weapon = playerWeapon(hero);
  const critRange = abilityCritRange(hero);        // пассивка «крит»
  const lifesteal = abilityLifesteal(hero);        // пассивка «вампиризм»
  const bonusDmg = Math.max(0, opts.bonusDmg | 0);
  const curse = curseMods(hero);                   // проклятая вещь меняет и удар, и урон
  const effWeapon = curse.hit ? { ...weapon, bonus: (weapon.bonus || 0) + curse.hit } : weapon;
  markCombat(state, hero, monster); // бой начался — враг появляется в боевом окне

  const pInit = rollInitiative(dice, hero.stats.dex).total;
  // инициатива монстра — свой d20 (+1 за звериную наглость), а НЕ ловкость героя
  const mInit = rollInitiative(dice, 10).total + 1;
  const playerFirst = pInit >= mInit;

  const playerStrike = () => {
    const atk = attackRoll(dice, hero.stats, effWeapon, 10 + (monster.toHit || 0), critRange);
    recordRoll(state, `${hero.name} d20[${atk.raw}]→${atk.total}${atk.crit ? ' КРИТ' : atk.fumble ? ' провал' : ''}`);
    events.push(ev('roll', `${hero.name}: d20 [${atk.raw}]${atk.crit ? ' КРИТ!' : atk.fumble ? ' провал...' : ''} → атака ${atk.total}`));
    if (!atk.hit) {
      push('combat', `${hero.name} промахивается по ${monster.name}. ${atk.fumble ? 'Очень зрелищно промахивается.' : ''}`);
      return;
    }
    const dmg = damageRoll(dice, effWeapon, hero.stats.str, atk.crit);
    const total = dmg.total + bonusDmg + curse.dmg;
    monster.hp -= total;
    push('combat', `${atk.crit ? 'КРИТИЧЕСКИЙ УДАР! ' : ''}${hero.name} наносит ${total} урона ${monster.name} ${dmg.rolls.map(r => `[${r}]`).join('')}${bonusDmg ? ` (+${bonusDmg} от способности)` : ''}${curse.dmg ? ` (+${curse.dmg} от проклятия)` : ''}. ${monster.hp <= 0 ? `${monster.name} повержен!` : `У него осталось ${monster.hp} HP.`}`);
    // пассивка «вампиризм»: часть нанесённого урона возвращается здоровьем
    if (lifesteal > 0 && hero.hp > 0) {
      const sip = Math.max(1, Math.round(total * lifesteal / 100));
      const before = hero.hp;
      hero.hp = Math.min(hero.maxHp, hero.hp + sip);
      if (hero.hp > before) push('loot', `${hero.name} впитывает ${hero.hp - before} HP из чужой боли (${hero.hp}/${hero.maxHp}).`);
    }
    if (monster.hp <= 0) {
      const levels = gainXp(hero, monster.xp, state.rng);
      push('loot', `${hero.name} получает ${monster.xp} опыта.` + (levels ? ` УРОВЕНЬ ${hero.level}!` : ''));
      const drop = rollDrop(dice, BASIC_DROP_TABLE, state.depth);
      if (drop) {
        const loot = maybeCurse(drop, state.rng, state.depth);
        state.floorItems.push({ ...loot, x: monster.x, y: monster.y });
        push('loot', `${monster.name} роняет: ${loot.name}.`);
      }
      if (monster.isBoss) grantVictory(state, hero, push);
    }
  };

  const monsterStrike = () => {
    // монстр бьёт ближайшего видимого ему героя, а не только атакующего
    const candidates = state.heroes
      .filter(h => h.alive && h.fov.has(`${monster.x},${monster.y}`))
      .sort((a, b) => dist(a.pos.x, a.pos.y, monster.x, monster.y) - dist(b.pos.x, b.pos.y, monster.x, monster.y));
    const target = candidates[0] || hero;
    markCombat(state, target, monster); // цель тоже видит врага в боевом окне
    const atk = monsterAttack(dice, monster, playerAc(target));
    recordRoll(state, `${monster.name} d20[${atk.raw}]→${atk.total}${atk.crit ? ' КРИТ' : ''}`);
    if (!atk.hit) {
      push('combat', `${monster.name} бьёт мимо ${target.name} ${atk.crit ? '(а ведь чуть не кританул)' : ''}.`);
      return;
    }
    target.hp -= atk.dmg;
    state.deathCause = `убит ${monster.name}`;
    push('combat', `${monster.name} ${atk.crit ? 'КРИТУЕТ' : 'попадает'} по ${target.name}: -${atk.dmg} HP (осталось ${Math.max(0, target.hp)}).`);
  };

  if (playerFirst) { playerStrike(); if (monster.hp > 0) monsterStrike(); }
  else { monsterStrike(); if (hero.hp > 0) playerStrike(); }

  monster.lastActedTurn = state.turn; // уже подрался в этом ходу — monsterTurns его пропустит
  return events;
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

/** Добавить квест в журнал (ИИ или движок). */
export function addQuest(state, text) {
  if (text && !state.quests.includes(text)) state.quests.push(text);
}

// ---------- память ДМа ----------

const MEMORY_CAP = 14;      // сколько последних событий помнит ДМ
const MEMORY_LINE_MAX = 160; // обрезка строки события

/**
 * Запомнить события для ИИ-ДМа. Служебные эхо (__FREE__) не запоминаются.
 */
export function rememberEvents(state, events) {
  if (!state.memory) state.memory = [];
  for (const e of events) {
    if (!e || typeof e.text !== 'string') continue;
    if (e.text.startsWith('__FREE__')) continue;
    if (e.kind === 'suggest') continue; // UI-подсказки — не память ДМа
    const line = `${e.kind}: ${e.text}`.slice(0, MEMORY_LINE_MAX);
    state.memory.push(line);
  }
  if (state.memory.length > MEMORY_CAP) state.memory.splice(0, state.memory.length - MEMORY_CAP);
}

/** Строка «НЕДАВНИЕ СОБЫТИЯ» для контекста ИИ. */
export function memoryDigest(state, n = 12) {
  if (!state.memory?.length) return '';
  return state.memory.slice(-n).join(' | ');
}

// ---------- сюжет: злодей, босс, победа ----------

/** Имя злодея (от ИИ или офлайн-шаблон). */
export function storyVillain(state) {
  return state.story?.villain || state.story?.fallbackVillain?.villain || 'Владыка Бездны';
}

export function storyGoal(state) {
  return state.story?.villainGoal || state.story?.fallbackVillain?.goal || 'уничтожить всё живое';
}

/** Спавн финального босса на последнем этаже сюжетного забега. */
function spawnStoryBoss(state, events) {
  const s = state.story;
  if (!s || s.bossSpawned) return;
  s.bossSpawned = true;
  const name = storyVillain(state);
  const pos = randomFloor(state.rng, state.dungeon);
  const hp = 25 + state.depth * 6;
  state.monsters.push({
    id: `m${++monSeq}`,
    name,
    isBoss: true,
    x: pos.x, y: pos.y,
    hp, maxHp: hp,
    toHit: 5, dmg: 2 + Math.floor(state.depth / 2),
    xp: 150 + state.depth * 20
  });
  addQuest(state, `Победить ${name}`);
  events.push(ev('victory', `⚜ ФИНАЛ: ${name} ждёт на этом этаже. ${storyGoal(state)} — если ты провалишься, мир об этом пожалеет.`));
}

/** Победа: босс повержен. */
function grantVictory(state, hero, push) {
  if (state.over || !state.story || state.story.won) return;
  state.story.won = true;
  state.over = true;
  state.epitaph = `${hero.name} победил ${storyVillain(state)} и спас мир. На глубине ${state.depth}.`;
  push('victory', `⚜ ${storyVillain(state)} повержен! ${hero.name} — легенда. ПОБЕДА!`);
}

/** Сюжетная строка для контекста ИИ. */
export function storyDigest(state) {
  const s = state.story;
  if (!s) return '';
  return `АКТ ${s.act}/${s.acts}, этаж ${state.depth} из ${s.floors}, злодей: ${storyVillain(state)} (${storyGoal(state)}), босс: ${s.bossSpawned ? 'УЖЕ ЖДЁТ' : 'впереди'}.`;
}

// ---------- жизнь монстров: преследование и атака ----------

function walkable(state, x, y) {
  if (x < 0 || y < 0 || x >= state.dungeon.w || y >= state.dungeon.h) return false;
  return state.dungeon.grid[y][x] !== TILE.WALL;
}

function occupied(state, x, y) {
  if (state.monsters.some(m => m.hp > 0 && m.x === x && m.y === y)) return true;
  if (state.heroes.some(h => h.alive && h.pos.x === x && h.pos.y === y)) return true;
  return false;
}

function stepToward(state, m, target) {
  let best = null;
  let bestD = dist(m.x, m.y, target.x, target.y);
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const nx = m.x + dx, ny = m.y + dy;
    if (!walkable(state, nx, ny) || occupied(state, nx, ny)) continue;
    const d = dist(nx, ny, target.x, target.y);
    if (d < bestD) { bestD = d; best = { x: nx, y: ny }; }
  }
  return best;
}

function randomStep(state, m) {
  const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(state.rng() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }
  for (const [dx, dy] of dirs) {
    const nx = m.x + dx, ny = m.y + dy;
    if (walkable(state, nx, ny) && !occupied(state, nx, ny)) return { x: nx, y: ny };
  }
  return null;
}

/** Атака монстра по герою вплотную. Возвращает события. */
function monsterStrikeAdjacent(state, m, push) {
  const events = [];
  const candidates = state.heroes
    .filter(h => h.alive && dist(h.pos.x, h.pos.y, m.x, m.y) <= 1)
    .sort((a, b) => dist(a.pos.x, a.pos.y, m.x, m.y) - dist(b.pos.x, b.pos.y, m.x, m.y));
  const target = candidates[0];
  if (!target) return events;
  markCombat(state, target, m); // враг напал — появляется в боевом окне жертвы
  const atk = monsterAttack(state.dice, m, playerAc(target));
  if (!atk.hit) {
    push('combat', `${m.name} настигает ${target.name}, но бьёт мимо.`);
    return events;
  }
  target.hp -= atk.dmg;
  state.deathCause = `убит ${m.name}`;
  push('combat', `${m.name} ${atk.crit ? 'КРИТУЕТ' : 'нападает'} по ${target.name}: -${atk.dmg} HP (осталось ${Math.max(0, target.hp)}).`);
  return events;
}

/**
 * Ходы монстров после действия героя: видят героя — преследуют и бьют в упор,
 * не видят — иногда бродят. Монстр, уже подравшийся в этом ходу, ход не тратит.
 */
export function monsterTurns(state) {
  const events = [];
  const push = (kind, text) => events.push(ev(kind, text));
  if (state.over) return events;
  const living = state.heroes.filter(h => h.alive);
  if (!living.length) return events;

  for (const m of state.monsters) {
    if (m.hp <= 0 || m.lastActedTurn === state.turn) continue;
    // оглушён способностью класса — пропускает ход
    if (m.stun > 0) {
      m.stun--;
      push('system', `${m.name} оглушён и пропускает ход, обиженно покачиваясь.`);
      continue;
    }

    // цель: ближайший живой герой, который видит монстра (= взаимная видимость)
    let target = null, bestD = Infinity;
    for (const h of living) {
      if (!h.fov.has(`${m.x},${m.y}`)) continue;
      const d = dist(h.pos.x, h.pos.y, m.x, m.y);
      if (d < bestD) { bestD = d; target = h; }
    }

    if (target && bestD <= 1) {
      m.lastActedTurn = state.turn;
      events.push(...monsterStrikeAdjacent(state, m, push));
      continue;
    }

    if (target) {
      if (!m.aware) {
        m.aware = true;
        push('dm', `Из тьмы за тобой крадётся ${m.name}. Похоже, ты ему понравился.`);
      }
      const step = stepToward(state, m, target.pos);
      if (step) { m.x = step.x; m.y = step.y; m.lastActedTurn = state.turn; }
      continue;
    }

    // никого не видит — иногда бродит
    if (state.rng() < 0.25) {
      const step = randomStep(state, m);
      if (step) { m.x = step.x; m.y = step.y; m.lastActedTurn = state.turn; }
    }
  }
  return events;
}

/**
 * Общая карта партии в компактном виде: по строке на ряд.
 * '#' стена, '.' пол, '>' лестница, ' ' — ещё не видели.
 * Одинакова для всех героев, поэтому мини-карта у всех игроков совпадает.
 */
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

/**
 * Персональный снапшот для сетевой игры: только то, что видит герой.
 */
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

/**
 * Применение эффектов, предложенных ИИ. Движок ВАЛИДИРУЕТ всё.
 * playerDamage/heal/goldGain/itemGain/xpGain бьют по герою heroIdx (по умолчанию — активному).
 */
export function applyDmEffects(state, effects, heroIdx = state.activeIdx) {
  const events = [];
  const push = (kind, text) => events.push(ev(kind, text));
  if (!effects || typeof effects !== 'object') return events;
  const hero = state.heroes[heroIdx] || state.heroes[state.activeIdx];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));

  if (effects.enemySpawn && !state.over) {
    const pos = randomFloor(state.rng, state.dungeon);
    state.monsters.push({
      id: `m${++monSeq}`,
      name: String(effects.enemySpawn.name || 'нечто').slice(0, 40),
      x: pos.x, y: pos.y,
      hp: clamp(effects.enemySpawn.hp || 4, 1, 20),
      maxHp: clamp(effects.enemySpawn.hp || 4, 1, 20),
      toHit: clamp(effects.enemySpawn.toHit || 1, 0, 5),
      dmg: clamp(effects.enemySpawn.dmg || 1, 1, 6),
      xp: clamp(effects.enemySpawn.xp || 25, 5, 200)
    });
  }

  if (effects.enemyDamage) {
    const mons = visibleMonsters(state, heroIdx);
    const target = (effects.enemyName &&
      mons.find(m => m.name.toLowerCase().includes(String(effects.enemyName).toLowerCase()))) || mons[0];
    if (target) {
      const dmg = clamp(effects.enemyDamage, 0, 30);
      markCombat(state, hero, target); // ДМ-атака тоже открывает боевое окно
      target.hp -= dmg;
      push('combat', `${target.name} получает ${dmg} урона. ${target.hp <= 0 ? 'Повержен!' : `Осталось ${target.hp} HP.`}`);
      if (target.hp <= 0) {
        const levels = gainXp(hero, target.xp, state.rng);
        push('loot', `${hero.name} получает ${target.xp} опыта.` + (levels ? ` УРОВЕНЬ ${hero.level}!` : ''));
        if (target.isBoss) grantVictory(state, hero, push);
      }
    }
  }

  if (effects.itemGain && effects.itemGain.name) {
    const item = makeItem({
      name: String(effects.itemGain.name).slice(0, 40),
      type: ['weapon', 'armor', 'potion', 'misc'].includes(effects.itemGain.type) ? effects.itemGain.type : 'misc',
      dmg: clamp(effects.itemGain.dmg || 0, 0, 8),
      ac: clamp(effects.itemGain.ac || 0, 0, 6),
      heal: clamp(effects.itemGain.heal || 0, 0, 20),
      qty: clamp(effects.itemGain.qty || 1, 1, 5)
    });
    if (item.type === 'misc' && !item.dmg && !item.ac && !item.heal && effects.itemGain.gold) {
      hero.gold += clamp(effects.itemGain.gold, 1, 500);
      push('loot', `${hero.name} получает: ${clamp(effects.itemGain.gold, 1, 500)} золота.`);
    } else {
      addItem(hero, item);
      push('loot', `${hero.name} получает: ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''}.`);
    }
    gainXp(hero, 5, state.rng);
  }

  if (effects.goldGain) {
    const amount = Math.max(1, Math.round(clamp(effects.goldGain, 1, 500) * heroGoldMult(hero)));
    hero.gold += amount;
    push('loot', `${hero.name} получает ${amount} золота.`);
  }

  if (effects.heal && !state.over) {
    hero.hp = Math.min(hero.maxHp, hero.hp + clamp(effects.heal, 0, 20));
    push('loot', `${hero.name} восстанавливает ${clamp(effects.heal, 0, 20)} HP.`);
  }

  if (effects.playerDamage && !state.over) {
    const dmg = clamp(effects.playerDamage, 0, 15);
    hero.hp -= dmg;
    state.deathCause = effects.causeOfDeath ? String(effects.causeOfDeath).slice(0, 80) : 'мир оказался хуже игрока';
    // если ДМ назвал врага, который нас бьёт — покажем его в боевом окне
    const named = effects.enemyName &&
      visibleMonsters(state, heroIdx).find(m => m.name.toLowerCase().includes(String(effects.enemyName).toLowerCase()));
    if (named) markCombat(state, hero, named);
    push('combat', `${hero.name} получает ${dmg} урона (осталось ${Math.max(0, hero.hp)} HP).`);
  }

  if (effects.xpGain) {
    const levels = gainXp(hero, clamp(effects.xpGain, 0, 100), state.rng);
    push('loot', `${hero.name} получает ${clamp(effects.xpGain, 0, 100)} опыта.` + (levels ? ` УРОВЕНЬ ${hero.level}!` : ''));
  }

  if (effects.questAdd) addQuest(state, String(effects.questAdd).slice(0, 100));
  if (effects.questDone) {
    const q = state.quests.find(t => t.includes(String(effects.questDone).slice(0, 20)));
    if (q) state.quests = state.quests.filter(t => t !== q);
  }

  // сюжет: ИИ задаёт злодея и его цель (обычно в интро)
  if (state.story && !state.story.villain && effects.villain) {
    state.story.villain = String(effects.villain).slice(0, 60);
    state.story.villainGoal = String(effects.villainGoal || '').slice(0, 120);
    push('victory', `⚜ ЛЕГЕНДА: ${state.story.villain} — ${state.story.villainGoal || 'твоя главная угроза'}.`);
  }

  if (effects.narrative) push('dm', String(effects.narrative).slice(0, 1200));

  // подсказки ДМа: 2-3 кликабельных варианта действий (UI рендерит чипами)
  if (Array.isArray(effects.suggestions) && effects.suggestions.length) {
    const clean = effects.suggestions
      .filter(s => typeof s === 'string' && s.trim())
      .map(s => s.trim())
      .slice(0, 3);
    if (clean.length) push('suggest', JSON.stringify(clean));
  }

  if (hero.hp <= 0 && hero.alive && !state.story?.won) {
    hero.alive = false;
    hero.epitaph = state.deathCause || 'кончилось плохо';
    push('death', `☠ ${hero.name} мёртв. Эпитафия: ${hero.epitaph}`);
    if (state.heroes.every(h => !h.alive)) {
      state.over = true;
      state.epitaph = hero.epitaph;
      push('death', `☠ Партия уничтожена.`);
    } else if (heroIdx === state.activeIdx) {
      // умер именно тот, чей ход, — очередь иначе застрянет на мёртвом навсегда
      advanceTurn(state);
    }
  }
  rememberEvents(state, events);
  return events;
}
