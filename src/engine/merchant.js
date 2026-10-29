// merchant.js — торговец между этажами: ассортимент, покупка, продажа.
// Появляется после спуска на новый этаж и живёт там, пока партия не уйдёт глубже.
// Торговля НЕ тратит ход: это разговор, а не бросок кубика.

import { makeItem } from './player.js';
import { isCursed, maybeCurse, cursePrice, uncurseItem, itemNameWithCurse } from './curses.js';

/** Событие в формате движка (свой, чтобы не тянуть game.js — там уже есть ev). */
function mev(kind, text) {
  return { kind, text, turn: 0 };
}

/**
 * Товары. price — базовая цена, дальше её колышет rng и глубина.
 * Дорогие вещи не появляются на первых этажах: нечего покупать за 3 золота.
 */
const MERCHANT_GOODS = [
  { name: 'Зелье лечения', type: 'potion', heal: 8, price: 14 },
  { name: 'Густое зелье', type: 'potion', heal: 14, price: 27 },
  { name: 'Ржавый тесак', type: 'weapon', dmg: 3, price: 20 },
  { name: 'Клинок наёмника', type: 'weapon', dmg: 5, price: 45 },
  { name: 'Клык глубин', type: 'weapon', dmg: 7, price: 84 },
  { name: 'Кожаный доспех', type: 'armor', ac: 1, price: 24 },
  { name: 'Щит-крышка от котла', type: 'armor', ac: 1, price: 19 },
  { name: 'Кольчуга', type: 'armor', ac: 2, price: 54 }
];

const MERCHANT_NAMES = [
  'Торговец Тень', 'Лавочник Бурдюк', 'Мадам Сумрак', 'Скупщик Кость',
  'Перекупщик Шёпот', 'Тётя Хрип'
];

const MERCHANT_GREETINGS = [
  'Заходи, живой. Плачу мало, беру дорого — как все честные люди.',
  'У меня есть то, что тебе нужно. И то, что тебе не нужно, но ты купишь.',
  'Товар свежий. Предыдущий владелец уже не возражает.',
  'Золото вперёд. Кровь потом — это уже не моя проблема.',
  'Смотрю на тебя и вижу ходячий кошелёк. Приятно познакомиться.'
];

/** Сколько стоит предмет при продаже торговцу (он же не благотворитель). */
function itemValue(it) {
  return (it.dmg || 0) * 9 + (it.ac || 0) * 12 + (it.heal || 0) * 2 + 6;
}

/**
 * Собрать ассортимент под текущий этаж. Детерминированно от rng партии —
 * сохранение/продолжение даёт того же торговца с тем же товаром.
 */
export function openMerchant(state) {
  const rng = state.rng;
  const depth = Math.max(1, state.depth | 0);
  // на глубине 1 потолок цены ~60, на 6 — ~200: ассортимент растёт с этажами
  const ceiling = 26 + depth * 34;
  const pool = MERCHANT_GOODS.filter(g => g.price <= ceiling);
  const stock = [];
  const used = new Set();
  const want = 3 + (rng() < 0.5 ? 1 : 0);
  for (let guard = 0; stock.length < want && guard < 40; guard++) {
    const g = pool[Math.floor(rng() * pool.length)];
    if (!g || used.has(g.name)) continue;
    used.add(g.name);
    const base = makeItem({
      name: g.name, type: g.type,
      dmg: g.dmg || 0, ac: g.ac || 0, heal: g.heal || 0
    });
    // изредка торговец подсовывает проклятую вещь: он-то знает, что продаёт
    const item = maybeCurse(base, rng, depth, 0.1);
    if (isCursed(item)) item.identified = true; // и не скрывает — «честный» бизнес
    // наценка гуляет ±20% — торг начинается с несправедливой цены
    const price = Math.max(5, Math.round(g.price * (0.9 + rng() * 0.4)));
    stock.push({ ...item, price });
  }
  return {
    name: MERCHANT_NAMES[Math.floor(rng() * MERCHANT_NAMES.length)],
    greeting: MERCHANT_GREETINGS[Math.floor(rng() * MERCHANT_GREETINGS.length)],
    stock
  };
}

/** Текстовая витрина — для команды «торговец» и для лога. */
export function shopText(state, hero = null) {
  const m = state.merchant;
  if (!m) return 'Торговца рядом нет.';
  const lines = [`${m.name}: «${m.greeting}»`];
  if (!m.stock.length) lines.push('  Прилавок пуст — всё скупили до тебя.');
  for (const it of m.stock) {
    const meta = it.type === 'potion' ? `+${it.heal} HP`
      : it.type === 'weapon' ? `урон ${it.dmg}`
        : it.type === 'armor' ? `AC +${it.ac}` : '';
    lines.push(`  ${itemNameWithCurse(it)}${meta ? ` (${meta})` : ''} — ${it.price} золота`);
  }
  lines.push('Скажи «купить <название>» или «продать <название>».');
  const cursed = hero && ['weapon', 'armor'].filter(s => isCursed(hero.equipment?.[s]));
  if (cursed && cursed.length) {
    lines.push(`  ⚠ Снять проклятие — ${cursePrice(state, hero)} золота. Скажи «снять проклятие».`);
  }
  return lines.join('\n');
}

