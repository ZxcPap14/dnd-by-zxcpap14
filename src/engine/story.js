// story.js — журнал задач, память ИИ-ДМа, сюжетные строки и имена злодеев.
// Всё это чистые функции над state: ни карты, ни боя они не касаются.

/** Ключ задачи для сравнения: без кавычек, лишних пробелов, регистра и точки. */
function questKey(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[«»"'.,!?:;()]/g, '')
    .trim()
    .toLowerCase();
}

const QUEST_NOISE = new Set(['что', 'чтобы', 'этот', 'этом', 'этой', 'какой', 'когда', 'надо', 'нужно', 'найти', 'найди', 'затем']);

export function questWords(text) {
  return questKey(text).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !QUEST_NOISE.has(w));
}

/** Слова считаются теми же при совпадении первых 3 букв: «дань» ≈ «данщик», «кузнеца» ≈ «кузнец». */
function sameWord(a, b) {
  // shortcut: 3 буквы дают редкие ложные склейки («соль»/«солнце») — ок для
  // журнала из 3-6 строк; если задач станет много, поднять до 4 и словарь стемов.
  return a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 3) === b.slice(0, 3));
}

/** Добавить задачу в журнал. Возвращает текст, если добавлена, иначе null (дубль). */
/** Как называть уровни в этом мире: «этаж» в киберпанк-городе звучит как подземелье. */
const VILLAINS_KEY = 'dnd-villains-v1';
let villainMemory = [];

/** Имена прошлых злодеев: модель любит выдавать один и тот же мотив, игрок это видит. */
export function loadVillains() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(VILLAINS_KEY);
      return raw ? JSON.parse(raw).slice(-10) : [];
    }
  } catch { /* испорченное хранилище — не повод падать */ }
  return villainMemory.slice(-10);
}

export function rememberVillain(name) {
  const s = String(name || '').trim().slice(0, 60);
  if (!s) return;
  const list = loadVillains().filter(n => n.toLowerCase() !== s.toLowerCase());
  list.push(s);
  const keep = list.slice(-10);
  villainMemory = keep;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VILLAINS_KEY, JSON.stringify(keep));
  } catch { /* нет места в хранилище — переживём */ }
}

export function floorLabel(worldDesc, depth) {
  const w = String(worldDesc || '').toLowerCase();
  const word = /кибер|неон|город|косм|звезд|корабл|станц/.test(w) ? 'Сектор' : 'Этаж';
  return `${word} ${depth}`;
}

export function addQuest(state, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const key = questKey(clean);
  if (state.quests.some(q => questKey(q) === key)) return null;
  state.quests.push(clean);
  // штамп «когда задача последний раз двигалась» — для авто-снятия зависших
  if (!state.questAges) state.questAges = {};
  state.questAges[clean] = state.turn;
  return clean;
}

/**
 * Закрыть задачу по формулировке ДМа — не дословной: «кузнец Гарм спасён»
 * закрывает «Найти кузнеца Гарма». Возвращает текст закрытой задачи или null.
 */
export function completeQuest(state, text) {
  const want = questWords(text);
  if (!want.length) return null;
  let best = null;
  let bestScore = 0;
  for (const q of state.quests) {
    const words = questWords(q);
    if (!words.length) continue;
    const hit = words.filter(w => want.some(x => sameWord(w, x))).length;
    // Сравниваем с более коротким списком: игрок может закрыть задачу одной
    // точной фразой («данщик известен»), а не пересказом всей формулировки.
    const score = hit / Math.min(words.length, want.length);
    // 2/3 слов задачи уже достаточно: ДМ пересказывает итог своими словами
    if (score >= 0.5 && score > bestScore) { best = q; bestScore = score; }
  }
  if (!best) return null;
  state.quests = state.quests.filter(q => q !== best);
  if (state.questAges) delete state.questAges[best];
  return best;
}

// ---------- память ДМа ----------

const MEMORY_CAP = 30;      // сколько последних событий помнит ДМ
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

/** Сюжетная строка для контекста ИИ. */
export function storyDigest(state) {
  const s = state.story;
  if (!s) return '';
  return `АКТ ${s.act}/${s.acts}, этаж ${state.depth} из ${s.floors}, злодей: ${storyVillain(state)} (${storyGoal(state)}), босс: ${s.bossSpawned ? 'УЖЕ ЖДЁТ' : 'впереди'}.`;
}
