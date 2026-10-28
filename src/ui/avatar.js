// avatar.js — детерминированные ASCII-портреты из хэша ника.
// Чистый модуль без DOM — тестируется в node.

/** xfnv1a-хэш строки → uint32. Один ник = один портрет на всех устройствах. */
export function nameHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — маленький seeded PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = [' ', ' ', ' ', '.', ':', '~', '=', '+', "'", '^', 'o', '▒', '▓', '█'];
const AVATAR_W = 8;
const AVATAR_H = 5;

/**
 * ASCII-портрет (AVATAR_H строк × AVATAR_W колонок), зеркально-симметричный.
 * Один и тот же ник всегда даёт один и тот же портрет.
 */
export function asciiAvatar(name) {
  const rnd = mulberry32(nameHash(String(name ?? '').toLowerCase().trim()));
  const rows = [];
  for (let y = 0; y < AVATAR_H; y++) {
    const left = [];
    for (let x = 0; x < AVATAR_W / 2; x++) {
      left.push(CHARS[Math.floor(rnd() * CHARS.length)]);
    }
    rows.push(left.join('') + left.slice().reverse().join(''));
  }
  return rows.join('\n');
}
