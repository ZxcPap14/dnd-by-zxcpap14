// app.js — склейка всего: экраны, игровой цикл, ввод, кооп (хост/клиент), смерть, зал славы, экспорт.

import { newGame, parseCommand, applyIntent, applyDmEffects, engagedEnemies } from '../engine/game.js';
import { createClient, extractJson } from '../ai/client.js';
import { buildContext, introMessages, classMessages, backstoryMessages } from '../ai/dm.js';
import { sanitizeAbility } from '../engine/player.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { makeRoomCode } from '../net/loopback.js';
import { createHybridHostNet, createHybridClientLink } from '../net/hybrid.js';
import { loadCustomTurn, saveCustomTurn } from '../net/turnconfig.js';
import { loadRelayUrl, saveRelayUrl, relayBrokerOverride } from '../net/relay.js';
import { PROTOCOL_VER } from '../net/protocol.js';
import { saveRun, loadRun, loadRunRaw, clearRun, runSummary } from '../engine/save.js';
import {
  createTyper, renderStats, renderQuests, renderInventoryPanel, renderShop,
  renderStatsSnap, renderCombat, renderMiniMap, renderMiniMapSnap, GLYPH_SETS, MAX_LOG_LINES
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
  {
    name: 'Плут', desc: 'Кривые руки, быстрые ноги',
    stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 },
    ability: { name: 'Тень за спиной', active: 'dash', power: 5, cd: 3, passive: 'crit', passivePower: 2 }
  },
  {
    name: 'Воин', desc: 'Стена мяса с мечом',
    stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 },
    ability: { name: 'Кровавый замах', active: 'smite', power: 7, cd: 3, passive: 'ac', passivePower: 1 }
  },
  {
    name: 'Волхв', desc: 'Магия и высокомерие',
    stats: { str: 8, dex: 10, int: 16, con: 12, cha: 14, luck: 12 },
    ability: { name: 'Слово заживления', active: 'heal', power: 8, cd: 4, passive: 'regen', passivePower: 1 }
  }
];

const ACTIVE_LABELS = { heal: 'лечение', smite: 'кара', stun: 'оглушение', dash: 'рывок' };
const PASSIVE_LABELS = { crit: 'крит', lifesteal: 'вампиризм', regen: 'регенерация', gold: 'жадность', ac: 'защита' };

/** Человеческая строка про способность класса — для карточек и лога. */
function abilityLine(a) {
  if (!a) return 'без способностей';
  const parts = [];
  if (a.active) parts.push(`«${a.name}»: ${ACTIVE_LABELS[a.active] || a.active}, сила ${a.power}, КД ${a.cd}`);
  if (a.passive) parts.push(`пассив ${PASSIVE_LABELS[a.passive] || a.passive} ${a.passivePower}`);
  return parts.join(' · ');
}

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

// переподключение клиента: последняя комната и попытки вернуться
let lastJoin = null;        // { code, name, heroIdx }
let clientLink = null;      // текущий транспорт клиента (для диагностики и __drop)
let reconnecting = false;
let reconnectTimer = null;
let reconnectTries = 0;
let reconnectGen = 0;       // поколение соединения: старые линки не должны мешать
let attemptInFlight = false;

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

// ---------- сохранение / продолжение забега ----------

/** Показать на стартовом экране «незаконченный забег», если он есть. */
function refreshContinue() {
  const panel = $('continue-panel');
  if (!panel) return;
  const raw = loadRunRaw();
  if (!raw || raw.body?.over) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const when = raw.ts ? new Date(raw.ts).toLocaleString('ru-RU') : '';
  $('continue-info').textContent = runSummary(raw.meta) + (when ? ` · сохранено ${when}` : '');
}

/** Автосейв после каждого хода: соло и хост коопа. */
function maybeSave() {
  if (sessionMode === 'solo' && state && !state.over) {
    saveRun(state, { coop: false });
  } else if (sessionMode === 'host' && hostSession?.getGame() && !hostSession.getGame().over) {
    saveRun(hostSession.getGame(), { coop: true, room: roomCode });
  }
}

function dropSave() {
  clearRun();
  refreshContinue();
}

/** Продолжить забег: соло — сразу, кооп — поднять комнату с тем же кодом. */
async function continueRun() {
  const saved = loadRun();
  if (!saved) { addSetupNote('Сейв не читается — начинаем заново.'); refreshContinue(); return; }
  if (saved.state.over) { addSetupNote('Тот забег закончен. Начни новый.'); dropSave(); return; }
  if (saved.meta?.coop) await resumeHostRun(saved);
  else resumeSolo(saved);
}

