// app.js — склейка всего: экраны, игровой цикл, ввод, кооп (хост/клиент), смерть, зал славы, экспорт.

import { newGame, parseCommand, applyIntent, applyDmEffects, engagedEnemies } from '../engine/game.js';
import { createClient, extractJson } from '../ai/client.js';
import { buildContext, introMessages, classMessages } from '../ai/dm.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { makeRoomCode } from '../net/loopback.js';
import { createPeerHostNet, createPeerClientLink } from '../net/peer.js';
import { PROTOCOL_VER } from '../net/protocol.js';
import {
  createTyper, renderStats, renderQuests,
  renderStatsSnap, renderCombat, GLYPH_SETS
} from './terminal.js';
import {
  initAudio, rollSound, hitSound, lootSound, levelUpSound,
  deathSound, blip, turnSound, coffeeSound
} from './sound.js';
import { asciiAvatar } from './avatar.js';
import {
  loadVis, saveVis, applyVis, deathCount, THEMES, TERMINATOR_AFTER,
  shakeScreen, redFlash, showDiceRoll, deathGlitch, bootCRT,
  startMatrix, showIntro
} from './theme.js';

const $ = (id) => document.getElementById(id);

const STUB_CLASSES = [
  { name: 'Плут', desc: 'Кривые руки, быстрые ноги', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } },
  { name: 'Воин', desc: 'Стена мяса с мечом', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } },
  { name: 'Волхв', desc: 'Магия и высокомерие', stats: { str: 8, dex: 10, int: 16, con: 12, cha: 14, luck: 12 } }
];

let cfg = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' };
let vis = loadVis();        // визуальные настройки (тема, глифы, звук)
let client = null;          // AI-клиент (хост/соло)
let state = null;           // соло-состояние
let typer = null;
let chronicle = [];
let inputHistory = [];
let historyIdx = -1;
let wasMyTurn = false;      // для звукового сигнала хода в коопе

let sessionMode = 'solo';   // 'solo' | 'host' | 'client'
let hostSession = null;
let clientSession = null;
let mySnapshot = null;
let roomCode = null;

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
  if (typeof refreshThemeOptions === 'function') refreshThemeOptions();
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
      const raw = await c.chat(classMessages(world), { maxTokens: 1500, jsonMode: true });
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

function readCommonConfig() {
  return {
    world: $('set-world').value.trim() || 'Классическое тёмное фэнтези',
    mode: $('set-mode').value,
    name: $('set-name').value.trim() || 'Безымянный'
  };
}

function selectedClasses() {
  try { return JSON.parse($('class-list').dataset.payload || 'null') || STUB_CLASSES; }
  catch { return STUB_CLASSES; }
}

/** Асинхронный ДМ: ИИ хоста или заглушка. */
function makeDmResolver() {
  return {
    resolveFree: async (game, text, heroIdx = null) => {
      if (client) {
        try {
          const raw = await client.chat(buildContext(game, text, heroIdx ?? game.activeIdx), { maxTokens: 2000, jsonMode: true });
          const eff = extractJson(raw);
          return eff || { narrative: raw.slice(0, 800) };
        } catch (e) {
          return { narrative: `ИИ замолк (${e.message}), поэтому придётся импровизировать.` };
        }
      }
      return stubDmTurn(game, text);
    }
  };
}

// ---------- СОЛО ----------