function findStock(m, namePart) {
  const q = String(namePart || '').toLowerCase().trim();
  if (!q) return m.stock[0] || null;
  return m.stock.find(it => it.name.toLowerCase().includes(q)) || null;
}

/**
 * Купить предмет. Возвращает { ok, events }.
 * ok=false → движок передаст попытку ДМу (он может обыграть торг), ход не сгорит.
 */
export function buyFromMerchant(state, hero, namePart) {
  const m = state.merchant;
  if (!m) return { ok: false, events: [mev('unhandled', 'Покупать не у кого — торговец остался этажом выше.')] };
  const item = findStock(m, namePart);
  if (!item) {
    return { ok: false, events: [mev('unhandled', `У торговца нет «${namePart || 'ничего'}». Он делает вид, что не слышал.`)] };
  }
  if (hero.gold < item.price) {
    return {
      ok: false,
      events: [mev('system', `Не хватает ${item.price - hero.gold} золота. Торговец смотрит на ${hero.name} как на пустой кошелёк.`)]
    };
  }
  hero.gold -= item.price;
  m.stock = m.stock.filter(it => it.id !== item.id);
  const bought = makeItem({ name: item.name, type: item.type, dmg: item.dmg, ac: item.ac, heal: item.heal, qty: item.qty });
  // проклятие переезжает вместе с вещью, иначе покупка «лечила» бы её
  if (isCursed(item)) Object.assign(bought, { cursed: true, curse: item.curse, curseName: item.curseName, identified: true });
  hero.inventory.push(bought);
  return {
    ok: true,
    events: [mev('loot', `${hero.name} покупает ${item.name} за ${item.price} золота (осталось ${hero.gold}). Торговец доволен чужим горем.`)]
  };
}

/** Продать предмет из рюкзака: 40% от его ценности, не меньше 1 золота. */
export function sellToMerchant(state, hero, namePart) {
  const m = state.merchant;
  if (!m) return { ok: false, events: [mev('unhandled', 'Продавать некому — вокруг только тьма и сырость.')] };
  const q = String(namePart || '').toLowerCase().trim();
  const item = q
    ? hero.inventory.find(it => it.name.toLowerCase().includes(q))
    : hero.inventory[0];
  if (!item) {
    return { ok: false, events: [mev('unhandled', `Продавать нечего: «${namePart || 'рюкзак'}» — это пустота.`)] };
  }
  const price = Math.max(1, Math.round(itemValue(item) * 0.4));
  hero.inventory = hero.inventory.filter(it => it.id !== item.id);
  hero.gold += price;
  return {
    ok: true,
    events: [mev('loot', `${hero.name} сбывает ${item.name} за ${price} золота (в кошельке ${hero.gold}). Торговец перепродаст вдвое дороже.`)]
  };
}

/** Торговец сворачивается: дальше этаж пустой. */
export function closeMerchant(state) {
  const name = state.merchant?.name || 'Торговец';
  state.merchant = null;
  return [mev('system', `${name} складывает товар в мешок и растворяется между камнями. Больше здесь не торгуют.`)];
}

/**
 * Снять проклятие с надетых вещей за золото. Единственный способ расстаться
 * с проклятой вещью: сам герой её не снимет, а торговец снимет — за деньги.
 * ok=false → движок не тратит ход и отдаёт попытку ДМу.
 */
export function removeCurse(state, hero) {
  const m = state.merchant;
  if (!m) return { ok: false, events: [mev('unhandled', 'Снять проклятие может только торговец — а его здесь нет.')] };
  const slots = ['weapon', 'armor'].filter(s => isCursed(hero?.equipment?.[s]));
  if (!slots.length) {
    return { ok: false, events: [mev('system', 'На тебе нет проклятых вещей. Торговец разочарован: он уже считал прибыль.')] };
  }
  const price = cursePrice(state, hero);
  if (hero.gold < price) {
    return {
      ok: false,
      events: [mev('system', `Снять проклятие стоит ${price} золота, а у ${hero.name} только ${hero.gold}. Торговец сочувствует, но платно.`)]
    };
  }
  hero.gold -= price;
  const names = slots.map(s => {
    const it = hero.equipment[s];
    const name = it.name;
    uncurseItem(it);
    return name;
  });
  return {
    ok: true,
    events: [mev('loot', `${m.name} бормочет что-то дорогое и снимает проклятие с ${names.join(', ')}. −${price} золота (осталось ${hero.gold}). Вещь больше не держит.`)]
  };
}
