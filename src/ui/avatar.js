// avatar.js — портреты героев.
// Раньше здесь было превращение фото в ASCII: на снимках оно давало кашу,
// поэтому оставлен простой и предсказуемый набор готовых аватарок + портрет
// из ника для тех, кто ничего не выбрал.

/** xfnv1a: одинаковый ник — одинаковый портрет на всех машинах. */
export function nameHash(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || '').trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = [' ', ' ', ' ', '.', ':', '~', '=', '+', "'", '^', 'o', '▒', '▓', '█'];
const AVATAR_W = 8;
const AVATAR_H = 5;

/** Портрет из ника: симметричный, детерминированный. */
export function asciiAvatar(name) {
  // портрет от ника не зависит от регистра и лишних пробелов
  const rnd = mulberry32(nameHash(String(name || '').trim().toLowerCase()));
  const rows = [];
  for (let y = 0; y < AVATAR_H; y++) {
    let left = '';
    for (let x = 0; x < AVATAR_W / 2; x++) {
      const r = rnd();
      left += CHARS[Math.min(CHARS.length - 1, Math.floor(r * CHARS.length))];
    }
    rows.push(left + [...left].reverse().join(''));
  }
  return rows.join('\n');
}

/**
 * Готовые аватарки: 12 колонок, 6 строк. Ровные по ширине — иначе pre «плывёт».
 */
export const AVATARS = [
  { id: 'knight', name: 'Рыцарь', art: [
    '   ______   ',
    '  /______\\  ',
    '  | o  o |  ',
    '  |  __  |  ',
    '  |______|  ',
    '   /|  |\\   ',
  ] },
  { id: 'mage', name: 'Маг', art: [
    '    /\\      ',
    '   /  \\     ',
    '  /____\\    ',
    '  | o  o|   ',
    '  | ====|   ',
    '   \\____/   ',
  ] },
  { id: 'rogue', name: 'Плут', art: [
    '   _____    ',
    '  /_____\\   ',
    ' | >  < |   ',
    ' |  __  |   ',
    '  \\____/    ',
    '   /||\\     ',
  ] },
  { id: 'skull', name: 'Скелет', art: [
    '   _____    ',
    '  /     \\   ',
    ' | o   o |  ',
    ' |   ^   |  ',
    '  \\_|||_/   ',
    '   ||||     ',
  ] },
  { id: 'orc', name: 'Орк', art: [
    '  /\\___/\\   ',
    ' |  o o  |  ',
    ' | >   < |  ',
    ' |  ___  |  ',
    '  \\/   \\/   ',
    '  /|   |\\   ',
  ] },
  { id: 'elf', name: 'Эльф', art: [
    '   /\\  /\\   ',
    '  /  \\/  \\  ',
    ' |  o  o  | ',
    ' |   __   | ',
    '  \\  \\/  /  ',
    '   \\____/   ',
  ] },
  { id: 'dwarf', name: 'Гном', art: [
    '   _____    ',
    '  /_____\\   ',
    ' | o   o |  ',
    ' |#######|  ',
    '  \\#####/   ',
    '   |||||    ',
  ] },
  { id: 'priest', name: 'Жрица', art: [
    '    _+_     ',
    '   / | \\    ',
    '  |  o  |   ',
    '  |     |   ',
    '  | === |   ',
    '   \\___/    ',
  ] },
  { id: 'bard', name: 'Бард', art: [
    '   _____    ',
    '  /     \\   ',
    ' | o   o |  ',
    ' |  ~~~  |  ',
    '  \\_____/   ',
    '   /| |\\    ',
  ] },
  { id: 'necro', name: 'Некромант', art: [
    '   .---.    ',
    '  /#####\\   ',
    ' | x   x |  ',
    ' |  ___  |  ',
    '  \\#####/   ',
    '   \\|||/    ',
  ] },
  { id: 'robot', name: 'Робот', art: [
    '  +------+  ',
    '  |[]  []|  ',
    '  |  __  |  ',
    '  |______|  ',
    '   |    |   ',
    '  /|    |\\  ',
  ] },
  { id: 'cat', name: 'Кот', art: [
    '  /\\    /\\  ',
    ' |  \\__/  | ',
    ' | o    o | ',
    ' |   ..   | ',
    '  \\  --  /  ',
    '   \\____/   ',
  ] },
  { id: 'wolf', name: 'Волк', art: [
    '  _/\\__/\\_  ',
    ' |  o  o  | ',
    ' |   __   | ',
    '  \\  \\/  /  ',
    '   \\____/   ',
    '  /|    |\\  ',
  ] },
  { id: 'dragon', name: 'Дракон', art: [
    '  /\\/\\/\\/\\  ',
    ' |  o  o  | ',
    ' |  ____  | ',
    '  \\  \\/  /  ',
    '   \\____/   ',
    '  //    \\\\  ',
  ] },
  { id: 'vampire', name: 'Вампир', art: [
    '   _____    ',
    '  /     \\   ',
    ' | o   o |  ',
    ' |  \\/   |  ',
    '  \\_|||_/   ',
    '   /| |\\    ',
  ] },
  { id: 'pirate', name: 'Пират', art: [
    '   _____    ',
    '  /     \\   ',
    ' | o  -- |  ',
    ' |  ____ |  ',
    '  \\_____/   ',
    '   /|||\\    ',
  ] },
  { id: 'samurai', name: 'Самурай', art: [
    '  ________  ',
    ' /________\\ ',
    ' |  o  o  | ',
    ' |  ____  | ',
    ' |__|__|__| ',
    '   /|  |\\   ',
  ] },
  { id: 'monk', name: 'Монах', art: [
    '    ___     ',
    '   /___\\    ',
    '  | o o |   ',
    '  |_____|   ',
    '  | === |   ',
    '   \\___/    ',
  ] },
  { id: 'alchemist', name: 'Алхимик', art: [
    '   (   )    ',
    '    \\_/     ',
    '  /_____\\   ',
    ' | o   o |  ',
    ' |  ~~~  |  ',
    '  \\_____/   ',
  ] },
  { id: 'demon', name: 'Демон', art: [
    ' \\/      \\/ ',
    '  \\ ,--. /  ',
    '  | o  o |  ',
    '  |  __  |  ',
    '   \\____/   ',
    '   //  \\\\   ',
  ] },
];

const PICK_KEY = 'dnd-avatar-pick-v1';
let pickMemory = ''; // в node (тесты) localStorage нет

export function loadPickedAvatar() {
  try {
    const id = typeof localStorage !== 'undefined' ? localStorage.getItem(PICK_KEY) : pickMemory;
    return AVATARS.some(a => a.id === id) ? id : '';
  } catch { return pickMemory; }
}

export function savePickedAvatar(id) {
  const clean = AVATARS.some(a => a.id === id) ? id : '';
  try {
    if (typeof localStorage !== 'undefined') {
      if (clean) localStorage.setItem(PICK_KEY, clean); else localStorage.removeItem(PICK_KEY);
    } else pickMemory = clean;
  } catch { pickMemory = clean; }
  return clean;
}

export function avatarArt(id) {
  const found = AVATARS.find(a => a.id === id);
  return found ? found.art.join('\n') : '';
}

/** Выбранная аватарка, иначе портрет из ника. */
export function heroAvatar(name) {
  return avatarArt(loadPickedAvatar()) || asciiAvatar(name);
}
