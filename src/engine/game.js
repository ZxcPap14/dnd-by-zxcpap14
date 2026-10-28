// game.js — оркестратор: состояние партии, парсер русских команд, применение интентов.
// v0.5: мультигеройность — heroes[], очерёдность ходов, смерть партии.
// Принцип «ИИ предлагает — код решает»: любые изменения состояния проходят отсюда.

import { createRng, makeDice, mod } from './rng.js';
import { generateDungeon, randomFloor, computeFov, dist, TILE } from './map.js';
import {
  createPlayer, gainXp, addItem, removeItem, findItem, equipItem,
  playerAc, playerWeapon, makeItem
} from './player.js';
import {
  rollInitiative, attackRoll, damageRoll, monsterAttack, rollDrop, BASIC_DROP_TABLE
} from './combat.js';

export const DIRS = {
  'север': [0, -1], 'с': [0, -1], 'north': [0, -1], 'n': [0, -1],
  'юг': [0, 1], 'ю': [0, 1], 'south': [0, 1], 's': [0, 1],
  'восток': [1, 0], 'в': [1, 0], 'east': [1, 0], 'e': [1, 0],
  'запад': [-1, 0], 'з': [-1, 0], 'west': [-1, 0], 'w': [-1, 0]
};

export const HERO_GLYPHS = ['@', '#', 'Ω', 'Φ'];

let monSeq = 0;

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
    if (drop) state.floorItems.push({ ...drop, x: pos.x, y: pos.y });
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
    depth: 1,
    over: false,
    epitaph: null,
    turn: 0,
    quests: [],
    floorName: `Этаж 1`,
    heroes: [],
    activeIdx: 0,
    monsters: [],
    floorItems: []
  };
  state.dice = makeDice(state.rng);

  // герои — createPlayer + позиция/FOV/жизнь
  const taken = new Set();
  state.dungeon = generateDungeon(state.rng);
  state.heroes = players.map(pd => {
    const hero = { ...createPlayer(pd), pos: { x: 0, y: 0 }, fov: new Set(), alive: true, epitaph: null };
    let spot = randomFloor(state.rng, state.dungeon);
    let tries = 0;
    while (taken.has(`${spot.x},${spot.y}`) && tries++ < 50) spot = randomFloor(state.rng, state.dungeon);
    taken.add(`${spot.x},${spot.y}`);
    hero.pos = spot;
    hero.fov = computeFov(state.dungeon, spot.x, spot.y);
    return hero;
  });

  // совместимость: state.player / state.pos / state.fov → активный герой
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

  populateFloor(state);
  return state;
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

/** Граница слова для кириллицы: \b в JS не работает с не-ASCII. */
function W(word, suffix = false) {
  const tail = suffix ? '[а-яёa-z]*' : '';
  return new RegExp(`(?:^|[^а-яёa-z])(?:${word})${tail}(?![а-яёa-z])`, 'i');
}

/**
 * Парсер свободного текста → интент. Всё, что не распознано, уходит ИИ как 'free'.
 */
export function parseCommand(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return { intent: 'none' };

  // движение (только целые слова: «с» не должно матчиться внутри «стражу»)
  for (const [word, d] of Object.entries(DIRS)) {
    if (W(word).test(t)) {
      return { intent: 'move', dir: word, dirVec: d };
    }
  }
  if (W('инвентарь|рюкзак|вещи|inv', true).test(t)) return { intent: 'inventory' };
  if (W('карта|карту|map', true).test(t)) return { intent: 'map' };
  if (W('задач|квест|quest|журнал', true).test(t)) return { intent: 'quests' };
  if (W('осмотр|огляде|look|где я', true).test(t)) return { intent: 'look' };
  if (W('ждать|постоять|wait|отдохну', true).test(t)) return { intent: 'wait' };
  if (W('спус|лестниц|descend', true).test(t)) return { intent: 'descend' };

  let m;
  if ((m = t.match(W('выпей|выпить|пью|использ|примен|use|drink', true))))
    return { intent: 'use', target: afterVerb(t, m) };
  if ((m = t.match(W('надень|надеть|экипир|возьми|equip|wield', true))))
    return { intent: 'equip', target: afterVerb(t, m) };
  if ((m = t.match(W('атак|бей|бью|удар|убей|убить|attack|hit|kill', true))))
    return { intent: 'attack', target: afterVerb(t, m) };
  if ((m = t.match(W('подним|подобрать|взять|собер|pick|grab', true))))
    return { intent: 'pickup', target: afterVerb(t, m) };

  return { intent: 'free', text };
}

