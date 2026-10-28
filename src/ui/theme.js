// theme.js — визуальный слой: темы, настройки вида, CRT-эффекты, анимации, матрица.
// DOM-часть; чистая логика аватаров живёт в avatar.js.

import { setVolume, setMuted } from './sound.js';

const VIS_KEY = 'dnd_vis';

export const THEMES = ['amber', 'phosphor', 'ice', 'blood'];
export const TERMINATOR_AFTER = 10; // смертей в зале славы для секретной темы

export function loadVis() {
  const defaults = { theme: 'amber', glyphs: 'classic', flicker: false, volume: 60, muted: false };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(VIS_KEY) || '{}') }; }
  catch { return defaults; }
}

export function saveVis(vis) {
  try { localStorage.setItem(VIS_KEY, JSON.stringify(vis)); } catch { /*ignore*/ }
}

/** Применить визуальные настройки к документу и звуку. */
export function applyVis(vis) {
  document.body.dataset.theme = vis.theme === 'terminator' ? 'terminator' : (THEMES.includes(vis.theme) ? vis.theme : 'amber');
  document.body.classList.toggle('flicker', !!vis.flicker);
  setVolume(vis.volume / 100);
  setMuted(!!vis.muted);
}

/** Сколько смертей в зале славы (для разблокировки «терминатора»). */
export function deathCount() {
  try { return JSON.parse(localStorage.getItem('dnd_hof') || '[]').length; }
  catch { return 0; }
}

// ---------- эффекты ----------

/** Тряска экрана (урон). */
export function shakeScreen() {
  document.body.classList.remove('shake');
  void document.body.offsetWidth; // restart animation
  document.body.classList.add('shake');
}

/** Красная вспышка по краям (урон). */
export function redFlash() {
  const f = document.getElementById('flash');
  if (!f) return;
  f.classList.remove('active');
  void f.offsetWidth;
  f.classList.add('active');
}

const DICE_FRAMES = 8;
const DICE_FRAME_MS = 70;
const DICE_HOLD_MS = 650;

/** ASCII-кубик d20: крутится и падает на результат. */
export function showDiceRoll(final) {
  const box = document.getElementById('dice');
  const art = document.getElementById('dice-art');
  if (!box || !art) return;
  if (box.dataset.busy) return;
  box.dataset.busy = '1';
  box.classList.add('active');

  const frame = (n, done) => {
    const num = String(n).padStart(2, ' ');
    art.textContent =
      ` ╔═══════════╗\n` +
      ` ║           ║\n` +
      ` ║   ${num} ${done ? '◆' : '·'}   ║\n` +
      ` ║           ║\n` +
      ` ╚═══════════╝`;
  };

  let i = 0;
  const iv = setInterval(() => {
    i++;
    if (i <= DICE_FRAMES) frame(1 + Math.floor(Math.random() * 20), false);
    else {
      clearInterval(iv);
      frame(final, true);
      setTimeout(() => { box.classList.remove('active'); delete box.dataset.busy; }, DICE_HOLD_MS);
    }
  }, DICE_FRAME_MS);
}

/** Глитч-распад перед экраном смерти. Возвращает Promise. */
export function deathGlitch() {
  return new Promise(res => {
    document.body.classList.add('glitch');
    setTimeout(() => {
      document.body.classList.remove('glitch');
      res();
    }, 1000);
  });
}

/** CRT-включение при загрузке страницы: линия развёртки → интерфейс. */
export function bootCRT() {
  const el = document.getElementById('crt-boot');
  if (!el) return;
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 1600);
}

// ---------- матричный дождь (стартовый экран) ----------

let matrixRunning = false;

/** Запустить дождь в фоне стартового экрана (рисует только пока setup активен). */
export function startMatrix() {
  const canvas = document.getElementById('matrix');
  if (!canvas || matrixRunning) return;
  matrixRunning = true;
  const ctx2d = canvas.getContext('2d');
  const CHARS = 'アカサタナハマヤラワ0123456789+*<>|/\\#$@%';
  let drops = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const cols = Math.floor(canvas.width / 16);
    drops = Array.from({ length: cols }, () => Math.floor(Math.random() * canvas.height / 16));
  }
  window.addEventListener('resize', resize);
  resize();

  function themeColor() {
    return getComputedStyle(document.body).getPropertyValue('--main').trim() || '#ffb000';
  }

  let last = 0;
  function loop(ts) {
    if (!matrixRunning) return;
    requestAnimationFrame(loop);
    if (ts - last < 66) return; // ~15 fps
    last = ts;
    const setupActive = document.getElementById('screen-setup')?.classList.contains('active');
    if (!setupActive) { if (canvas.dataset.dirty) { ctx2d.clearRect(0, 0, canvas.width, canvas.height); canvas.dataset.dirty = ''; } return; }
    canvas.dataset.dirty = '1';
    ctx2d.fillStyle = 'rgba(0,0,0,0.14)';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = themeColor();
    ctx2d.font = '14px monospace';
    ctx2d.globalAlpha = 0.5;
    for (let i = 0; i < drops.length; i++) {
      const ch = CHARS[Math.floor(Math.random() * CHARS.length)];
      ctx2d.fillText(ch, i * 16, drops[i] * 16);
      if (drops[i] * 16 > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
    ctx2d.globalAlpha = 1;
  }
  requestAnimationFrame(loop);
}

export function stopMatrix() { matrixRunning = false; }

// ---------- кинематографичное вступление (скролл Star Wars) ----------

/** Показать вступление: строки ползут снизу вверх. skipFn — по кнопке или автоматически. */
export function showIntro(lines) {
  const wrap = document.getElementById('intro');
  const text = document.getElementById('intro-text');
  if (!wrap || !text) return;
  text.textContent = lines.join('\n\n');
  wrap.classList.add('active');
  // перезапуск анимации скролла
  const scroll = document.getElementById('intro-scroll');
  scroll.style.animation = 'none';
  void scroll.offsetWidth;
  scroll.style.animation = '';
  const hide = () => wrap.classList.remove('active');
  scroll.onanimationend = hide;
  document.getElementById('btn-skip-intro').onclick = hide;
}
