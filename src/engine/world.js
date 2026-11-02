// world.js — мир задаётся названием и описанием, а не жанровым шаблоном.
// Всё, что движок придумывает сам (классы, злодея), собирается из слов мира.

const STOP = new Set((
  'этот эта эти тот та те весь вся всё все свой своя свои своим своими ' +
  'который которая которые чтобы когда где куда откуда потом очень ' +
  'можно нужно нельзя есть был была было были будет будут ' +
  'только тоже также ещё еще уже почти через после перед между ' +
  'город мир место время день ночь люди человек герой ' +
  'тебя тобой тебе меня мной себе себя один одна одно ' +
  'много мало такое такой такая такие твой твоя твои ваш ваша ваши'
).split(/\s+/));

/**
 * Значимые слова мира: сначала имена собственные, потом просто длинные.
 * Дедуп по первым пяти буквам — «долги» и «долгами» дают одно слово.
 */
export function worldWords(text, limit = 6) {
  const raw = String(text || '').split(/[^0-9A-Za-zА-Яа-яЁё-]+/);
  const proper = [], plain = [];
  const seen = new Set();
  raw.forEach((w, i) => {
    const clean = w.replace(/-/g, '');
    if (clean.length < 4) return;
    const low = clean.toLowerCase();
    if (STOP.has(low) || /^\d+$/.test(low)) return;
    const stem = low.slice(0, 5);
    if (seen.has(stem)) return;
    seen.add(stem);
    (i > 0 && /^[A-ZА-ЯЁ]/.test(w) ? proper : plain).push(low);
  });
  return [...proper, ...plain].slice(0, limit);
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// Три роли, а не три жанра: кто бьёт, кто думает, кто говорит.
const ROLES = [
  {
    line: 'бьёт первым и не извиняется',
    stats: { str: 15, dex: 12, int: 9, con: 14, cha: 9, luck: 9 },
    ability: { name: 'Удар без предупреждения', active: 'smite', power: 7, cd: 3, passive: 'crit', passivePower: 2 }
  },
  {
    line: 'считает ходы на три вперёд',
    stats: { str: 9, dex: 14, int: 15, con: 11, cha: 10, luck: 11 },
    ability: { name: 'Холодный расчёт', active: 'dash', power: 4, cd: 3, passive: 'ac', passivePower: 2 }
  },
  {
    line: 'говорит за всех и договаривается',
    stats: { str: 10, dex: 11, int: 12, con: 11, cha: 16, luck: 10 },
    ability: { name: 'Слово в нужный момент', active: 'heal', power: 6, cd: 4, passive: 'gold', passivePower: 2 }
  }
];

const GENERIC = ['Боец', 'Хитрец', 'Говорун'];

/** Классы из слов мира: имена берутся из названия и описания, а не из наборов. */
export function classesFromWorld(world) {
  const words = worldWords(world, 3);
  return ROLES.map((role, i) => ({
    name: words[i] ? cap(words[i]) : GENERIC[i],
    desc: cap(role.line) + '.',
    stats: { ...role.stats },
    ability: { ...role.ability }
  }));
}

const SHAPES = [
  w => `Тот, кто держит «${w}»`,
  w => `Хозяйка «${w}»`,
  w => `Первый из «${w}»`,
  w => `Голос «${w}»`
];

/** Злодей из слов мира. */
export function villainFromWorld(world, rng = Math.random) {
  const words = worldWords(world, 4).map(cap);
  if (!words.length) return { villain: 'Тот-Кто-Считает-Часы', goal: 'остановить время для всего живого' };
  const shape = SHAPES[Math.floor(rng() * SHAPES.length) % SHAPES.length];
  const second = words[1] || words[0];
  return { villain: shape(words[0]), goal: `подмять под себя всё, что связано с «${second}»` };
}
