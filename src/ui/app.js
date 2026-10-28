// app.js — склейка всего: экраны, игровой цикл, ввод, смерть, зал славы, экспорт.

import { newGame, parseCommand, applyIntent, applyDmEffects, visibleMonsters } from '../engine/game.js';
import { createClient, extractJson } from '../ai/client.js';
import { buildContext, introMessages, classMessages } from '../ai/dm.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';
import { createTyper, renderMap, renderStats, renderQuests } from './terminal.js';
import { initAudio, rollSound, hitSound, lootSound, levelUpSound, deathSound, blip } from './sound.js';

const $ = (id) => document.getElementById(id);

const STUB_CLASSES = [
  { name: 'Плут', desc: 'Кривые руки, быстрые ноги', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } },
  { name: 'Воин', desc: 'Стена мяса с мечом', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } },
  { name: 'Волхв', desc: 'Магия и высокомерие', stats: { str: 8, dex: 10, int: 16, con: 12, cha: 14, luck: 12 } }
];

let cfg = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' };
let client = null;
let state = null;
let typer = null;
let chronicle = [];
let inputHistory = [];
let historyIdx = -1;
let busy = false;

// ---------- хранилище ----------

function loadCfg() {
  try {
    const raw = localStorage.getItem('dnd_cfg');
    if (raw) cfg = { ...cfg, ...JSON.parse(raw) };
  } catch { /*ignore*/ }
  $('set-base').value = cfg.baseUrl;
  $('set-key').value = cfg.apiKey;
  $('set-model').value = cfg.model;
}
function saveCfg() {
  cfg = {
    baseUrl: $('set-base').value.trim() || 'https://api.openai.com/v1',
    apiKey: $('set-key').value.trim(),
    model: $('set-model').value.trim() || 'gpt-4o-mini'
  };
  localStorage.setItem('dnd_cfg', JSON.stringify(cfg));
}