function startSolo() {
  saveCfg();
  initAudio();
  currentClient();
  const { world, mode, name } = readCommonConfig();
  const classes = selectedClasses();
  const cls = classes[Number(document.querySelector('input[name="class"]:checked')?.value || 0)] || STUB_CLASSES[0];

  resetStub();
  sessionMode = 'solo';
  state = newGame({
    seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
    mode, worldDesc: world,
    players: [{ name, className: cls.name, stats: cls.stats }]
  });
  chronicle = [`МИР: ${world}`, `РЕЖИМ: ${mode === 'sandbox' ? 'песочница' : 'сюжет'}`, `ГЕРОЙ: ${name}, ${cls.name}`];
  typer = createTyper($('log'));
  showScreen('screen-game');
  refreshPanelsSolo();
  $('turn-banner').textContent = 'СОЛО · твой ход всегда';
  wasMyTurn = true;
  showIntro([world.toUpperCase(), `РЕЖИМ: ${mode === 'sandbox' ? 'ПЕСОЧНИЦА' : 'СЮЖЕТ'}`, `ЭПИЗОД I — ${name}, ${cls.name}`, 'ДАЛЕЕ: ТЬМА, ТРОЛЛИНГ И ПЕРМАСМЕРТЬ']);

  if (client) {
    client.chat(introMessages(state), { maxTokens: 2000, jsonMode: true })
      .then(raw => {
        const eff = extractJson(raw);
        handleEventsSolo(applyDmEffects(state, eff || { narrative: raw.slice(0, 600) }));
      })
      .catch(e => handleEventsSolo(applyDmEffects(state, { narrative: `ДМ не отвечает (${e.message}), поэтому придётся импровизировать. Ты очнулся в темноте. Как обычно.` })));
  } else {
    handleEventsSolo(applyDmEffects(state, stubDmTurn(state, 'начало')));
    handleEventsSolo(applyDmEffects(state, { narrative: 'Режим без ИИ: заглушка-ДМ издевается по шаблонам. Введи ключ в настройках, чтобы разбудить настоящего тролля.' }));
  }
  $('input').focus();
}

function refreshPanelsSolo() {
  renderStats($('stats'), state);
  renderQuests($('quest-list'), state);
  renderCombat($('combat-panel'), engagedEnemies(state, state.activeIdx));
  $('floor-label').textContent = state.floorName
    + (state.story && !state.over ? ` · ⚜ АКТ ${state.story.act}/${state.story.acts}: ${state.story.villain || state.story.fallbackVillain?.villain || '???'}` : '');
}

/**
 * Автоподгонка ASCII-арта: измеряем реальную ширину содержимого при базовом
 * размере и масштабируем шрифт так, чтобы арт занимал всю ширину, но влезал.
 */
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
  fitPre($('logo'), avail, 6, 20);
  fitPre($('logo-sub'), avail, 3, 8);
}

