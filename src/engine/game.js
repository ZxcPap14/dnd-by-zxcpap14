// game.js — оркестратор: состояние партии, парсер русских команд, применение интентов.
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

let monSeq = 0;

/** Офлайн-спавн: монстры и лут по этажу. При подключённом ИИ вместо этого — мир ИИ. */
export function populateFloor(state) {
  const rng = state.rng;
  state.monsters = [];
  state.floorItems = [];

  const depthBoost = state.depth;
  const count = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    const pos = randomFloor(rng, state.dungeon);
    if (dist(pos.x, pos.y, state.pos.x, state.pos.y) < 4) continue;
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
  // вытащим существительное из описания мира — минимальная генерация без ИИ
  const words = (worldDesc || '').split(/\s+/).filter(w => w.length > 4 && /[а-яёa-z]/i.test(w));
  if (words.length) {
    const w = words[Math.floor(rng() * words.length)].toLowerCase().replace(/[.,!?]/g, '');
    return `озлобленный ${w}`;
  }
  return generic[Math.floor(rng() * generic.length)];
}

/**
 * Новая партия.
 * @param {{seed?: number, mode?: string, worldDesc: string, className: string, name: string}} opts
 */
export function newGame(opts) {
  const seed = opts.seed ?? (Date.now() ^ (Math.random() * 0xffffffff));
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
    log: [],
    floorName: `Этаж 1`
  };
  state.dice = makeDice(state.rng);
  state.dungeon = generateDungeon(state.rng);
  state.player = createPlayer({ name: opts.name, className: opts.className, stats: opts.stats });
  const start = randomFloor(state.rng, state.dungeon);
  state.pos = start;
  populateFloor(state);
  state.fov = computeFov(state.dungeon, start.x, start.y);
  return state;
}

/**
 * Граница слова для кириллицы: \b в JS не работает с не-ASCII.
 * suffix=true — стем-режим: «задач» матчит «задачи», «атак» — «атакую».
 */
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

/** Монстры в зоне видимости. */
export function visibleMonsters(state) {
  return state.monsters.filter(m => state.fov.has(`${m.x},${m.y}`) && m.hp > 0);
}

/**
 * Применение интента к состоянию. Возвращает массив событий.
 * @param state — мутируется
 */
export function applyIntent(state, intent) {
  const events = [];
  if (state.over || intent.intent === 'none') return events;
  const push = (kind, text) => events.push(ev(kind, text));
  const dice = state.dice;
  const player = state.player;
  state.turn++;

  switch (intent.intent) {
    case 'move': {
      const [dx, dy] = intent.dirVec;
      const nx = state.pos.x + dx, ny = state.pos.y + dy;
      if (nx < 0 || ny < 0 || nx >= state.dungeon.w || ny >= state.dungeon.h ||
          state.dungeon.grid[ny][nx] === TILE.WALL) {
        push('system', 'Ты упираешься в холодную стену. Она не впечатлена.');
        break;
      }
      const monster = state.monsters.find(m => m.hp > 0 && m.x === nx && m.y === ny);
      if (monster) {
        push('combat', `Путь преграждает ${monster.name}. Бой!`);
        events.push(...resolveCombatRound(state, monster, dice));
        break;
      }
      state.pos = { x: nx, y: ny };
      const tile = state.dungeon.grid[ny][nx];
      if (tile === TILE.STAIRS) push('system', 'Ты стоишь на лестнице вниз. (Скажи «спускаюсь»)');
      gainXp(state.player, 2); // опыт за исследование
      state.fov = computeFov(state.dungeon, nx, ny);
      // подбор предмета под ногами
      const here = state.floorItems.find(it => it.x === nx && it.y === ny);
      if (here) events.push(...pickupItem(state, here, push));
      break;
    }

    case 'attack': {
      const targets = visibleMonsters(state);
      if (!targets.length) {
        push('system', 'Ты угрожающе машешь оружием в пустоту. Пустота не в счёт.');
        break;
      }
      let target = targets[0];
      if (intent.target) {
        const found = targets.find(m => m.name.toLowerCase().includes(intent.target.toLowerCase()));
        if (found) target = found;
      }
      push('combat', `Ты бросаешься на ${target.name}!`);
      events.push(...resolveCombatRound(state, target, dice));
      break;
    }

    case 'use': {
      const item = findItem(player, intent.target);
      if (!item) { push('system', `Среди вещей нет ничего похожего на «${intent.target}».`); break; }
      if (item.type === 'potion') {
        removeItem(player, item.id);
        const heal = item.heal || 8;
        player.hp = Math.min(player.maxHp, player.hp + heal);
        push('loot', `Ты вливаешь в себя ${item.name} (+${heal} HP). Жизнь налаживается.`);
      } else if (item.type === 'weapon' || item.type === 'armor') {
        events.push(...applyIntent(state, { intent: 'equip', target: item.name }));
      } else {
        push('system', `${item.name}: на вкус как побитая жизнь. Больше не будем.`);
      }
      break;
    }

    case 'equip': {
      const item = findItem(player, intent.target);
      if (!item) { push('system', `Не нашёл «${intent.target}» в инвентаре.`); break; }
      const { equipped, unequipped } = equipItem(player, item);
      if (equipped) {
        push('loot', `Экипировано: ${equipped.name}` + (unequipped ? ` (в рюкзак уходит ${unequipped.name})` : ''));
      } else {
        push('system', `${item.name} нельзя надеть. Разве что как украшение.`);
      }
      break;
    }

    case 'pickup': {
      const here = state.floorItems.find(it => it.x === state.pos.x && it.y === state.pos.y);
      if (!here) { push('system', 'Под ногами пусто. Даже пыли нет.'); break; }
      events.push(...pickupItem(state, here, push));
      break;
    }

    case 'descend': {
      if (state.dungeon.grid[state.pos.y][state.pos.x] !== TILE.STAIRS) {
        push('system', 'Чтобы спуститься, нужно сначала найти лестницу. Она не под тобой.');
        break;
      }
      state.depth++;
      state.dungeon = generateDungeon(state.rng);
      const start = randomFloor(state.rng, state.dungeon);
      state.pos = start;
      state.floorName = `Этаж ${state.depth}`;
      populateFloor(state);
      state.fov = computeFov(state.dungeon, start.x, start.y);
      gainXp(player, 30);
      push('system', `Ты спускаешься глубже. ${state.floorName}. Воздух гуще, тьма наглее.`);
      break;
    }

    case 'inventory':
      push('system', renderInventory(player));
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
      push('system', describeSurroundings(state));
      break;

    case 'wait':
      push('system', 'Ты стоишь и слушаешь тишину. Тишина слушает в ответ.');
      break;

    case 'free':
      // свободный текст — обрабатывает ИИ-слой (или офлайн-заглушка)
      push('dm', `__FREE__${intent.text}`);
      break;
  }

  // смерть?
  if (player.hp <= 0 && !state.over) {
    state.over = true;
    state.epitaph = state.deathCause || 'умер при невыясненных обстоятельствах';
    push('death', `☠ ${player.name} мёртв. Эпитафия: ${state.epitaph}`);
  }
  return events;
}