function resumeSolo(saved) {
  saveCfg();
  initAudio();
  currentClient();
  sessionMode = 'solo';
  state = saved.state;
  chronicle = [
    `МИР: ${state.worldDesc}`,
    `ПРОДОЛЖЕНО: ${state.floorName}, ход ${state.turn}`,
    `ГЕРОЙ: ${state.player.name}, ${state.player.className}`
  ];
  typer = createTyper($('log'));
  showScreen('screen-game');
  refreshPanelsSolo();
  $('turn-banner').textContent = 'СОЛО · твой ход всегда';
  wasMyTurn = true;
  logEvent('system', `Ты возвращаешься в темноту. ${state.floorName}, ход ${state.turn}. Подземелье ждало.`);
  if (state.merchant) logEvent('system', `⚖ ${state.merchant.name} всё ещё здесь — «торговец» покажет товар.`);
  $('input').disabled = false;
  $('input').focus();
}

async function resumeHostRun(saved) {
  saveCfg();
  initAudio();
  currentClient();
  const meta = saved.meta || {};
  roomCode = meta.room || makeRoomCode();
  const hostName = meta.party?.[0] || $('set-name').value.trim() || 'Хост';

  $('lobby-panel').style.display = 'block';
  $('room-code').textContent = roomCode;
  $('lobby-list').innerHTML = '<div class="class-loading">Возвращаемся в комнату…</div>';
  addSetupNote(`Комната ${roomCode}: партия вернётся по тем же именам.`);

  let net;
  try {
    net = await createHybridHostNet(roomCode);
  } catch (e) {
    $('lobby-panel').style.display = 'none';
    addSetupNote(`Не удалось поднять комнату ${roomCode}: ${e.message}`);
    return;
  }
  window.__transport = net.transport;
  window.__channels = () => (net.channels ? net.channels() : [net.transport]);

  sessionMode = 'host';
  hostSession = createHostSession({ net, hostName, dm: makeDmResolver(), turnMs: 60000 });
  wireHostSession();

  if (!hostSession.resumeGame(saved.state)) {
    addSetupNote('Забег не восстановился — начни новый.');
    backToSetup('');
    return;
  }
  $('lobby-panel').style.display = 'none';
  typer = createTyper($('log'));
  chronicle = [
    `МИР: ${saved.state.worldDesc}`,
    `ПРОДОЛЖЕНО: ${saved.state.floorName}, ход ${saved.state.turn} · комната ${roomCode}`,
    `ПАРТИЯ: ${saved.state.heroes.map(h => h.name).join(', ')}`
  ];
  showScreen('screen-game');
  $('turn-banner').textContent = 'ЖДЁМ ХОДА…';
  wasMyTurn = false;
  logEvent('system', `Комната ${roomCode} снова открыта. Герои возвращаются по именам: ${saved.state.heroes.slice(1).map(h => h.name).join(', ') || 'никого'}.`);
  $('input').disabled = false;
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

// ---------- свои классы (localStorage) ----------

function loadCustomClasses() {
  try {
    const raw = JSON.parse(localStorage.getItem('dnd_custom_classes') || '[]');
    return Array.isArray(raw) ? raw.filter(c => c && c.name) : [];
  } catch { return []; }
}
function saveCustomClasses(list) {
  localStorage.setItem('dnd_custom_classes', JSON.stringify(list.slice(0, 12)));
}

function renderCustomClasses() {
  const box = $('custom-class-list');
  if (!box) return;
  const list = loadCustomClasses();
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.map((c, i) => `
    <div class="class-card" style="cursor:default">
      <span class="cc-badge">◆ СВОЙ КЛАСС</span>
      <span class="class-name">${esc(c.name)}</span>
      <span class="class-desc">${esc(c.desc || '')}</span>
      <span class="cc-ability">${esc(abilityLine(c.ability))}</span>
      <button class="cc-del" data-i="${i}">УДАЛИТЬ</button>
    </div>`).join('');
  box.querySelectorAll('.cc-del').forEach(b => b.addEventListener('click', () => {
    const l = loadCustomClasses();
    l.splice(Number(b.dataset.i), 1);
    saveCustomClasses(l);
    renderCustomClasses();
    renderClassList();
  }));
}

/** Прочитать конструктор классов → объект класса (мусор зажимается). */
function readCustomClassForm() {
  const num = (id, lo, hi, def) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def;
  };
  const ability = sanitizeAbility({
    name: $('cc-aname').value.trim() || 'Особый талант',
    active: $('cc-active').value,
    power: num('cc-power', 1, 20, 6),
    cd: num('cc-cd', 1, 20, 3),
    passive: $('cc-passive').value,
    passivePower: num('cc-ppower', 1, 5, 2)
  });
  return {
    name: ($('cc-name').value.trim() || 'Безымянный класс').slice(0, 24),
    desc: $('cc-desc').value.trim().slice(0, 80),
    stats: {
      str: num('cc-str', 6, 18, 12), dex: num('cc-dex', 6, 18, 12), int: num('cc-int', 6, 18, 12),
      con: num('cc-con', 6, 18, 12), cha: num('cc-cha', 6, 18, 12), luck: num('cc-luck', 6, 18, 12)
    },
    ability
  };
}

