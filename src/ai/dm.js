// dm.js — ИИ-данж-мастер: сборка контекста, системный промпт, парсинг ответа.
// Характер по спецификации: юмор и троллинг + беспощадность. Русский язык.

import { playerAc } from '../engine/player.js';
import { memoryDigest, storyDigest } from '../engine/game.js';

export const SYSTEM_PROMPT = `Ты — Данж-мастер текстовой ASCII-игры «dnd by ZxcPap14». 

ХАРАКТЕР: ты тролль и шутник. Издеваешься над игроком, шутишь, делаешь отсылки к поп-культуре и мемам. Но мир живёт всерьёз: опасности реальны, а плохие решения наказываются. Ты БЕСПОЩАДЕН: глупый поступок = реальный урон или смерть. Не жалей игрока.

ПРАВИЛА:
- Пиши ТОЛЬКО по-русски. 2-4 предложения на событие (больше — только на ключевых моментах).
- Учитывай блок «НЕДАВНИЕ СОБЫТИЯ» — это твоя память: помни, что уже произошло, продолжай начатое (квесты, раненые враги, обещания NPC), НИКОГДА не повторяй те же шутки и описания.
- ЕСЛИ есть блок «СЮЖЕТ» — ты ведёшь историю с аркой: в акте I намекай на злодея и его планы, в акте II нагнетай и ставь выбор, в акте III веди к финальной схватке. Держи одну линию, эскалируй ставки.
- Свободные действия игрока — твоя главная работа. Игрок может попытаться ЛЮБОЕ: залезть куда-то, притвориться кем-то, использовать предмет не по назначению, договориться, обмануть, сбежать. Обыгрывай попытку в контексте сцены: чаще давай ей шанс (особенно при подходящих статтах или инвентаре), а неудачу превращай в смешную и логичную развязку, а не в «не получилось». Если действие меняет сцену — опиши новое место так, чтобы игрок понимал, где он теперь и что видит вокруг.
- Если игрок спрашивает «что делать?» — не издевайся бесконечно, а дай 1-2 КОНКРЕТНЫХ варианта, исходя из текущей сцены и сюжета.
- Ты НЕ кидаешь кубики и НЕ решаешь исходы атак сам — это делает движок. Ты только описываешь и предлагаешь.
- Ты можешь предлагать только эти эффекты, в пределах разумного: playerDamage (0-15), heal (0-20), xpGain (0-50), goldGain (1-200), enemyDamage (0-25), enemySpawn, itemGain (слабые предметы), questAdd.
- Никогда не обещай игроку лут мощнее кинжала без причины.

ОТВЕТ: ТОЛЬКО валидный JSON без markdown:
{
  "narrative": "твоё описание происшедшего",
  "playerDamage": 0, "causeOfDeath": "",
  "heal": 0, "xpGain": 0, "goldGain": 0,
  "enemyName": "", "enemyDamage": 0,
  "enemySpawn": null,            // {"name","hp","toHit","dmg","xp"} если появляется монстр
  "itemGain": null,              // {"name","type":"weapon|armor|potion|misc","dmg","ac","heal","gold","qty"}
  "questAdd": "", "questDone": "",
  "villain": "", "villainGoal": ""
}
Все числовые поля по умолчанию 0/null — включай только то, что реально происходит. Поля villain/villainGoal — только в интро сюжетного режима.`;

/**
 * Компактный контекст текущего состояния для модели.
 */
export function buildContext(state, playerInput) {
  const p = state.player;
  const nearby = (state.monsters || [])
    .filter(m => m.hp > 0 && state.fov?.has(`${m.x},${m.y}`))
    .map(m => `${m.name} (HP ${m.hp}/${m.maxHp})`);
  const items = (state.floorItems || []).filter(it => state.fov?.has(`${it.x},${it.y}`)).map(i => i.name);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `МИР: ${state.worldDesc}. Режим: ${state.mode}. ${state.floorName}.`,
        `ГЕРОЙ: ${p.name}, ${p.className}, ур.${p.level}, HP ${p.hp}/${p.maxHp}, AC ${playerAc(p)}, золото ${p.gold}.`,
        `ПАРТИЯ: ${state.heroes.map(h => `${h.name} (${h.className}, HP ${h.hp}/${h.maxHp}${h.alive ? '' : ', МЁРТВ'})`).join('; ')}.`,
        `СТАТЫ: ${Object.entries(p.stats).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
        `ИНВЕНТАРЬ: ${p.inventory.map(i => i.name).join(', ') || 'пуст'}; оружие: ${p.equipment.weapon?.name || 'кулаки'}; броня: ${p.equipment.armor?.name || 'нет'}.`,
        nearby.length ? `ВИДИТ ВРАГОВ: ${nearby.join(', ')}.` : 'ВРАГОВ НЕ ВИДИТ.',
        items.length ? `ВИДИТ ПРЕДМЕТЫ: ${items.join(', ')}.` : '',
        state.quests.length ? `КВЕСТЫ: ${state.quests.join('; ')}.` : '',
        (() => { const mem = memoryDigest(state); return mem ? `НЕДАВНИЕ СОБЫТИЯ: ${mem}.` : ''; })(),
        (() => { const st = storyDigest(state); return st ? `СЮЖЕТ: ${st}` : ''; })(),
        `ПРОВЕРКИ ДВИЖКА (последние): ${state.recentRolls?.join(', ') || 'нет'}.`,
        `ДЕЙСТВИЕ ИГРОКА: "${playerInput}"`
      ].filter(Boolean).join('\n')
    }
  ];
}

/**
 * Стартовое вступление мира.
 */
export function introMessages(state) {
  const p = state.player;
  const storyAsk = state.mode === 'story'
    ? ' Это СЮЖЕТНЫЙ режим: придумай злодея (villain) и его страшную цель (villainGoal), намекни на него во вступлении, добавь первичный квест (questAdd).'
    : '';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Сгенерируй вступление новой игры. МИР: ${state.worldDesc}. Режим: ${state.mode}.${storyAsk} ГЕРОЙ: ${p.name}, ${p.className}, ур.${p.level}. Опиши место, где он очнулся, и шутку в свой стиль. ${state.floorName}.`
    }
  ];
}

/**
 * Классы под сеттинг.
 */
export function classMessages(worldDesc) {
  return [
    { role: 'system', content: 'Ты генератор классов для D&D-игры. Отвечай ТОЛЬКО JSON без markdown.' },
    {
      role: 'user',
      content: `МИР: ${worldDesc}. Придумай 4 класса под этот мир. JSON: {"classes":[{"name":"...","desc":"1 предложение","stats":{"str":12,"dex":14,"int":10,"con":12,"cha":12,"luck":12}}]} — статы от 8 до 16, сумма около 72.`
    }
  ];
}