/** Классификация события для расширенной палитры хроники. */
function classify(kind, text) {
  if (kind === 'death') return 'danger';
  if (kind === 'dm') {
    if (/(маги|заклин|касту|чар|проклят|рун)/i.test(text)) return 'magic';
    if (/["«]/.test(text)) return 'npc';
  }
  return kind;
}

function logEvent(kind, text) {
  if (kind === 'suggest') return; // подсказки рендерятся чипами, не в хронике
  chronicle.push(`[${kind}] ${text}`);
  typer.add(classify(kind, text), text);  switch (kind) {
    case 'roll': {
      rollSound(text.includes('КРИТ'));
      const m = text.match(/d20\D*(\d+)/) || text.match(/(\d+)\s*$/);
      if (m) showDiceRoll(Number(m[1]));
      break;
    }
    case 'combat':
      hitSound();
      shakeScreen();
      redFlash();
      break;
    case 'loot': lootSound(); break;
    case 'death': deathSound(); shakeScreen(); break;
    default: break;
  }
}

// подсказки ДМа: событие kind 'suggest' (JSON-массив) → кликабельные чипы над вводом.
// Клик = сразу отправить действие. Новая пачка событий без подсказок их стирает.
function showSuggestions(events) {
  const row = $('suggest-row');
  if (!row) return;
  row.innerHTML = '';
  row.style.display = 'none';
  if (!typer || (state && state.over)) return;
  const ev = (events || []).find(e => e.kind === 'suggest');
  if (!ev) return;
  let list = [];
  try { list = JSON.parse(ev.text); } catch { return; }
  if (!Array.isArray(list)) return;
  list.map(s => String(s).trim()).filter(Boolean).slice(0, 3).forEach(text => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = text.slice(0, 48);
    b.addEventListener('click', () => {
      row.innerHTML = '';
      row.style.display = 'none';
      $('input').value = text;
      submitInput();
    });
    row.appendChild(b);
  });
  if (row.children.length) row.style.display = 'flex';
}

function handleEventsSolo(events) {
  for (const e of events) {
    if (e.kind === 'dm' && String(e.text).startsWith('__FREE__')) continue; // служебный маркер — не для игрока
    if (e.kind === 'loot' && /УРОВЕНЬ/.test(e.text)) levelUpSound();
    if (e.kind === 'victory') levelUpSound();
    logEvent(e.kind, e.text);
  }
  showSuggestions(events);
  refreshPanelsSolo();
  if (state.over) typer.onFinish(state.story?.won ? () => showDeathCommon(state.epitaph || '', soloStatsLine(), true) : showDeathSolo);
}

function soloStatsLine() {
  return `${state.player.name}, ${state.player.className}, ур.${state.player.level}. Дошёл до этажа ${state.depth}. Ходов: ${state.turn}.`;
}

/**
 * Свободное действие в соло: маркер __FREE__ → ДМ (ИИ или заглушка) → эффекты.
 */
async function resolveFreeSolo(text) {
  const resolver = makeDmResolver();
  try {
    const eff = await resolver.resolveFree(state, text, state.activeIdx);
    handleEventsSolo(applyDmEffects(state, eff, state.activeIdx));
  } catch (e) {
    handleEventsSolo(applyDmEffects(state, { narrative: `ДМ замолк (${e.message}). Тьма вежливо молчит.` }, state.activeIdx));
  }
}

// ---------- КОП: ХОСТ ----------

async function startHostRoom() {
  saveCfg();
  initAudio();
  currentClient();
  const { name } = readCommonConfig();
  roomCode = makeRoomCode();
  $('lobby-panel').style.display = 'block';
  $('room-code').textContent = '····';
  $('lobby-list').innerHTML = '<div class="class-loading">Создаём комнату…</div>';
  $('btn-start').disabled = true;

  let net;
  try {
    net = await createPeerHostNet(roomCode);
  } catch (e) {
    $('btn-start').disabled = false;
    $('lobby-panel').style.display = 'none';
    addSetupNote(`Не удалось создать комнату: ${e.message}`);
    return;
  }

  sessionMode = 'host';
  hostSession = createHostSession({
    net,
    hostName: name,
    dm: makeDmResolver(),
    turnMs: 60000
  });
  hostSession.onLobby(renderLobby);
  hostSession.onEvents(evs => { if (typer) { evs.forEach(e => logEvent(e.kind, e.text)); showSuggestions(evs); } });
  hostSession.onSnapshot(snap => applySnapshot(snap));

  $('room-code').textContent = roomCode;
  $('btn-start').disabled = false;
  $('btn-start').textContent = '▶ ЖДАТЬ ИГРОКОВ…';
  $('btn-start').disabled = true;
  $('btn-launch').style.display = 'inline-block';
  renderLobby(hostSession.getLobby());
}

function renderLobby(players) {
  $('lobby-list').innerHTML = players.map(p =>
    `<div class="lobby-card"><pre class="avatar">${asciiAvatar(p.name)}</pre><div class="lobby-name">◆ ${esc(p.name)}${p.host ? ' <span class="hof-meta">(хост, оплачивает ИИ)</span>' : ''}</div></div>`
  ).join('');
  if (sessionMode === 'host') {
    $('btn-launch').disabled = players.length < 1;
    $('btn-launch').textContent = players.length < 2
      ? '▶ НАЧАТЬ (можно и одному)'
      : `▶ НАЧАТЬ СПУСК (${players.length} героев)`;
  }
}

async function hostLaunch() {
  const { world, mode, name } = readCommonConfig();
  const classes = selectedClasses();
  const lobby = hostSession.getLobby();
  const classAssignments = lobby.map((p, i) => ({
    name: p.name,
    className: classes[i % classes.length].name,
    stats: classes[i % classes.length].stats
  }));
  chronicle = [`МИР: ${world}`, `РЕЖИМ: ${mode === 'sandbox' ? 'песочница' : 'сюжет'} · КО-ОП`, `ПАРТИЯ: ${classAssignments.map(c => c.name).join(', ')}`];
  typer = createTyper($('log'));
  showScreen('screen-game');
  $('turn-banner').textContent = 'ЖДЁМ ХОДА…';
  wasMyTurn = false;
  showIntro([world.toUpperCase(), `РЕЖИМ: ${mode === 'sandbox' ? 'ПЕСОЧНИЦА' : 'СЮЖЕТ'} · КО-ОП`, `ПАРТИЯ: ${classAssignments.map(c => c.name).join(' · ')}`, 'ДАЛЕЕ: ТЬМА, ТРОЛЛИНГ И ПЕРМАСМЕРТЬ']);
  const intro = client
    ? async (game) => {
      try {
        const raw = await client.chat(introMessages(game), { maxTokens: 2000, jsonMode: true });
        return extractJson(raw) || { narrative: raw.slice(0, 600) };
      } catch (e) {
        return { narrative: `ДМ не отвечает (${e.message}). Партия очнулась в темноте. Как обычно.` };
      }
    }
  : async () => ({ narrative: `Вы все очнулись в темноте. ${name} претендует на роль лидера — подземелью это смешно.` });
  hostSession.startGame({ worldDesc: world, mode, classAssignments, intro });
}

// ---------- КОП: КЛИЕНТ ----------

async function joinRoom() {
  saveCfg();
  initAudio();
  const code = ($('set-room').value || '').trim().toUpperCase();
  const name = $('set-name').value.trim() || 'Безымянный';
  if (code.length !== 4) { addSetupNote('Код комнаты — 4 символа'); return; }

  $('lobby-panel').style.display = 'block';
  $('room-code').textContent = code;
  $('lobby-list').innerHTML = '<div class="class-loading">Подключаемся…</div>';
  $('btn-start').disabled = true;

  let link;
  try {
    link = await createPeerClientLink(code);
  } catch (e) {
    $('btn-start').disabled = false;
    $('lobby-panel').style.display = 'none';
    addSetupNote(`Не удалось подключиться: ${e.message}`);
    return;
  }

  sessionMode = 'client';
  clientSession = createClientSession({ link, name });
  clientSession.onLobby(renderLobby);
  clientSession.onEvents(evs => { if (typer) { evs.forEach(e => logEvent(e.kind, e.text)); showSuggestions(evs); } });
  clientSession.onSnapshot(snap => applySnapshot(snap));
  clientSession.onStart(() => {
    chronicle = [`КО-ОП · комната ${code}`];
    typer = createTyper($('log'));
    showScreen('screen-game');
    $('turn-banner').textContent = 'ЖДЁМ ХОДА…';
    wasMyTurn = false;
    showIntro([`КО-ОП · КОМНАТА ${code}`, 'ДАЛЕЕ: ТЬМА, ТРОЛЛИНГ И ПЕРМАСМЕРТЬ']);
  });
  clientSession.onReject(r => backToSetup(`Отказ: ${r.reason}`));
  clientSession.onKicked(r => backToSetup(`Тебя выгнали: ${r.reason}`));
  clientSession.onClose(() => {
    if (sessionMode === 'client') backToSetup('Соединение с хостом потеряно. Забег погиб вместе с ним.');
  });
  clientSession.hello();
}

function backToSetup(note) {
  sessionMode = 'solo';
  hostSession = null;
  clientSession = null;
  mySnapshot = null;
  showScreen('screen-setup');
  $('lobby-panel').style.display = 'none';
  $('btn-start').disabled = false;
  $('btn-start').textContent = '▶ НАЧАТЬ ЗАБЕГ';
  $('btn-launch').style.display = 'none';
  renderHof();
  if (note) addSetupNote(note);
}

// ---------- общий рендер из снапшота (хост+клиент в копе) ----------

function applySnapshot(snap) {
  mySnapshot = snap;
  renderStatsSnap($('stats'), snap);
  renderQuests($('quest-list'), snap);
  renderCombat($('combat-panel'), snap.combat || []);
  $('floor-label').textContent = `${snap.floorName} · комната ${roomCode || ''}`
    + (snap.story && !snap.over ? ` · ⚜ АКТ ${snap.story.act}/${snap.story.acts}: ${snap.story.villain}` : '');
  const hero = snap.heroes[snap.you];
  const myTurn = !snap.over && hero.alive && snap.turnOf === snap.you;
  // сигнал «твой ход»
  if (myTurn && !wasMyTurn) turnSound();
  wasMyTurn = myTurn;
  if (snap.over) {
    $('turn-banner').textContent = snap.won ? '⚜ ПОБЕДА — злодей повержен' : '☠ ПАРТИЯ УНИЧТОЖЕНА';
    typer.onFinish(() => showDeathSnap(snap));
  } else if (!hero.alive) {
    $('turn-banner').textContent = '☠ ТЫ МЁРТВ — наблюдаешь за партией';
  } else if (myTurn) {
    $('turn-banner').textContent = `▶ ТВОЙ ХОД (${hero.name})`;
    $('turn-banner').classList.add('mine');
  } else {
    $('turn-banner').textContent = `Ход: ${snap.heroes[snap.turnOf]?.name || '…'} — жди`;
    $('turn-banner').classList.remove('mine');
  }
  // блокируем ввод чужого хода
  $('input').disabled = !snap.over && hero.alive && snap.turnOf !== snap.you;
  $('input').placeholder = $('input').disabled
    ? 'жди своего хода…'
    : 'что ты делаешь? (пиши свободно) · ↑ история';
}

// ---------- смерть ----------

function showDeathSolo() {
  const won = !!state.story?.won;
  saveHofEntry({
    name: state.player.name,
    className: state.player.className,
    world: state.worldDesc,
    depth: state.depth,
    epitaph: won
      ? `⚜ победил ${state.story.villain} — и вышел живым. Почти.`
      : (state.epitaph || 'умер от жизни'),
    date: new Date().toLocaleDateString('ru-RU')
  });
  showDeathCommon(
    state.epitaph || '',
    `${state.player.name}, ${state.player.className}, ур.${state.player.level}. Дошёл до этажа ${state.depth}. Ходов: ${state.turn}.`,
    won
  );
}

function showDeathSnap(snap) {
  const me = snap.heroes[snap.you];
  const won = !!snap.won;
  saveHofEntry({
    name: me.name,
    className: me.className,
    world: snap.worldDesc,
    depth: snap.depth,
    epitaph: won
      ? `⚜ партия победила ${snap.story?.villain || 'злодея'}`
      : (snap.epitaph || (me.alive ? 'пережил всех, но не подземелье' : 'погиб в подземелье')),
    date: new Date().toLocaleDateString('ru-RU')
  });
  showDeathCommon(
    snap.epitaph || '',
    `${me.name}, ${me.className}, ур.${me.level}. Дошёл до этажа ${snap.depth}.`,
    won
  );
}

async function showDeathCommon(epitaph, stats, won = false) {
  await deathGlitch();
  $('death-title').textContent = won ? '⚜ ПОБЕДА ⚜' : '☠ ТЫ МЁРТВ ☠';
  $('death-box').classList.toggle('victory', !!won);
  $('death-epitaph').textContent = won && !epitaph ? 'Злодей повержен, мир спасён. Подземелье подаёт апелляцию.' : epitaph;
  $('death-stats').textContent = stats;
  $('screen-death').classList.add('active');
}

const COFFEE_ART =
  '  ( (\n' +
  '   ) )\n' +
  ' ..........\n' +
  ' |        |]\n' +
  ' \\        /\n' +
  '  `------\'\n' +
  'ДМ наливает тебе кофе. Горячий. Беспощадный.';

/** Пасхалка: «кофе» не тратит ход. Возвращает true, если перехвачено. */
function tryCoffee(text) {
  // \b в JS не работает с кириллицей — используем lookahead
  if (!/^(кофе|coffee)(?![а-яёa-z])/i.test(text.trim())) return false;
  logEvent('loot', COFFEE_ART);
  coffeeSound();
  return true;
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
  const body = chronicle.slice(3).join('\n');
  const tail = `\n\n${'═'.repeat(60)}\n${mySnapshot?.epitaph || state?.epitaph ? 'ЭПИТАФИЯ: ' + (mySnapshot?.epitaph || state?.epitaph) : ''}\n`;
  const blob = new Blob([header + body + tail], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dnd-chronicle-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- ввод ----------

function submitInput() {
  const text = $('input').value.trim();
  if (!text) return;
  if (sessionMode === 'solo') {
    if (!state || state.over) return;
    $('input').value = '';
    inputHistory.push(text);
    historyIdx = inputHistory.length;
    blip(520);
    if (tryCoffee(text)) return;
    logEvent('player', `> ${text}`);
    const events = applyIntent(state, parseCommand(text));
    // свободное действие уходит ДМу, маркер игроку не показывается
    handleEventsSolo(events.filter(e => !(e.kind === 'dm' && String(e.text).startsWith('__FREE__'))));
    const freeEv = events.find(e => e.kind === 'dm' && String(e.text).startsWith('__FREE__'));
    if (freeEv && !state.over) resolveFreeSolo(freeEv.text.slice(8));
  } else if (sessionMode === 'host') {
    if (!hostSession || !hostSession.isStarted()) return;
    $('input').value = '';
    inputHistory.push(text);
    historyIdx = inputHistory.length;
    blip(520);
    if (tryCoffee(text)) return;
    hostSession.localIntent(text); // эхо придёт broadcast'ом — как всем
  } else if (sessionMode === 'client') {
    if (!clientSession || !mySnapshot) return;
    if (mySnapshot.turnOf !== mySnapshot.you) return;
    $('input').value = '';
    inputHistory.push(text);
    historyIdx = inputHistory.length;
    blip(520);
    if (tryCoffee(text)) return;
    clientSession.sendCommand(text); // эхо придёт broadcast'ом — как всем
  }
}

// ---------- визуальные настройки ----------

function wireVis() {
  applyVis(vis);
  refreshThemeOptions();

  $('vis-theme').value = THEMES.includes(vis.theme) || vis.theme === 'terminator' ? vis.theme : 'amber';
  $('vis-glyphs').value = GLYPH_SETS[vis.glyphs] ? vis.glyphs : 'classic';
  $('vis-flicker').checked = !!vis.flicker;
  $('vis-vol').value = vis.volume;
  $('vis-mute').checked = !!vis.muted;

  const update = () => {
    vis = {
      theme: $('vis-theme').value,
      glyphs: $('vis-glyphs').value,
      flicker: $('vis-flicker').checked,
      volume: Number($('vis-vol').value),
      muted: $('vis-mute').checked
    };
    saveVis(vis);
    applyVis(vis);
  };
  ['vis-theme', 'vis-glyphs', 'vis-flicker', 'vis-vol', 'vis-mute'].forEach(id =>
    $(id).addEventListener('change', update)
  );
}

/** Опция «терминатор» появляется после 10 смертей в зале славы. */
function refreshThemeOptions() {
  const sel = $('vis-theme');
  const has = [...sel.options].some(o => o.value === 'terminator');
  const unlocked = deathCount() >= TERMINATOR_AFTER;
  if (unlocked && !has) {
    const opt = document.createElement('option');
    opt.value = 'terminator';
    opt.textContent = '■ ТЕРМИНАТОР (секретная)';
    sel.appendChild(opt);
  } else if (!unlocked && !has) {
    const opt = document.createElement('option');
    opt.value = 'terminator';
    opt.disabled = true;
    opt.textContent = `Терминатор (откроется после ${TERMINATOR_AFTER} смертей)`;
    sel.appendChild(opt);
  }
}

// ---------- инициализация ----------

function wire() {
  loadCfg();
  renderHof();
  wireVis();
  bootCRT();
  startMatrix();

  // живой предпросмотр аватара из ника
  const updateAvatar = () => { $('name-avatar').textContent = asciiAvatar($('set-name').value.trim() || 'Безымянный'); };
  $('set-name').addEventListener('input', updateAvatar);
  updateAvatar();

  // автоподгонка арта: при загрузке, ресайзе и после загрузки пиксельного шрифта
  fitArt();
  window.addEventListener('resize', () => { fitArt(); });
  if (document.fonts?.ready) document.fonts.ready.then(() => { fitArt(); });

  $('set-mp').addEventListener('change', () => {
    const mp = $('set-mp').value;
    $('join-row').style.display = mp === 'join' ? 'flex' : 'none';
    $('btn-start').textContent = mp === 'host' ? '▶ СОЗДАТЬ КОМНАТУ' : mp === 'join' ? '▶ ВОЙТИ В КОМНАТУ' : '▶ НАЧАТЬ ЗАБЕГ';
  });

  $('btn-classes').addEventListener('click', renderClassList);
  $('btn-start').addEventListener('click', () => {
    const mp = $('set-mp').value;
    if (mp === 'host') startHostRoom();
    else if (mp === 'join') joinRoom();
    else startSolo();
  });
  $('btn-launch').addEventListener('click', hostLaunch);
  $('btn-export').addEventListener('click', exportChronicle);
  $('btn-restart').addEventListener('click', () => {
    $('screen-death').classList.remove('active');
    if (sessionMode === 'host' && hostSession) hostSession.stop();
    backToSetup();
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

// отладочный хук для e2e-тестов: доступ к живому состоянию соло
if (typeof window !== 'undefined') window.__dndState = () => state || null;