function saveCustomClass() {
  const cls = readCustomClassForm();
  if (!$('cc-name').value.trim()) { addSetupNote('Классу нужно имя.'); return; }
  if (!cls.ability) { addSetupNote('Нужна хотя бы одна способность — активная или пассивка.'); return; }
  const list = loadCustomClasses();
  list.unshift(cls);
  saveCustomClasses(list);
  $('custom-class-form').style.display = 'none';
  addSetupNote(`Класс «${cls.name}» сохранён. Он есть в списке классов — и способность реально работает.`);
  renderCustomClasses();
  renderClassList();
}

// ---------- предыстория ----------

function setBackstory(text) {
  const el = $('set-backstory');
  el.value = String(text || '').slice(0, 2400);
  updateBackstoryCount();
  try { localStorage.setItem('dnd_backstory', el.value); } catch { /*ignore*/ }
}
function updateBackstoryCount() {
  const el = $('set-backstory');
  const c = $('backstory-count');
  if (el && c) c.textContent = `${el.value.length} / 2400`;
}

/** Офлайн-заготовка предыстории — работает без ключа и без сети. */
function offlineBackstory(world, name, className) {
  const w = world.toLowerCase();
  const variants = [
    `${name} не собирался становиться героем. ${className} из него вышел случайно: сначала он просто пытался выжить в мире, который называет себя «${world}», потом — просто не умирать. Долг перед человеком, чьё имя он до сих пор не может произнести вслух, привёл его к чёрному входу в подземелье. В кармане — чужая монета с пропиленным отверстием: то ли оберег, то ли расписка.`,
    `Говорят, ${name} был ${className.toLowerCase()} до того, как всё пошло не так. Теперь он идёт вниз, потому что наверху его ждут либо кредиторы, либо палач — а внизу ждёт только темнота, и она хотя бы честна. С ним — обломок чужого клинка: он обещал вернуть его владельцу. Владелец обещания не дождался.`,
    `${name} пришёл из мест, где ${w} ещё не добралось. Он был ${className.toLowerCase()} — пока однажды не нашёл на пороге корзину с чужой судьбой внутри. С тех пор он спускается в подземелья, потому что наверху слишком много людей, которые знают его в лицо. И слишком мало, кто знает, что он сделал.`
  ];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return variants[h % variants.length];
}