/** Слово(а) после глагола в исходной строке. */
function afterVerb(t, m) {
  const idx = t.indexOf(m[0]) + m[0].length;
  return t.slice(idx).replace(/^[,\s]+/, '').trim();
}

/** Событие для лога/ИИ. kind: dm|system|roll|combat|loot|death|levelup */
export function ev(kind, text) {
  return { kind, text, turn: 0 };
}

/** Монстры в зоне видимости героя. */
export function visibleMonsters(state, heroIdx = state.activeIdx) {
  const hero = state.heroes[heroIdx];
  if (!hero) return [];
  return state.monsters.filter(m => hero.fov.has(`${m.x},${m.y}`) && m.hp > 0);
}

/** Все живые герои на лестнице? (правило общего спуска) */
export function allOnStairs(state) {
  const s = state.dungeon.stairs;
  return state.heroes.filter(h => h.alive).every(h => h.pos.x === s.x && h.pos.y === s.y);
}

/**
 * Применение интента к состоянию от конкретного героя. Возвращает события.
 * Действовать может только активный герой (очередь ходов).
 */
export function applyIntent(state, intent, heroIdx = state.activeIdx) {
  if (state.over || intent.intent === 'none') return [];
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
        push('system', 'Ты упираешься в холодную стену. Она не впечатлена.');
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
      gainXp(hero, 2); // опыт за исследование
      hero.fov = computeFov(state.dungeon, nx, ny);
      const here = state.floorItems.find(it => it.x === nx && it.y === ny);
      if (here) events.push(...pickupItem(state, hero, here));
      break;
    }

    case 'attack': {
      const targets = visibleMonsters(state, heroIdx);
      if (!targets.length) {
        push('system', 'Ты угрожающе машешь оружием в пустоту. Пустота не в счёт.');
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
      if (!item) { push('system', `Среди вещей ${hero.name} нет ничего похожего на «${intent.target}».`); break; }
      if (item.type === 'potion') {
        removeItem(hero, item.id);
        const heal = item.heal || 8;
        hero.hp = Math.min(hero.maxHp, hero.hp + heal);
        push('loot', `${hero.name} вливает в себя ${item.name} (+${heal} HP). Жизнь налаживается.`);
      } else if (item.type === 'weapon' || item.type === 'armor') {
        events.push(...applyIntent(state, { intent: 'equip', target: item.name }, heroIdx));
      } else {
        push('system', `${item.name}: на вкус как побитая жизнь. Больше не будем.`);
      }
      break;
    }

    case 'equip': {
      const item = findItem(hero, intent.target);
      if (!item) { push('system', `${hero.name} не нашёл «${intent.target}» в инвентаре.`); break; }
      const { equipped, unequipped } = equipItem(hero, item);
      if (equipped) {
        push('loot', `Экипировано: ${equipped.name}` + (unequipped ? ` (в рюкзак уходит ${unequipped.name})` : ''));
      } else {
        push('system', `${item.name} нельзя надеть. Разве что как украшение.`);
      }
      break;
    }

    case 'pickup': {
      const here = state.floorItems.find(it => it.x === hero.pos.x && it.y === hero.pos.y);
      if (!here) { push('system', 'Под ногами пусто. Даже пыли нет.'); break; }
      events.push(...pickupItem(state, hero, here));
      break;
    }

    case 'descend': {
      if (state.dungeon.grid[hero.pos.y][hero.pos.x] !== TILE.STAIRS) {
        push('system', 'Чтобы спуститься, нужно сначала найти лестницу. Она не под тобой.');
        break;
      }
      if (!allOnStairs(state)) {
        push('system', 'Партия не собрана: не все живые герои на лестнице. Ждём отстающих.');
        break;
      }
      state.depth++;
      state.dungeon = generateDungeon(state.rng);
      const taken = new Set();
      state.heroes.forEach(h => {
        let spot = randomFloor(state.rng, state.dungeon);
        let tries = 0;
        while (taken.has(`${spot.x},${spot.y}`) && tries++ < 50) spot = randomFloor(state.rng, state.dungeon);
        taken.add(`${spot.x},${spot.y}`);
        h.pos = spot;
        h.fov = computeFov(state.dungeon, spot.x, spot.y);
      });
      state.floorName = `Этаж ${state.depth}`;
      populateFloor(state);
      gainXp(hero, 30);
      push('system', `Партия спускается глубже. ${state.floorName}. Воздух гуще, тьма наглее.`);
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

    case 'map':
      push('system', 'Карта уже перед глазами слева. Туман войны скрывает неисследованное.');
      break;

    case 'look':
      push('system', describeSurroundings(state, heroIdx));
      break;

    case 'wait':
      push('system', 'Ты стоишь и слушаешь тишину. Тишина слушает в ответ.');
      break;

    case 'free':
      // свободный текст — обрабатывает ИИ-слой (или офлайн-заглушка)
      push('dm', `__FREE__${intent.text}`);
      break;
  }

  // смерть героя?
  if (hero.hp <= 0 && hero.alive) {
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
  return events;
}

function pickupItem(state, hero, item) {
  const events = [];
  state.floorItems = state.floorItems.filter(it => it !== item);
  if (item.type === 'gold') {
    hero.gold += item.qty;
    events.push(ev('loot', `${hero.name} подбирает ${item.qty} золота. Капиталист внутри доволен.`));
  } else {
    addItem(hero, item);
    events.push(ev('loot', `${hero.name} подбирает: ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''}.`));
  }
  gainXp(hero, 5);
  return events;
}

/** Один раунд боя: герой бьёт, если враг жив — враг отвечает ближайшему видимому герою. */
export function resolveCombatRound(state, hero, monster, dice) {
  const events = [];
  const push = (kind, text) => events.push(ev(kind, text));
  const weapon = playerWeapon(hero);

  const pInit = rollInitiative(dice, hero.stats.dex).total;
  const mInit = rollInitiative(dice, hero.stats.dex).total + 1;
  const playerFirst = pInit >= mInit;

  const playerStrike = () => {
    const atk = attackRoll(dice, hero.stats, weapon, 10 + (monster.toHit || 0));
    events.push(ev('roll', `${hero.name}: d20 [${atk.raw}]${atk.crit ? ' КРИТ!' : atk.fumble ? ' провал...' : ''} → атака ${atk.total}`));
    if (!atk.hit) {
      push('combat', `${hero.name} промахивается по ${monster.name}. ${atk.fumble ? 'Очень зрелищно промахивается.' : ''}`);
      return;
    }
    const dmg = damageRoll(dice, weapon, hero.stats.str, atk.crit);
    monster.hp -= dmg.total;
    push('combat', `${atk.crit ? 'КРИТИЧЕСКИЙ УДАР! ' : ''}${hero.name} наносит ${dmg.total} урона ${monster.name} ${dmg.rolls.map(r => `[${r}]`).join('')}. ${monster.hp <= 0 ? `${monster.name} повержен!` : `У него осталось ${monster.hp} HP.`}`);
    if (monster.hp <= 0) {
      const levels = gainXp(hero, monster.xp);
      push('loot', `${hero.name} получает ${monster.xp} опыта.` + (levels ? ` УРОВЕНЬ ${hero.level}!` : ''));
      const drop = rollDrop(dice, BASIC_DROP_TABLE, state.depth);
      if (drop) {
        state.floorItems.push({ ...drop, x: monster.x, y: monster.y });
        push('loot', `${monster.name} роняет: ${drop.name}.`);
      }
    }
  };

  const monsterStrike = () => {
    // монстр бьёт ближайшего видимого ему героя, а не только атакующего
    const candidates = state.heroes
      .filter(h => h.alive && h.fov.has(`${monster.x},${monster.y}`))
      .sort((a, b) => dist(a.pos.x, a.pos.y, monster.x, monster.y) - dist(b.pos.x, b.pos.y, monster.x, monster.y));
    const target = candidates[0] || hero;
    const atk = monsterAttack(dice, monster, playerAc(target));
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
  if (!mons.length && !items.length && !party.length) parts.push('Пока ничего интересного.');
  return parts.join('');
}

/** Добавить квест в журнал (ИИ или движок). */
export function addQuest(state, text) {
  if (text && !state.quests.includes(text)) state.quests.push(text);
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
    over: state.over, mode: state.mode, worldDesc: state.worldDesc, quests: [...state.quests],
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
      ac: playerAc(hero)
    },
    map: { w: state.dungeon.w, h: state.dungeon.h, cells, monsters, items }
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
      target.hp -= dmg;
      push('combat', `${target.name} получает ${dmg} урона. ${target.hp <= 0 ? 'Повержен!' : `Осталось ${target.hp} HP.`}`);
      if (target.hp <= 0) {
        const levels = gainXp(hero, target.xp);
        push('loot', `${hero.name} получает ${target.xp} опыта.` + (levels ? ` УРОВЕНЬ ${hero.level}!` : ''));
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
    gainXp(hero, 5);
  }

  if (effects.goldGain) {
    hero.gold += clamp(effects.goldGain, 1, 500);
    push('loot', `${hero.name} получает ${clamp(effects.goldGain, 1, 500)} золота.`);
  }

  if (effects.heal && !state.over) {
    hero.hp = Math.min(hero.maxHp, hero.hp + clamp(effects.heal, 0, 20));
    push('loot', `${hero.name} восстанавливает ${clamp(effects.heal, 0, 20)} HP.`);
  }

  if (effects.playerDamage && !state.over) {
    const dmg = clamp(effects.playerDamage, 0, 15);
    hero.hp -= dmg;
    state.deathCause = effects.causeOfDeath ? String(effects.causeOfDeath).slice(0, 80) : 'мир оказался хуже игрока';
    push('combat', `${hero.name} получает ${dmg} урона (осталось ${Math.max(0, hero.hp)} HP).`);
  }

  if (effects.xpGain) {
    const levels = gainXp(hero, clamp(effects.xpGain, 0, 100));
    push('loot', `${hero.name} получает ${clamp(effects.xpGain, 0, 100)} опыта.` + (levels ? ` УРОВЕНЬ ${hero.level}!` : ''));
  }

  if (effects.questAdd) addQuest(state, String(effects.questAdd).slice(0, 100));
  if (effects.questDone) {
    const q = state.quests.find(t => t.includes(String(effects.questDone).slice(0, 20)));
    if (q) state.quests = state.quests.filter(t => t !== q);
  }

  if (effects.narrative) push('dm', String(effects.narrative).slice(0, 1200));

  if (hero.hp <= 0 && hero.alive) {
    hero.alive = false;
    hero.epitaph = state.deathCause || 'кончилось плохо';
    push('death', `☠ ${hero.name} мёртв. Эпитафия: ${hero.epitaph}`);
    if (state.heroes.every(h => !h.alive)) {
      state.over = true;
      state.epitaph = hero.epitaph;
      push('death', `☠ Партия уничтожена.`);
    }
  }
  return events;
}