function pickupItem(state, item, push) {
  const events = [];
  state.floorItems = state.floorItems.filter(it => it !== item);
  if (item.type === 'gold') {
    state.player.gold += item.qty;
    events.push(ev('loot', `Подобрано: ${item.qty} золота. Капиталист внутри доволен.`));
  } else {
    addItem(state.player, item);
    events.push(ev('loot', `Подобрано: ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''}.`));
  }
  gainXp(state.player, 5);
  return events;
}

/** Один раунд боя: игрок бьёт, если враг жив — враг отвечает. */
export function resolveCombatRound(state, monster, dice) {
  const events = [];
  const push = (kind, text) => events.push(ev(kind, text));
  const player = state.player;
  const weapon = playerWeapon(player);

  // инициатива решает, кто первым в этом раунде
  const pInit = rollInitiative(dice, player.stats.dex).total;
  const mInit = rollInitiative(dice, player.stats.dex).total + 1; // монстру чуть легче
  const playerFirst = pInit >= mInit;

  const playerStrike = () => {
    const atk = attackRoll(dice, player.stats, weapon, 10 + (monster.toHit || 0));
    const rollEv = ev('roll', `d20: [${atk.raw}]${atk.crit ? ' КРИТ!' : atk.fumble ? ' провал...' : ''} → атака ${atk.total}`);
    events.push(rollEv);
    if (!atk.hit) {
      push('combat', `Ты промахиваешься по ${monster.name}. ${atk.fumble ? 'Очень зрелищно промахиваешься.' : ''}`);
      return;
    }
    const dmg = damageRoll(dice, weapon, player.stats.str, atk.crit);
    monster.hp -= dmg.total;
    push('combat', `${atk.crit ? 'КРИТИЧЕСКИЙ УДАР! ' : ''}Ты наносишь ${dmg.total} урона ${monster.name} ${dmg.rolls.map(r => `[${r}]`).join('')}. ${monster.hp <= 0 ? `${monster.name} повержен!` : `У него осталось ${monster.hp} HP.`}`);
    if (monster.hp <= 0) {
      const levels = gainXp(player, monster.xp);
      push('loot', `Получено ${monster.xp} опыта.` + (levels ? ` УРОВЕНЬ ${player.level}!` : ''));
      const drop = rollDrop(dice, BASIC_DROP_TABLE, state.depth);
      if (drop) {
        state.floorItems.push({ ...drop, x: monster.x, y: monster.y });
        push('loot', `${monster.name} роняет: ${drop.name}.`);
      }
    }
  };

  const monsterStrike = () => {
    const atk = monsterAttack(dice, monster, playerAc(player));
    if (!atk.hit) {
      push('combat', `${monster.name} бьёт мимо ${atk.crit ? '(а ведь чуть не кританул)' : ''}.`);
      return;
    }
    player.hp -= atk.dmg;
    state.deathCause = `убит ${monster.name}`;
    push('combat', `${monster.name} ${atk.crit ? 'КРИТУЕТ' : 'попадает'} по тебе: -${atk.dmg} HP (осталось ${Math.max(0, player.hp)}).`);
  };

  if (playerFirst) { playerStrike(); if (monster.hp > 0) monsterStrike(); }
  else { monsterStrike(); if (player.hp > 0) playerStrike(); }

  return events;
}

