// app.js — склейка всего: экраны, игровой цикл, ввод, кооп (хост/клиент), смерть, зал славы, экспорт.

import { newGame, parseCommand, applyIntent, applyDmEffects } from '../engine/game.js';
import { createClient, extractJson } from '../ai/client.js';
import { buildContext, introMessages, classMessages } from '../ai/dm.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { makeRoomCode } from '../net/loopback.js';
import { createPeerHostNet, createPeerClientLink } from '../net/peer.js';
import { PROTOCOL_VER } from '../net/protocol.js';
import {
  createTyper, renderMap, renderStats, renderQuests,
  renderSnapshotMap, renderStatsSnap
} from './terminal.js';
import { initAudio, rollSound, hitSound, lootSound, levelUpSound, deathSound, blip } from './sound.js';

const $ = (id) => document.getElementById(id);

const STUB_CLASSES = [
  { name: 'Плут', desc: 'Кривые руки, быстрые ноги', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } },
  { name: 'Воин', desc: 'Стена мяса с мечом', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } },
  { name: 'Волхв', desc: 'Магия и высокомерие', stats: { str: 8, dex: 10, int: 16, con: 12, cha: 14, luck: 12 } }
];

let cfg = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' };
let client = null;          // AI-клиент (хост/соло)
let state = null;           // соло-состояние
let typer = null;
let chronicle = [];
let inputHistory = [];
let historyIdx = -1;

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
    resolveFree: async (game, text) => {
      if (client) {
        try {
          const raw = await client.chat(buildContext(game, text), { maxTokens: 600 });
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

  if (client) {
    client.chat(introMessages(state), { maxTokens: 500 })
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
    default: break;
  }
}

function handleEventsSolo(events) {
  for (const e of events) {
    if (e.kind === 'loot' && /УРОВЕНЬ/.test(e.text)) levelUpSound();
    logEvent(e.kind, e.text);
  }
  refreshPanelsSolo();
  if (state.over) typer.onFinish(showDeathSolo);
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
  hostSession.onEvents(evs => { if (typer) evs.forEach(e => logEvent(e.kind, e.text)); });
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
    `<div class="quest">◆ ${esc(p.name)}${p.host ? ' <span class="hof-meta">(хост, оплачивает ИИ)</span>' : ''}</div>`
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
  const intro = client
    ? async (game) => {
      try {
        const raw = await client.chat(introMessages(game), { maxTokens: 500 });
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
  clientSession.onEvents(evs => { if (typer) evs.forEach(e => logEvent(e.kind, e.text)); });
  clientSession.onSnapshot(snap => applySnapshot(snap));
  clientSession.onStart(() => {
    chronicle = [`КО-ОП · комната ${code}`];
    typer = createTyper($('log'));
    showScreen('screen-game');
    $('turn-banner').textContent = 'ЖДЁМ ХОДА…';
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
  renderSnapshotMap($('map'), snap);
  renderStatsSnap($('stats'), snap);
  renderQuests($('quest-list'), snap);
  $('floor-label').textContent = `${snap.floorName} · комната ${roomCode || ''}`;
  const hero = snap.heroes[snap.you];
  if (snap.over) {
    $('turn-banner').textContent = '☠ ПАРТИЯ УНИЧТОЖЕНА';
    typer.onFinish(() => showDeathSnap(snap));
  } else if (!hero.alive) {
    $('turn-banner').textContent = '☠ ТЫ МЁРТВ — наблюдаешь за партией';
  } else if (snap.turnOf === snap.you) {
    $('turn-banner').textContent = `▶ ТВОЙ ХОД (${hero.name})`;
  } else {
    $('turn-banner').textContent = `Ход: ${snap.heroes[snap.turnOf]?.name || '…'} — жди`;
  }
  // блокируем ввод чужого хода
  $('input').disabled = !snap.over && hero.alive && snap.turnOf !== snap.you;
  $('input').placeholder = $('input').disabled
    ? 'жди своего хода…'
    : 'что ты делаешь? (пиши свободно) · ↑ история';
}

// ---------- смерть ----------

function showDeathSolo() {
  saveHofEntry({
    name: state.player.name,
    className: state.player.className,
    world: state.worldDesc,
    depth: state.depth,
    epitaph: state.epitaph || 'умер от жизни',
    date: new Date().toLocaleDateString('ru-RU')
  });
  showDeathCommon(state.epitaph || '', `${state.player.name}, ${state.player.className}, ур.${state.player.level}. Дошёл до этажа ${state.depth}. Ходов: ${state.turn}.`);
}

function showDeathSnap(snap) {
  const me = snap.heroes[snap.you];
  saveHofEntry({
    name: me.name,
    className: me.className,
    world: snap.worldDesc,
    depth: snap.depth,
    epitaph: snap.epitaph || (me.alive ? 'пережил всех, но не подземелье' : 'погиб в подземелье'),
    date: new Date().toLocaleDateString('ru-RU')
  });
  showDeathCommon(
    snap.epitaph || '',
    `${me.name}, ${me.className}, ур.${me.level}. Дошёл до этажа ${snap.depth}.`
  );
}

function showDeathCommon(epitaph, stats) {
  $('death-epitaph').textContent = epitaph;
  $('death-stats').textContent = stats;
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
    logEvent('player', `> ${text}`);
    handleEventsSolo(applyIntent(state, parseCommand(text)));
  } else if (sessionMode === 'host') {
    if (!hostSession || !hostSession.isStarted()) return;
    $('input').value = '';
    inputHistory.push(text);
    blip(520);
    logEvent('player', `> ${text}`);
    hostSession.localIntent(text);
  } else if (sessionMode === 'client') {
    if (!clientSession || !mySnapshot) return;
    if (mySnapshot.turnOf !== mySnapshot.you) return;
    $('input').value = '';
    inputHistory.push(text);
    blip(520);
    logEvent('player', `> ${text}`);
    clientSession.sendCommand(text);
  }
}

// ---------- инициализация ----------

function wire() {
  loadCfg();
  renderHof();

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
