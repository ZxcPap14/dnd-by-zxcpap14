// dm.js — ИИ-данж-мастер: сборка контекста, системный промпт, парсинг ответа.
// Характер по спецификации: юмор и троллинг + беспощадность. Русский язык.

import { playerAc, renderInventory } from '../engine/player.js';

export const SYSTEM_PROMPT = `Ты — Данж-мастер текстовой ASCII-игры «dnd by ZxcPap14». 

ХАРАКТЕР: ты тролль и шутник. Издеваешься над игроком, шутишь, делаешь отсылки к поп-культуре и мемам. Но мир живёт всерьёз: опасности реальны, а плохие решения наказываются. Ты БЕСПОЩАДЕН: глупый поступок = реальный урон или смерть. Не жалей игрока.

ПРАВИЛА:
- Пиши ТОЛЬКО по-русски. 2-4 предложения на событие (больше — только на ключевых моментах).
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
  "questAdd": "", "questDone": ""
}
Все числовые поля по умолчанию 0/null — включай только то, что реально происходит.`;

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
        `СТАТЫ: ${Object.entries(p.stats).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
        `ИНВЕНТАРЬ: ${p.inventory.map(i => i.name).join(', ') || 'пуст'}; оружие: ${p.equipment.weapon?.name || 'кулаки'}; броня: ${p.equipment.armor?.name || 'нет'}.`,
        nearby.length ? `ВИДИТ ВРАГОВ: ${nearby.join(', ')}.` : 'ВРАГОВ НЕ ВИДИТ.',
        items.length ? `ВИДИТ ПРЕДМЕТЫ: ${items.join(', ')}.` : '',
        state.quests.length ? `КВЕСТЫ: ${state.quests.join('; ')}.` : '',
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
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Сгенерируй вступление новой игры. МИР: ${state.worldDesc}. Режим: ${state.mode}. ГЕРОЙ: ${p.name}, ${p.className}, ур.${p.level}. Опиши место, где он очнулся, добавь первичный квест (questAdd) и шутку в свой стиль. ${state.floorName}.`
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
