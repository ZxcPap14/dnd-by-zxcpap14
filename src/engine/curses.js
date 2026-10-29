// curses.js — проклятые предметы.
// Правило: проклятие не убивает сразу, а тянет ресурс и НЕ ДАЁТ СНЯТЬ вещь.
// Снять можно только у торговца за золото — так у золота появляется второй смысл,
// а у находки «слишком хороший меч» — законная причина для паранойи.
// Модуль намеренно ничего не импортирует: его функции зовут player.js и game.js.

/**
 * Каталог проклятий. Поля — модификаторы к уже существующим системам:
 *   dmg  — к урону оружия
 *   ac   — к защите
 *   hit  — к броску атаки
 *   drain — HP, которые вещь выпивает за каждый ход
 *   goldMult — множитель добытого золота
 */
export const CURSES = [
  { id: 'bloodthirst', name: 'Жажда крови', hint: 'меч пьёт кровь владельца', dmg: 2, drain: 1 },
  { id: 'lead', name: 'Свинцовая тяжесть', hint: 'вещь тяжелее, чем должна быть', ac: -2, hit: -1 },
  { id: 'scream', name: 'Кричащая сталь', hint: 'каждый взмах слышно на весь этаж', hit: -2 },
  { id: 'greed', name: 'Жадность', hint: 'золото липнет к чужим рукам', goldMult: 0.7 },
  { id: 'frailty', name: 'Хрупкость', hint: 'кости становятся стеклянными', ac: -1, drain: 1 }
];

export function curseById(id) {
  return CURSES.find(c => c.id === id) || null;
}

/** Предмет проклят? (флаг переживает сохранение: это обычное поле объекта). */
export function isCursed(item) {
  return !!item && item.cursed === true;
}

/** Проклятие ещё не проявилось: игрок видит вещь, но не её свойства. */
export function isUnknown(item) {
  return isCursed(item) && item.identified !== true;
}

/** Проклятие проявилось — теперь оно честно подписано в рюкзаке. */
export function revealCurse(item) {
  if (isCursed(item)) item.identified = true;
  return item;
}

/** Пометить предмет проклятым (используется генерацией лута и витриной торговца). */
export function curseItem(item, rng) {
  if (!item || item.type === 'gold' || item.type === 'potion') return item;
  const c = CURSES[Math.floor(rng() * CURSES.length)] || CURSES[0];
  return { ...item, cursed: true, curse: c.id, curseName: c.name, identified: false };
}

/**
 * Может быть, проклясть предмет. Зелья и золото не проклинаем:
 * зелье выпивают сразу, и «проклятое зелье» — это просто яд, а не загадка.
 */
export function maybeCurse(item, rng, depth = 1, chance = null) {
  if (!item || item.type === 'gold' || item.type === 'potion') return item;
  const p = chance == null ? Math.min(0.34, 0.12 + depth * 0.03) : chance;
  if (rng() >= p) return item;
  return curseItem(item, rng);
}

/** Сумма эффектов всех надетых проклятых вещей. */
export function curseMods(hero) {
  const out = { dmg: 0, ac: 0, hit: 0, drain: 0, goldMult: 1 };
  if (!hero?.equipment) return out;
  for (const slot of ['weapon', 'armor']) {
    const item = hero.equipment[slot];
    if (!isCursed(item)) continue;
    const c = curseById(item.curse);
    if (!c) continue;
    out.dmg += c.dmg || 0;
    out.ac += c.ac || 0;
    out.hit += c.hit || 0;
    out.drain += c.drain || 0;
    out.goldMult *= c.goldMult == null ? 1 : c.goldMult;
  }
  return out;
}

/** Надетый проклятый предмет в слоте — его нельзя заменить. */
export function stuckItem(hero, slot) {
  const item = hero?.equipment?.[slot];
  return isCursed(item) ? item : null;
}

/** Сколько торговец возьмёт за снятие проклятия. */
export function cursePrice(state, hero) {
  const count = ['weapon', 'armor'].filter(s => isCursed(hero?.equipment?.[s])).length || 1;
  return (45 + Math.max(1, state?.depth | 0) * 12) * count;
}

/** Снять проклятие с вещи (после оплаты у торговца). */
export function uncurseItem(item) {
  if (!item) return item;
  item.cursed = false;
  item.curse = null;
  item.curseName = null;
  item.identified = true;
  return item;
}

/** Строка для панели статов: «Кинжал ⚠». */
export function itemNameWithCurse(item) {
  if (!item) return '';
  if (isUnknown(item)) return `? ${item.name}`;
  return isCursed(item) ? `${item.name} ⚠` : item.name;
}