export function renderInventory(player) {
  const lines = [`HP: ${player.hp}/${player.maxHp} | Ур.${player.level} | XP ${player.xp}/${xpNeed(player)} | Золото: ${player.gold}`];
  lines.push(`Оружие: ${player.equipment.weapon ? player.equipment.weapon.name : 'кулаки'} | Броня: ${player.equipment.armor ? player.equipment.armor.name : 'нет'} (AC ${playerAc(player)})`);
  lines.push('Рюкзак:');
  if (!player.inventory.length) lines.push('  (пусто)');
  for (const it of player.inventory) lines.push(`  - ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''}`);
  return lines.join('\n');
}

function xpNeed(player) {
  return player.level * 100;
}

export function describeSurroundings(state) {
  const mons = visibleMonsters(state).map(m => `${m.name} (HP ${m.hp}/${m.maxHp})`);
  const items = state.floorItems.filter(it => state.fov.has(`${it.x},${it.y}`));
  const parts = [];
  parts.push(`${state.floorName}. `);
  if (mons.length) parts.push(`Рядом: ${mons.join(', ')}. `);
  if (items.length) parts.push(`На земле: ${items.map(i => i.name).join(', ')}. `);
  if (!mons.length && !items.length) parts.push('Пока ничего интересного.');
  return parts.join('');
}

/** Добавить квест в журнал (ИИ или движок). */
export function addQuest(state, text) {
  if (text && !state.quests.includes(text)) state.quests.push(text);
}

/**
 * Применение эффектов, предложенных ИИ. Движок ВАЛИДИРУЕТ всё: ИИ не может
 * оживить мёртвого, выдать золотые горы или обнулить HP игрока.
 * @param {object} effects — {narrative?, playerDamage?, heal?, xpGain?, goldGain?,
 *   itemGain?, questAdd?, questDone?, enemyName?, enemyDamage?, enemySpawn?, causeOfDeath?}
 * @returns {object[]} события
 */
export function applyDmEffects(state, effects) {
  const events = [];
  const push = (kind, text) => events.push(ev(kind, text));
  if (!effects || typeof effects !== 'object') return events;
  const player = state.player;
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
    const mons = visibleMonsters(state);
    const target = (effects.enemyName &&
      mons.find(m => m.name.toLowerCase().includes(String(effects.enemyName).toLowerCase()))) || mons[0];
    if (target) {
      const dmg = clamp(effects.enemyDamage, 0, 30);
      target.hp -= dmg;
      push('combat', `${target.name} получает ${dmg} урона. ${target.hp <= 0 ? 'Повержен!' : `Осталось ${target.hp} HP.`}`);
      if (target.hp <= 0) {
        const levels = gainXp(player, target.xp);
        push('loot', `Получено ${target.xp} опыта.` + (levels ? ` УРОВЕНЬ ${player.level}!` : ''));
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
      player.gold += clamp(effects.itemGain.gold, 1, 500);
      push('loot', `Получено: ${clamp(effects.itemGain.gold, 1, 500)} золота.`);
    } else {
      addItem(player, item);
      push('loot', `Получено: ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''}.`);
    }
    gainXp(player, 5);
  }

  if (effects.goldGain) {
    player.gold += clamp(effects.goldGain, 1, 500);
    push('loot', `Получено ${clamp(effects.goldGain, 1, 500)} золота.`);
  }

  if (effects.heal && !state.over) {
    player.hp = Math.min(player.maxHp, player.hp + clamp(effects.heal, 0, 20));
    push('loot', `Восстановлено ${clamp(effects.heal, 0, 20)} HP.`);
  }

  if (effects.playerDamage && !state.over) {
    const dmg = clamp(effects.playerDamage, 0, 15);
    player.hp -= dmg;
    state.deathCause = effects.causeOfDeath ? String(effects.causeOfDeath).slice(0, 80) : 'мир оказался хуже игрока';
    push('combat', `Ты получаешь ${dmg} урона (осталось ${Math.max(0, player.hp)} HP).`);
  }

  if (effects.xpGain) {
    const levels = gainXp(player, clamp(effects.xpGain, 0, 100));
    push('loot', `Получено ${clamp(effects.xpGain, 0, 100)} опыта.` + (levels ? ` УРОВЕНЬ ${player.level}!` : ''));
  }

  if (effects.questAdd) addQuest(state, String(effects.questAdd).slice(0, 100));
  if (effects.questDone) {
    const q = state.quests.find(t => t.includes(String(effects.questDone).slice(0, 20)));
    if (q) state.quests = state.quests.filter(t => t !== q);
  }

  if (effects.narrative) push('dm', String(effects.narrative).slice(0, 1200));

  if (player.hp <= 0 && !state.over) {
    state.over = true;
    state.epitaph = state.deathCause || 'кончилось плохо';
    push('death', `☠ ${player.name} мёртв. Эпитафия: ${state.epitaph}`);
  }
  return events;
}
