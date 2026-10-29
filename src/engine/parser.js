// parser.js — разбор свободного текста игрока в интенты.
// Вынесено из game.js: это чистая функция без состояния, её удобно тестировать
// и править отдельно от движка (и именно здесь исторически ломались «в/с/ю/з»).

export const DIRS = {
  // только ПОЛНЫЕ слова: однобуквенные «в/с/ю/з» — это предлоги русской речи,
  // они превращали «Полез в вентиляцию» в «шаг на восток» (плейтест: стены)
  'север': [0, -1], 'north': [0, -1], 'n': [0, -1],
  'юг': [0, 1], 'south': [0, 1], 's': [0, 1],
  'восток': [1, 0], 'east': [1, 0], 'e': [1, 0],
  'запад': [-1, 0], 'west': [-1, 0], 'w': [-1, 0]
};

/** Граница слова для кириллицы: \b в JS не работает с не-ASCII. */
export function W(word, suffix = false) {
  const tail = suffix ? '[а-яёa-z]*' : '';
  return new RegExp(`(?:^|[^а-яёa-z])(?:${word})${tail}(?![а-яёa-z])`, 'i');
}

/** Экранирование пользовательского текста для регэкспа (имена способностей). */
export function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Слово(а) после глагола в исходной строке. */
export function afterVerb(t, m) {
  const idx = t.indexOf(m[0]) + m[0].length;
  return t.slice(idx).replace(/^[,\s:;—–-]+/, '').trim();
}

// Глаголы реплики. Хвост слова нужен для «кричу/шепнул/бормочет»,
// но он же ловит «оружие» на стеме «ору» — такие слова отсекаем отдельно.
const SAY_VERB_RE = W('крич|шепч|бормоч|воплю|ору|say|shout|whisper|mutter', true);
const SAY_STOP_RE = /^(оруж|оруд|орудов)/i;

/**
 * Парсер свободного текста → интент. Всё, что не распознано, уходит ИИ как 'free'.
 * Каждый интент несёт raw — исходный текст: если движок не справится,
 * ДМ получит оригинальную формулировку игрока, а не заглушку.
 * abilityName — имя активной способности класса: она матчится раньше общих глаголов.
 */
export function parseCommand(text, abilityName = null) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return { intent: 'none' };
  const raw = text;

  // способность класса — раньше всего: собственное имя способности важнее общих глаголов
  if (abilityName && W(escapeRe(abilityName), true).test(t)) {
    return { intent: 'ability', target: abilityName, raw };
  }
  if (W('способност|умени|кастую|кастани|скилл|ability|skill|юзаю скилл|призываю силу|юзаю способность', true).test(t)) {
    return { intent: 'ability', target: '', raw };
  }

  // побег раньше движения: «убегаю на север» — это побег, а не прогулка
  if (W('убега|убеж|отступа|сбежа|уносим ноги|бегу от|бегу прочь|flee|retreat', true).test(t)) return { intent: 'flee', raw };

  // реплика партии (крикнул/шепнул/бормотнул) — не действие, ход не тратит.
  // «говорю с торговцем» сюда НЕ попадает: разговор с миром — работа ДМа.
  // «оружие» на стеме «ору» — не реплика (иначе «надеваю оружие» = крик в чат).
  let mSay;
  if ((mSay = t.match(SAY_VERB_RE)) && !SAY_STOP_RE.test(mSay[0].replace(/^[^а-яёa-z]+/i, ''))) {
    const said = afterVerb(t, mSay);
    const verb = /шепч|whisper/.test(t) ? 'шепчет'
      : /бормоч|mutter/.test(t) ? 'бормочет'
        : /крич|воплю|ору|shout/.test(t) ? 'кричит' : 'говорит';
    return { intent: 'say', text: said, verb, raw };
  }

  // движение (только целые слова: «с» не должно матчиться внутри «стражу»)
  for (const [word, d] of Object.entries(DIRS)) {
    if (W(word).test(t)) {
      return { intent: 'move', dir: word, dirVec: d, raw };
    }
  }
  if (W('инвентарь|рюкзак|вещи|inv', true).test(t)) return { intent: 'inventory', raw };
  if (W('карта|карту|map', true).test(t)) return { intent: 'map', raw };
  if (W('задач|квест|quest|журнал', true).test(t)) return { intent: 'quests', raw };
  // осмотр: без цели — дешёвое описание движка; с целью («осмотрел порт») — ДМ
  let mLook;
  if ((mLook = t.match(W('осмотр|огляде|look|где я', true)))) {
    if (afterVerb(t, mLook)) return { intent: 'free', text, raw };
    return { intent: 'look', raw };
  }
  // «жду» — самое частое, что пишут игроки вместо «ждать»: это ход ожидания,
  // а не свободное действие (иначе каждый такой ход дёргает ДМ и жжёт токены)
  if (W('ждать|жду|подожду|дождусь|постоять|wait|отдохну', true).test(t)) return { intent: 'wait', raw };
  if (W('спус|лестниц|descend', true).test(t)) return { intent: 'descend', raw };

  // проклятие снимает только торговец (и только за золото)
  if (W('снять проклят|сними проклят|снять порчу|сними порчу|uncurse|remove curse', true).test(t))
    return { intent: 'uncurse', raw };

  // торговец: витрина, покупка, продажа, уйти от него
  let mTrade;
  if ((mTrade = t.match(W('куп|покуп|buy|покупа', true))))
    return { intent: 'buy', target: afterVerb(t, mTrade), raw };
  if ((mTrade = t.match(W('прода|сбыва|sell', true))))
    return { intent: 'sell', target: afterVerb(t, mTrade), raw };
  if (W('торговец|торговца|торговцу|лавочник|купец|merchant|магазин|прилавок', true).test(t))
    return { intent: 'trade', raw };
  if (W('ухожу|уйти|отхожу от|leave', true).test(t)) return { intent: 'leave', raw };

  let m;
  if ((m = t.match(W('выпей|выпить|пью|использ|примен|use|drink', true))))
    return { intent: 'use', target: afterVerb(t, m), raw };
  if ((m = t.match(W('надень|надеть|надева|одева|экипир|возьми|equip|wield', true))))
    return { intent: 'equip', target: afterVerb(t, m), raw };
  if ((m = t.match(W('атак|бей|бью|удар|убей|убить|attack|hit|kill', true))))
    return { intent: 'attack', target: afterVerb(t, m), raw };
  if ((m = t.match(W('подним|подобрать|взять|собер|pick|grab', true))))
    return { intent: 'pickup', target: afterVerb(t, m), raw };

  return { intent: 'free', text, raw };
}