function loadHof() {
  try { return JSON.parse(localStorage.getItem('dnd_hof') || '[]'); } catch { return []; }
}
function saveHofEntry(entry) {
  const hof = loadHof();
  hof.unshift(entry);
  localStorage.setItem('dnd_hof', JSON.stringify(hof.slice(0, 20)));
}
function renderHof() {
  const hof = loadHof();
  $('hof-list').innerHTML = hof.length
    ? hof.slice(0, 10).map(h =>
      `<div class="hof-row"><span class="hof-name">${esc(h.name)}</span> <span class="hof-meta">${esc(h.className)} · ${esc(h.world)} · этаж ${h.depth}</span><span class="hof-epitaph">「${esc(h.epitaph)}」</span></div>`
    ).join('')
    : '<div class="hof-row hof-empty">Зал пуст. Пока что.</div>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- экраны ----------

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

function currentClient() {
  saveCfg();
  if (cfg.apiKey && cfg.baseUrl && cfg.model) {
    client = createClient({ ...cfg });
    return client;
  }
  client = null;
  return null;
}

async function renderClassList() {
  const world = $('set-world').value.trim() || 'Классическое тёмное фэнтези';
  const list = $('class-list');
  list.innerHTML = '<div class="class-loading">Придумываем классы…</div>';
  let classes = STUB_CLASSES;
  const c = currentClient();
  if (c) {
    try {
      const raw = await c.chat(classMessages(world), { maxTokens: 300 });
      const data = extractJson(raw);
      if (data?.classes?.length) classes = data.classes.slice(0, 4);
    } catch (e) {
      addSetupNote(`ИИ недоступен (${e.message}) — берём стандартные классы`);
    }
  }
  list.innerHTML = classes.map((cl, i) => `
    <label class="class-card">
      <input type="radio" name="class" value="${i}" ${i === 0 ? 'checked' : ''}>
      <span class="class-name">${esc(cl.name)}</span>
      <span class="class-desc">${esc(cl.desc || '')}</span>
    </label>`).join('');
  list.dataset.payload = JSON.stringify(classes);
}

function addSetupNote(text) {
  const n = $('setup-note');
  n.textContent = text;
  n.style.display = 'block';
}

// ---------- игра ----------

function startGame() {
  saveCfg();
  initAudio();
  const c = currentClient();
  const world = $('set-world').value.trim() || 'Классическое тёмное фэнтези';
  const mode = $('set-mode').value;
  const name = $('set-name').value.trim() || 'Безымянный';
  let classes = STUB_CLASSES;
  try { classes = JSON.parse($('class-list').dataset.payload || 'null') || STUB_CLASSES; } catch { /*ignore*/ }
  const cls = classes[Number(document.querySelector('input[name="class"]:checked')?.value || 0)] || STUB_CLASSES[0];

  resetStub();
  state = newGame({ seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0, mode, worldDesc: world, className: cls.name, name, stats: cls.stats });
  chronicle = [`МИР: ${world}`, `РЕЖИМ: ${mode === 'sandbox' ? 'песочница' : 'сюжет'}`, `ГЕРОЙ: ${name}, ${cls.name}`];
  typer = createTyper($('log'));
  showScreen('screen-game');
  refreshPanels();

  // вступление от ДМа
  if (c) {
    c.chat(introMessages(state), { maxTokens: 500 })
      .then(raw => {
        const eff = extractJson(raw);
        handleEvents(applyDmEffects(state, eff || { narrative: raw.slice(0, 600) }));
      })
      .catch(e => handleEvents(applyDmEffects(state, { narrative: `ДМ не отвечает (${e.message}), поэтому придётся импровизировать. Ты очнулся в темноте. Как обычно.` })));
  } else {
    handleEvents(applyDmEffects(state, stubDmTurn(state, 'начало')));
    handleEvents(applyDmEffects(state, { narrative: 'Режим без ИИ: заглушка-ДМ издевается по шаблонам. Введи ключ в настройках, чтобы разбудить настоящего тролля.' }));
  }
  $('input').focus();
}

function refreshPanels() {
  renderMap($('map'), state);
  renderStats($('stats'), state);
  renderQuests($('quest-list'), state);
  $('floor-label').textContent = state.floorName;
}

function logEvent(kind, text) {
  chronicle.push(`[${kind}] ${text}`);
  typer.add(kind, text);
  switch (kind) {
    case 'roll': rollSound(text.includes('КРИТ')); break;
    case 'combat': hitSound(); break;
    case 'loot': lootSound(); break;
    case 'death': deathSound(); break;
    case 'levelup': levelUpSound(); break;
    default: break;
  }
}

function handleEvents(events) {
  for (const e of events) {
    if (e.kind === 'dm' && e.text.startsWith('__FREE__')) {
      const freeText = e.text.slice('__FREE__'.length);
      processFree(freeText);
      continue;
    }
    if (e.kind === 'loot' && /УРОВЕНЬ/.test(e.text)) levelUpSound();
    logEvent(e.kind, e.text);
  }
  refreshPanels();
  if (state.over) {
    typer.onFinish(showDeath);
  }
}

async function processFree(text) {
  logEvent('system', `… мир обдумывает «${text}» …`);
  if (client) {
    try {
      const msgs = buildContext(state, text);
      const raw = await client.chat(msgs, { maxTokens: 600 });
      const eff = extractJson(raw);
      if (eff) {
        handleEvents(applyDmEffects(state, eff));
      } else {
        // модель ответила болтовнёй — покажем как нарратив, без эффектов
        handleEvents(applyDmEffects(state, { narrative: raw.slice(0, 800) }));
      }
      return;
    } catch (e) {
      logEvent('system', `ИИ замолк: ${e.message}. Переходим на заглушку.`);
    }
  }
  handleEvents(applyDmEffects(state, stubDmTurn(state, text)));
}

function submitInput() {
  if (!state || state.over || busy) return;
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  inputHistory.push(text);
  historyIdx = inputHistory.length;
  blip(520);
  logEvent('player', `> ${text}`);
  const intent = parseCommand(text);
  busy = true;
  try {
    handleEvents(applyIntent(state, intent));
  } finally {
    busy = false;
  }
}

// ---------- смерть ----------

function showDeath() {
  saveHofEntry({
    name: state.player.name,
    className: state.player.className,
    world: state.worldDesc,
    depth: state.depth,
    epitaph: state.epitaph || 'умер от жизни',
    date: new Date().toLocaleDateString('ru-RU')
  });
  $('death-epitaph').textContent = state.epitaph || '';
  $('death-stats').textContent = `${state.player.name}, ${state.player.className}, ур.${state.player.level}. Дошёл до этажа ${state.depth}. Ходов: ${state.turn}.`;
  $('screen-death').classList.add('active');
}

function exportChronicle() {
  const header = [
    '═'.repeat(60),
    '  dnd by ZxcPap14 — хроника забега',
    `  ${new Date().toLocaleString('ru-RU')}`,
    ...chronicle.slice(0, 3),
    '═'.repeat(60),
    ''
  ].join('\n');
  const body = chronicle.slice(3).map(l => l).join('\n');
  const blob = new Blob([header + body + '\n\n' + '═'.repeat(60) + `\n${state?.epitaph ? 'ЭПИТАФИЯ: ' + state.epitaph : ''}\n`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dnd-chronicle-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- инициализация ----------

function wire() {
  loadCfg();
  renderHof();

  $('btn-classes').addEventListener('click', renderClassList);
  $('btn-start').addEventListener('click', startGame);
  $('btn-export').addEventListener('click', exportChronicle);
  $('btn-restart').addEventListener('click', () => {
    $('screen-death').classList.remove('active');
    showScreen('screen-setup');
    renderHof();
  });
  $('log').addEventListener('click', () => { typer && typer.skipAll(); });

  const input = $('input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitInput();
    else if (e.key === 'ArrowUp' && historyIdx > 0) { historyIdx--; input.value = inputHistory[historyIdx]; }
    else if (e.key === 'ArrowDown') {
      if (historyIdx < inputHistory.length - 1) { historyIdx++; input.value = inputHistory[historyIdx]; }
      else { historyIdx = inputHistory.length; input.value = ''; }
    }
  });

  renderClassList();
  showScreen('screen-setup');
}

wire();
