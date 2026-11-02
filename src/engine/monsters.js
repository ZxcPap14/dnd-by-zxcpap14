// monsters.js — поведение монстров: видят героя — преследуют и бьют в упор,
// не видят — иногда бродят. Всё меняет state и возвращает события.
import { dist, TILE } from './map.js';
import { monsterAttack } from './combat.js';
import { playerAc } from './player.js';
import { ev, markCombat } from './game.js';

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