async function generateBackstory() {
  const world = $('set-world').value.trim() || 'Классическое тёмное фэнтези';
  const name = $('set-name').value.trim() || 'Безымянный';
  const mode = $('set-mode').value;
  const cls = selectedClasses()[Number(document.querySelector('input[name="class"]:checked')?.value || 0)] || STUB_CLASSES[0];
  const btn = $('btn-backstory');
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'пишем…';
  try {
    const c = currentClient();
    if (!c) {
      setBackstory(offlineBackstory(world, name, cls.name));
      addSetupNote('Без ключа ИИ — вот заготовка. Правь руками, она уйдёт ДМу как канон.');
      return;
    }
    const raw = await c.chat(backstoryMessages(world, name, cls.name, mode), { maxTokens: 900, jsonMode: true });
    const data = extractJson(raw);
    const text = String(data?.backstory || '').trim();
    if (!text) throw new Error('пустой ответ');
    setBackstory(text);
    addSetupNote('Предыстория готова — теперь можно править руками.');
  } catch (e) {
    setBackstory(offlineBackstory(world, name, cls.name));
    addSetupNote(`ИИ не ответил (${e.message}) — вот заготовка, правь руками.`);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

async function renderClassList() {
  const world = $('set-world').value.trim() || 'Классическое тёмное фэнтези';
  const list = $('class-list');
  list.innerHTML = '<div class="class-loading">Придумываем классы…</div>';
  let generated = STUB_CLASSES;
  const c = currentClient();
  if (c) {
    try {
      const raw = await c.chat(classMessages(world), { maxTokens: 1500, jsonMode: true });
      const data = extractJson(raw);
      if (data?.classes?.length) generated = data.classes.slice(0, 4);
    } catch (e) {
      addSetupNote(`ИИ недоступен (${e.message}) — берём стандартные классы`);
    }
  }
  // свои классы идут первыми: игрок их сам собрал, он их и хочет видеть
  const custom = loadCustomClasses().map(x => ({ ...x, custom: true }));
  const classes = [...custom, ...generated];
  list.innerHTML = classes.map((cl, i) => `
    <label class="class-card">
      <input type="radio" name="class" value="${i}" ${i === 0 ? 'checked' : ''}>
      ${cl.custom ? '<span class="cc-badge">◆ СВОЙ</span>' : ''}
      <span class="class-name">${esc(cl.name)}</span>
      <span class="class-desc">${esc(cl.desc || '')}</span>
      <span class="cc-ability">${esc(abilityLine(cl.ability))}</span>
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
    name: $('set-name').value.trim() || 'Безымянный',
    backstory: $('set-backstory').value.trim().slice(0, 2400)
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
  const { world, mode, name, backstory } = readCommonConfig();
  const classes = selectedClasses();
  const cls = classes[Number(document.querySelector('input[name="class"]:checked')?.value || 0)] || STUB_CLASSES[0];

  clearRun();                       // новый забег вытесняет старый сейв
  refreshContinue();
  resetStub();
  sessionMode = 'solo';
  state = newGame({
    seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
    mode, worldDesc: world, backstory,
    players: [{ name, className: cls.name, stats: cls.stats, ability: cls.ability }]
  });
  chronicle = [`МИР: ${world}`, `РЕЖИМ: ${mode === 'sandbox' ? 'песочница' : 'сюжет'}`, `ГЕРОЙ: ${name}, ${cls.name}`];
  if (cls.ability) chronicle.push(`СПОСОБНОСТЬ: ${abilityLine(cls.ability)}`);
  if (backstory) chronicle.push(`ПРЕДЫСТОРИЯ: ${backstory}`);
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
  renderMiniMap($('map-mini'), state, vis.glyphs);
  renderQuests($('quest-list'), state);
  renderCombat($('combat-panel'), engagedEnemies(state, state.activeIdx));
  refreshAbilityBtn();
  refreshInventory();
  refreshShop();
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
  // лимит хроники: длинный забег не должен превращаться в тысячу узлов и мегабайт строк
  if (chronicle.length > MAX_LOG_LINES) chronicle.splice(0, chronicle.length - MAX_LOG_LINES);
  typer.add(classify(kind, text), text);
  switch (kind) {
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

/**
 * Кнопка способности у строки ввода: показывает имя и остаток кулдауна.
 * Работает и в соло (state), и в коопе (снапшот).
 */
function refreshAbilityBtn() {
  const btn = $('ability-btn');
  if (!btn) return;
  const a = sessionMode === 'solo' ? state?.player?.ability : mySnapshot?.self?.ability;
  if (!a) { btn.style.display = 'none'; return; }
  const cd = sessionMode === 'solo'
    ? (a.active ? Math.max(0, (state.player.abilityReady || 0) - state.turn) : 0)
    : (a.active ? (mySnapshot?.self?.abilityCd || 0) : 0);
  btn.style.display = 'inline-block';
  btn.disabled = !!a.active && cd > 0;
  btn.textContent = !a.active ? a.name : cd > 0 ? `${a.name} · ${cd}` : `✦ ${a.name}`;
  btn.title = a.active ? `Применить «${a.name}»` : `${a.name} (пассивная)`;
}

/**
 * Рюкзак: список предметов с кнопками «выпить» / «надеть».
 * В коопе кнопки гаснут, пока не твой ход — движок всё равно отклонит чужой ход,
 * но лучше не дразнить игрока.
 */
function refreshInventory() {
  const el = $('inv-list');
  if (!el) return;
  const items = sessionMode === 'solo' ? state?.player?.inventory : mySnapshot?.self?.inventory;
  const merchant = sessionMode === 'solo' ? state?.merchant : mySnapshot?.merchant;
  renderInventoryPanel(el, items, { sell: !!merchant });
  const myTurn = sessionMode === 'solo'
    ? !!state && !state.over
    : !!mySnapshot && mySnapshot.turnOf === mySnapshot.you;
  el.querySelectorAll('.inv-btn').forEach(b => { b.disabled = !myTurn; });
}

/**
 * Прилавок торговца. Появляется только когда торговец есть на этаже,
 * кнопки гаснут не в свой ход (движок всё равно отклонит чужую покупку).
 */
function refreshShop() {
  const panel = $('shop-panel');
  if (!panel) return;
  const merchant = sessionMode === 'solo' ? state?.merchant : mySnapshot?.merchant;
  renderShop(panel, $('shop-list'), merchant);
  if (!merchant) return;
  $('shop-name').textContent = `${merchant.name}: «${merchant.greeting}»`;
  const myTurn = sessionMode === 'solo'
    ? !!state && !state.over
    : !!mySnapshot && mySnapshot.turnOf === mySnapshot.you;
  panel.querySelectorAll('.shop-btn').forEach(b => { b.disabled = !myTurn; });
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
  maybeSave();
  if (state.over) {
    clearRun(); // забег закончен — «продолжить» больше нечего
    typer.onFinish(state.story?.won ? () => showDeathCommon(state.epitaph || '', soloStatsLine(), true) : showDeathSolo);
  }
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
    net = await createHybridHostNet(roomCode);
  } catch (e) {
    $('btn-start').disabled = false;
    $('lobby-panel').style.display = 'none';
    addSetupNote(`Не удалось создать комнату: ${e.message}`);
    return;
  }
  window.__transport = net.transport;
  window.__channels = () => (net.channels ? net.channels() : [net.transport]);

  sessionMode = 'host';
  hostSession = createHostSession({
    net,
    hostName: name,
    dm: makeDmResolver(),
    turnMs: 60000
  });
  wireHostSession();

  $('room-code').textContent = roomCode;
  $('btn-start').disabled = false;
  $('btn-start').textContent = '▶ ЖДАТЬ ИГРОКОВ…';
  $('btn-start').disabled = true;
  $('btn-launch').style.display = 'inline-block';
  renderLobby(hostSession.getLobby());
}

/** Подписки хоста — общие для новой партии и для продолжения сохранённой. */
function wireHostSession() {
  hostSession.onLobby(renderLobby);
  hostSession.onEvents(evs => {
    if (typer) { evs.forEach(e => logEvent(e.kind, e.text)); showSuggestions(evs); }
    maybeSave();
    if (hostSession.getGame()?.over) clearRun();
  });
  hostSession.onSnapshot(snap => applySnapshot(snap));
  hostSession.onOver(() => { clearRun(); refreshContinue(); });
}

function renderLobby(players) {
  $('lobby-list').innerHTML = players.map(p =>
    `<div class="lobby-card${p.offline ? ' offline' : ''}"><pre class="avatar">${asciiAvatar(p.name)}</pre><div class="lobby-name">◆ ${esc(p.name)}${p.host ? ' <span class="hof-meta">(хост, оплачивает ИИ)</span>' : ''}${p.offline ? ' <span class="hof-meta">(ждём возвращения…)</span>' : ''}</div></div>`
  ).join('');
  if (sessionMode === 'host') {
    $('btn-launch').disabled = players.length < 1;
    $('btn-launch').textContent = players.length < 2
      ? '▶ НАЧАТЬ (можно и одному)'
      : `▶ НАЧАТЬ СПУСК (${players.length} героев)`;
  }
}

async function hostLaunch() {
  const { world, mode, name, backstory } = readCommonConfig();
  const classes = selectedClasses();
  clearRun();
  refreshContinue();
  const lobby = hostSession.getLobby();
  const classAssignments = lobby.map((p, i) => ({
    name: p.name,
    className: classes[i % classes.length].name,
    stats: classes[i % classes.length].stats,
    ability: classes[i % classes.length].ability
  }));
  chronicle = [`МИР: ${world}`, `РЕЖИМ: ${mode === 'sandbox' ? 'песочница' : 'сюжет'} · КО-ОП`, `ПАРТИЯ: ${classAssignments.map(c => c.name).join(', ')}`];
  classAssignments.forEach(c => { if (c.ability) chronicle.push(`${c.name} (${c.className}): ${abilityLine(c.ability)}`); });
  if (backstory) chronicle.push(`ПРЕДЫСТОРИЯ: ${backstory}`);
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
  hostSession.startGame({ worldDesc: world, mode, classAssignments, backstory, intro });
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
    link = await createHybridClientLink(code, note => addSetupNote(note));
  } catch (e) {
    $('btn-start').disabled = false;
    $('lobby-panel').style.display = 'none';
    addSetupNote(`Не удалось подключиться: ${e.message}`);
    return;
  }
  window.__transport = link.transport;

  sessionMode = 'client';
  lastJoin = { code, name, heroIdx: null };
  clientLink = link;
  clientSession = createClientSession({ link, name });
  wireClientSession(clientSession, code, name);
  clientSession.hello();
}

/**
 * Подписки клиента — общие для первого входа и для переподключения.
 * gen — поколение соединения: обработчики старого линка молчат, иначе «мёртвый»
 * сокет через минуту снова выкинет игрока на экран «связь потеряна».
 */
function wireClientSession(sess, code, name, gen = reconnectGen) {
  const fresh = () => gen === reconnectGen;
  sess.onLobby(players => { if (fresh()) renderLobby(players); });
  sess.onEvents(evs => {
    if (!fresh() || !typer) return;
    evs.forEach(e => logEvent(e.kind, e.text));
    showSuggestions(evs);
  });
  sess.onSnapshot(snap => {
    if (!fresh()) return;
    applySnapshot(snap);
    if (lastJoin) lastJoin.heroIdx = snap.you; // запомнить слот для возврата
  });
  sess.onStart(() => {
    if (!fresh() || typer) return; // после переподключения экран уже на месте
    chronicle = [`КО-ОП · комната ${code}`];
    typer = createTyper($('log'));
    showScreen('screen-game');
    $('turn-banner').textContent = 'ЖДЁМ ХОДА…';
    wasMyTurn = false;
    showIntro([`КО-ОП · КОМНАТА ${code}`, 'ДАЛЕЕ: ТЬМА, ТРОЛЛИНГ И ПЕРМАСМЕРТЬ']);
  });
  sess.onWelcome(w => {
    if (w.name && lastJoin) lastJoin.name = w.name; // тёзку хост переименовал — возвращаемся под новым ником
    if (fresh() && reconnecting) finishReconnect();
  });
  sess.onReject(r => {
    if (!fresh()) return;
    if (reconnecting) { reconnectNote(`хост отказал: ${r.reason}`); scheduleReconnect(4000); }
    else backToSetup(`Отказ: ${r.reason}`);
  });
  sess.onKicked(r => {
    if (!fresh()) return;
    reconnecting = false;
    stopReconnectTimer();
    $('reconnect').classList.remove('active');
    backToSetup(`Тебя выгнали: ${r.reason}`);
  });
  sess.onClose(() => { if (fresh() && sessionMode === 'client') beginReconnect(); });
}

// ---------- переподключение клиента ----------

function beginReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  reconnectTries = 0;
  reconnectGen++;          // всё, что было раньше, теперь «прошлая жизнь»
  attemptInFlight = false;
  $('reconnect').classList.add('active');
  $('rec-attempt').textContent = '';
  $('rec-text').textContent = `Хост не отвечает. Твой герой ждёт в комнате ${lastJoin?.code || '—'} — вернись, пока он жив.`;
  scheduleReconnect(600);
}

function stopReconnectTimer() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function reconnectNote(text) {
  const el = $('rec-attempt');
  if (el) el.textContent = text;
}

function scheduleReconnect(delay = 3000) {
  stopReconnectTimer();
  const gen = reconnectGen;
  reconnectTimer = setTimeout(() => tryReconnect(gen), delay);
}

async function tryReconnect(gen) {
  if (!reconnecting || !lastJoin || gen !== reconnectGen || attemptInFlight) return;
  attemptInFlight = true;
  reconnectTries++;
  reconnectNote(`попытка ${reconnectTries}…`);
  let link;
  try {
    link = await createHybridClientLink(lastJoin.code, n => { if (gen === reconnectGen) reconnectNote(n); });
  } catch (e) {
    attemptInFlight = false;
    if (gen !== reconnectGen || !reconnecting) return;
    reconnectNote(`не вышло: ${e.message}`);
    if (reconnectTries < 20) scheduleReconnect(3500);
    else reconnectNote('хост не вернулся. Нажми «выйти» — и начнём новый забег.');
    return;
  }
  attemptInFlight = false;
  if (gen !== reconnectGen || !reconnecting) { try { link.close(); } catch { /* ignore */ } return; }

  // старый линк закрываем: иначе в комнате висят два «одних и тех же» игрока
  if (clientLink && clientLink !== link) { try { clientLink.close(); } catch { /* ignore */ } }
  clientLink = link;
  const sess = createClientSession({ link, name: lastJoin.name });
  clientSession = sess;
  wireClientSession(sess, lastJoin.code, lastJoin.name, gen);
  sess.hello(lastJoin.heroIdx);
  // если welcome не пришёл — не зависаем, пробуем ещё раз
  setTimeout(() => { if (reconnecting && gen === reconnectGen) scheduleReconnect(2500); }, 8000);
}

function finishReconnect() {
  reconnecting = false;
  attemptInFlight = false;
  stopReconnectTimer();
  // поколение НЕ трогаем: текущая сессия должна продолжать получать снапшоты.
  // Старые линки и так молчат — их gen остался позади после beginReconnect().
  $('reconnect').classList.remove('active');
  if (typer) logEvent('system', '✦ Связь восстановлена. Герой на месте — продолжаем.');
}

function leaveReconnect() {
  reconnecting = false;
  attemptInFlight = false;
  stopReconnectTimer();
  reconnectGen++;
  $('reconnect').classList.remove('active');
  if (clientLink) { try { clientLink.close(); } catch { /* ignore */ } }
  backToSetup('Ты вышел из партии. Герой остался в подземелье — и вряд ли дождётся.');
}

function backToSetup(note) {
  sessionMode = 'solo';
  hostSession = null;
  clientSession = null;
  if (clientLink) { try { clientLink.close(); } catch { /* ignore */ } clientLink = null; } // сокет не должен жить своей жизнью
  mySnapshot = null;
  reconnecting = false;
  attemptInFlight = false;
  reconnectGen++;
  stopReconnectTimer();
  $('reconnect').classList.remove('active');
  showScreen('screen-setup');
  $('lobby-panel').style.display = 'none';
  $('btn-start').disabled = false;
  $('btn-start').textContent = '▶ НАЧАТЬ ЗАБЕГ';
  $('btn-launch').style.display = 'none';
  renderHof();
  refreshContinue();
  if (note) addSetupNote(note);
}

// ---------- общий рендер из снапшота (хост+клиент в копе) ----------

function applySnapshot(snap) {
  mySnapshot = snap;
  renderStatsSnap($('stats'), snap);
  renderMiniMapSnap($('map-mini'), snap, vis.glyphs);
  renderQuests($('quest-list'), snap);
  refreshAbilityBtn();
  refreshInventory();
  refreshShop();
  renderCombat($('combat-panel'), snap.combat || []);
  $('floor-label').textContent = `${snap.floorName} · комната ${roomCode || ''}`
    + (snap.story && !snap.over ? ` · ⚜ АКТ ${snap.story.act}/${snap.story.acts}: ${snap.story.villain}` : '');
  const hero = snap.heroes[snap.you];
  if (!hero) return; // битый снапшот не должен ронять UI
  const myTurn = !snap.over && hero.alive && snap.turnOf === snap.you;
  // сигнал «твой ход»
  if (myTurn && !wasMyTurn) turnSound();
  wasMyTurn = myTurn;
  if (snap.over) {
    $('turn-banner').textContent = snap.won ? '⚜ ПОБЕДА — злодей повержен' : '☠ ПАРТИЯ УНИЧТОЖЕНА';
    $('turn-banner').classList.remove('mine');
    typer.onFinish(() => showDeathSnap(snap));
  } else if (!hero.alive) {
    $('turn-banner').textContent = '☠ ТЫ МЁРТВ — наблюдаешь за партией';
    $('turn-banner').classList.remove('mine');
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
    `  последние ${chronicle.length} событий`,
    '═'.repeat(60),
    ''
  ].join('\n');
  const body = chronicle.join('\n');
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
  if (reconnecting) return; // пока нет связи, команду отправить некуда
  if (sessionMode === 'solo') {
    if (!state || state.over) return;
    $('input').value = '';
    inputHistory.push(text);
    historyIdx = inputHistory.length;
    blip(520);
    if (tryCoffee(text)) return;
    logEvent('player', `> ${text}`);
    const events = applyIntent(state, parseCommand(text, state.player?.ability?.name || null));
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
    // глифы карты меняются на месте: перерисовываем мини-карту, не дожидаясь хода
    if (sessionMode === 'solo' && state) renderMiniMap($('map-mini'), state, vis.glyphs);
    else if (mySnapshot) renderMiniMapSnap($('map-mini'), mySnapshot, vis.glyphs);
  };
  ['vis-theme', 'vis-glyphs', 'vis-flicker', 'vis-vol', 'vis-mute'].forEach(id =>
    $(id).addEventListener('change', update)
  );
}

/** Настройка своего TURN-сервера: без него кооп работает только в одной сети. */
function wireNetSettings() {
  const input = $('net-turn');
  const note = $('net-turn-note');
  const cur = loadCustomTurn();
  if (cur) {
    input.value = `${cur.urls.join(',')}|${cur.username}|${cur.credential}`;
    note.textContent = 'TURN вписан — кооп сможет пробивать NAT между разными сетями.';
  }
  input.addEventListener('change', () => {
    const res = saveCustomTurn(input.value);
    if (!res.ok) {
      note.textContent = res.error;
      return;
    }
    note.textContent = res.turn
      ? 'TURN сохранён. Вступит в силу при следующем подключении к комнате.'
      : 'Очищено — используется только STUN (кооп только в одной сети).';
  });

  const relayInput = $('net-relay');
  const relayNote = $('net-relay-note');
  // Ссылку с ?relay= хост отправляет другу один раз — запоминаем, чтобы
  // после перезагрузки страницы канал остался тем же.
  const fromQuery = relayBrokerOverride();
  if (fromQuery) saveRelayUrl(fromQuery.split(',')[0].trim());
  const savedRelay = loadRelayUrl();
  if (savedRelay) relayInput.value = savedRelay;
  relayInput.addEventListener('change', () => {
    const res = saveRelayUrl(relayInput.value);
    if (!res.ok) { relayNote.textContent = res.error; return; }
    relayNote.textContent = res.url
      ? 'Релей сохранён. Вступит в силу при следующем подключении к комнате.'
      : 'Очищено — используются публичные брокеры (нестабильны).';
  });
}

/** Опция «терминатор» появляется после 10 смертей в зале славы. */
function refreshThemeOptions() {
  const sel = $('vis-theme');
  const existing = [...sel.options].find(o => o.value === 'terminator');
  const unlocked = deathCount() >= TERMINATOR_AFTER;
  if (unlocked) {
    if (!existing) {
      const opt = document.createElement('option');
      opt.value = 'terminator';
      opt.textContent = '■ ТЕРМИНАТОР (секретная)';
      sel.appendChild(opt);
    } else if (existing.disabled) {
      // разблокировалось прямо в этой сессии: иначе пункт остаётся серым до перезагрузки
      existing.disabled = false;
      existing.textContent = '■ ТЕРМИНАТОР (секретная)';
    }
  } else if (!existing) {
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
  wireNetSettings();
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

  // свои классы: конструктор
  renderCustomClasses();
  $('btn-class-new').addEventListener('click', () => {
    const f = $('custom-class-form');
    f.style.display = f.style.display === 'none' || !f.style.display ? 'block' : 'none';
    if (f.style.display === 'block') $('cc-name').focus();
  });
  $('btn-cc-save').addEventListener('click', saveCustomClass);
  $('btn-cc-cancel').addEventListener('click', () => { $('custom-class-form').style.display = 'none'; });

  // предыстория: генерация + ручные правки (сохраняются локально)
  try {
    const savedBs = localStorage.getItem('dnd_backstory');
    if (savedBs) $('set-backstory').value = savedBs.slice(0, 2400);
  } catch { /*ignore*/ }
  updateBackstoryCount();
  $('set-backstory').addEventListener('input', () => {
    updateBackstoryCount();
    try { localStorage.setItem('dnd_backstory', $('set-backstory').value); } catch { /*ignore*/ }
  });
  $('btn-backstory').addEventListener('click', generateBackstory);

  // кнопка способности: клик = применить умение класса
  $('ability-btn').addEventListener('click', () => {
    const a = sessionMode === 'solo' ? state?.player?.ability : mySnapshot?.self?.ability;
    if (!a || !a.active) return;
    $('input').value = a.name;
    submitInput();
  });

  // рюкзак: клик по кнопке = обычная команда «выпить …» / «надеть …»
  $('inv-list').addEventListener('click', e => {
    const btn = e.target.closest('.inv-btn');
    if (!btn) return;
    const items = sessionMode === 'solo' ? state?.player?.inventory : mySnapshot?.self?.inventory;
    const item = items && items[Number(btn.dataset.i)];
    if (!item) return;
    $('input').value = `${btn.dataset.act} ${item.name}`;
    submitInput();
  });
  $('btn-start').addEventListener('click', () => {
    const mp = $('set-mp').value;
    if (mp === 'host') startHostRoom();
    else if (mp === 'join') joinRoom();
    else startSolo();
  });
  $('btn-launch').addEventListener('click', hostLaunch);
  $('btn-export').addEventListener('click', exportChronicle);
  $('btn-chronicle').addEventListener('click', exportChronicle);
  $('btn-continue').addEventListener('click', continueRun);
  $('btn-discard').addEventListener('click', () => {
    dropSave();
    addSetupNote('Незаконченный забег удалён. Никто не заметит.');
  });

  // торговец: клик по «купить» = обычная команда движку
  $('shop-list').addEventListener('click', e => {
    const btn = e.target.closest('.shop-btn');
    if (!btn) return;
    const m = sessionMode === 'solo' ? state?.merchant : mySnapshot?.merchant;
    const item = m && m.stock[Number(btn.dataset.i)];
    if (!item) return;
    $('input').value = `купить ${item.name}`;
    submitInput();
  });

  // переподключение
  $('btn-reconnect').addEventListener('click', () => {
    if (!reconnecting) { beginReconnect(); return; }
    reconnectTries = 0;
    scheduleReconnect(150);
  });
  $('btn-rec-leave').addEventListener('click', leaveReconnect);
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
  refreshContinue();
  showScreen('screen-setup');
}

wire();

// отладочные хуки для e2e-тестов: доступ к живому состоянию и к сети
if (typeof window !== 'undefined') {
  window.__dndState = () => state || null;
  window.__snap = () => mySnapshot;
  window.__session = () => ({
    mode: sessionMode,
    room: roomCode,
    reconnecting,
    absent: hostSession?.getAbsent?.() || [],
    lobby: hostSession?.getLobby?.() || []
  });
  // имитация обрыва связи: закрываем линк, как будто пропал Wi-Fi
  window.__drop = () => {
    try { clientLink?.close(); } catch { /* ignore */ }
    clientSession?.notifyTransportLoss?.();
  };
}
