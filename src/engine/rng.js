// rng.js — детерминированный seeded RNG + честные кубики.
// Принцип спецификации: все броски делает код, не ИИ.

/**
 * mulberry32 — быстрый seeded PRNG.
 * @param {number} seed
 * @returns {() => number} float [0, 1)
 */
export function createRng(seed) {
  let a = seed >>> 0;
  const rng = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // состояние генератора нужно сохранению забега: продолжить с той же точки,
  // а не начинать последовательность заново (иначе «сейв-скам» ломает честность кубиков)
  rng.getState = () => a >>> 0;
  rng.setState = (v) => { a = (v | 0) >>> 0; };
  return rng;
}

/**
 * Набор кубиков поверх RNG.
 * @param {() => number} rng
 */
export function makeDice(rng) {
  return {
    /** 1d<sides> */
    d(sides) {
      return 1 + Math.floor(rng() * sides);
    },
    /** NdM → { rolls: number[], total: number } */
    roll(count, sides) {
      const rolls = [];
      let total = 0;
      for (let i = 0; i < Math.max(0, count | 0); i++) {
        const r = this.d(sides);
        rolls.push(r);
        total += r;
      }
      return { rolls, total };
    },
    /** честный d20 */
    d20() {
      return this.d(20);
    },
    /**
     * Проверка d20 + модификатор.
     * @returns {{ raw: number, total: number }}
     */
    check(mod = 0) {
      const raw = this.d20();
      return { raw, total: raw + mod };
    }
  };
}

/** Модификатор характеристики в стиле D&D: (stat-10)/2, округление вниз. */
export function mod(stat) {
  return Math.floor((stat - 10) / 2);
}

/**
 * Бросок с преимуществом/помехой (2d20, берём больший/меньший).
 */
export function withAdvantage(dice, advantage = true) {
  const a = dice.d20();
  const b = dice.d20();
  const raw = advantage ? Math.max(a, b) : Math.min(a, b);
  return { raw, rolls: [a, b] };
}
