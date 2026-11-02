// portrait.js — визуальные хелперы: аватарка в панели и подгонка ASCII-арта.
// Раньше жили в app.js, но состоянию партии не нужны — только DOM.

import { heroAvatar } from './avatar.js';

function paintPortrait(name) {
  const el = document.getElementById('hero-portrait');
  if (!el) return;
  const art = heroAvatar(String(name || 'Безымянный'));
  el.textContent = art;
  // Рисуем крупно (18px) и ужимаем блок через zoom: при мелком кегле браузер
  // рвёт строки в полосы, а так глиф остаётся целым и плотность видна.
  el.style.fontSize = '18px';
  el.style.zoom = '1';
  const panel = el.parentElement;
  const w = (panel ? panel.clientWidth : 560) - 20;
  if (w > 40) el.style.zoom = Math.min(1, w / (el.scrollWidth || 1)).toFixed(3);
}

function fitPre(el, availPx, minPx, maxPx) {
  if (!el) return;
  const prev = parseFloat(getComputedStyle(el).fontSize) || 10;
  el.style.display = 'inline-block'; // shrink-to-fit → честная ширина контента
  const w = el.getBoundingClientRect().width;
  el.style.display = '';
  if (!w) return;
  el.style.fontSize = Math.max(minPx, Math.min(maxPx, prev * (availPx / w))) + 'px';
}

function fitArt() {
  const box = document.querySelector('.setup-box');
  if (!box) return;
  const avail = box.clientWidth - 56;
  fitPre(document.getElementById('logo'), avail, 6, 20);
  fitPre(document.getElementById('logo-sub'), avail, 3, 8);
}

export { paintPortrait, fitArt };
