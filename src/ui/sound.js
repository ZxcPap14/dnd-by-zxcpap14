// sound.js — синтезированные звуки через WebAudio. Никаких файлов, только математика.

let ctx = null;

export function initAudio() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

function tone(freq, dur, type = 'square', gain = 0.03, when = 0, slideTo = null) {
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Блип печати терминала. */
export function blip(freq = 700 + Math.random() * 300) {
  tone(freq, 0.02, 'square', 0.012);
}

/** Барабанная дробь перед броском + результат. */
export function rollSound(crit = false) {
  for (let i = 0; i < 6; i++) tone(200 + i * 40, 0.03, 'square', 0.02, i * 0.05);
  tone(crit ? 880 : 440, crit ? 0.25 : 0.12, 'triangle', 0.05, 0.32);
  if (crit) tone(1320, 0.3, 'triangle', 0.04, 0.4);
}

/** Глухой удар при уроне. */
export function hitSound() {
  tone(160, 0.15, 'sawtooth', 0.06, 0, 60);
}

/** Звук подбора лута. */
export function lootSound() {
  tone(660, 0.06, 'square', 0.03);
  tone(880, 0.08, 'square', 0.03, 0.06);
}

/** Повышение уровня — арпеджио. */
export function levelUpSound() {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, 'triangle', 0.05, i * 0.09));
}

/** Смерть — нисходящий стон. */
export function deathSound() {
  tone(300, 0.9, 'sawtooth', 0.07, 0, 55);
}
