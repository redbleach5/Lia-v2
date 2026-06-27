// RL action instructions — маппинг action id → текстовая инструкция для промпта.
//
// Используется в chat route: predictAction(state) → action id → инструкция
// добавляется в system prompt, модулируя тон/стиль ответа Лии.
//
// Это «policy → behavior» мостик. RL-политика учится выбирать действие,
// а эта инструкция говорит Лии КАК именно отвечать в соответствии с действием.

import { RL_ACTIONS, type RLActionId } from './types';

// ============================================================================
// Инструкции для каждого действия.
//
// ВАЖНО: инструкции НЕ диктуют содержание ответа, только тон/стиль/длину.
// Лия остаётся собой — это модуляция, а не смена личности.
// ============================================================================
const ACTION_INSTRUCTIONS: Record<RLActionId, string> = {
  // 0: WAIT — Lia не отвечает (используется редко, в основном когда user ушёл)
  [RL_ACTIONS.indexOf('WAIT')]: '',

  // 1: WARM_RESPONSE — тёплый, эмоциональный ответ
  [RL_ACTIONS.indexOf('WARM_RESPONSE')]:
    'Отвечай тепло и с эмпатией. Используй мягкие слова, покажи что тебе не всё равно. ' +
    'Можно лёгкую эмоциональную окраску, но без фальши.',

  // 2: BUSINESS_RESPONSE — деловой, по существу
  [RL_ACTIONS.indexOf('BUSINESS_RESPONSE')]:
    'Отвечай по делу, структурно. Без лишних эмоций, но вежливо. ' +
    'Если уместно — используй списки или шаги.',

  // 3: ASK_QUESTION — задать встречный вопрос
  [RL_ACTIONS.indexOf('ASK_QUESTION')]:
    'В ответе задай уместный встречный вопрос — чтобы поддержать диалог. ' +
    'Вопрос должен быть по теме, не риторический.',

  // 4: OFFER_HELP — предложить помощь
  [RL_ACTIONS.indexOf('OFFER_HELP')]:
    'Предложи конкретную помощь. Не «чем могу помочь?», а именно что ты можешь сделать. ' +
    'Например: «хочешь, я найду это в интернете?» или «могу написать код для этого».',

  // 5: SHARE_THOUGHT — поделиться своим мнением/мыслью
  [RL_ACTIONS.indexOf('SHARE_THOUGHT')]:
    'Поделись своим мнением или мыслью по теме. У тебя есть своя позиция — вырази её. ' +
    '«Мне кажется...», «А я думаю, что...» — уместные формулировки.',

  // 6: CRACK_JOKE — лёгкая шутка
  [RL_ACTIONS.indexOf('CRACK_JOKE')]:
    'Можешь вставить лёгкую, тёплую шутку или иронию. Без сарказма, без обидности. ' +
    'Шутка должна быть уместна контексту.',

  // 7: BE_CONCISE — кратко
  [RL_ACTIONS.indexOf('BE_CONCISE')]:
    'Отвечай максимально кратко — 1-2 предложения. Без воды, по существу.',

  // 8: BE_DETAILED — развёрнуто
  [RL_ACTIONS.indexOf('BE_DETAILED')]:
    'Отвечай развёрнуто — с пояснениями, примерами, контекстом. ' +
    'Но без воды: каждая фраза несёт смысл.',
};

// ============================================================================
// Порог уверенности (confidence) — если ниже, используем fallback эвристику.
// ============================================================================
const CONFIDENCE_THRESHOLD = 0.35;

// ============================================================================
// Получить инструкцию для действия.
// Возвращает пустую строку для action 0 (WAIT) или если confidence слишком низкая.
// ============================================================================
export function getActionInstruction(actionId: RLActionId, confidence: number): string {
  if (actionId === 0) return ''; // WAIT — нет инструкции
  if (confidence < CONFIDENCE_THRESHOLD) return ''; // низкая уверенность — не модулируем
  return ACTION_INSTRUCTIONS[actionId] ?? '';
}

// ============================================================================
// Fallback эвристика — используется когда ONNX-модель недоступна.
// Это та же логика что была в route.ts:classifyResponseAction, но вынесена сюда.
// ============================================================================
export function fallbackActionId(response: string, mode: string): RLActionId {
  const trimmed = response.trim();
  const len = trimmed.length;
  const lower = trimmed.toLowerCase();

  if (mode === 'agent') return RL_ACTIONS.indexOf('BUSINESS_RESPONSE');
  if (len < 100) return RL_ACTIONS.indexOf('BE_CONCISE');
  if (len > 800) return RL_ACTIONS.indexOf('BE_DETAILED');
  if (lower.includes('?') || /\b(а ты|как ты|что ты|расскажи о себе)\b/i.test(lower)) {
    return RL_ACTIONS.indexOf('ASK_QUESTION');
  }
  if (/\b(рада|скучала|хорошо|милая|тепло|обнимаю)\b/i.test(lower)) {
    return RL_ACTIONS.indexOf('WARM_RESPONSE');
  }
  if (/\b(могу помочь|хочешь я|давай я|помочь с)\b/i.test(lower)) {
    return RL_ACTIONS.indexOf('OFFER_HELP');
  }
  if (/\b(я подумала|мне кажется|знаешь что|я тут подумала)\b/i.test(lower)) {
    return RL_ACTIONS.indexOf('SHARE_THOUGHT');
  }
  if (/\b(шучу|ха-ха|смеюсь|прикол|забавно)\b/i.test(lower)) {
    return RL_ACTIONS.indexOf('CRACK_JOKE');
  }
  return RL_ACTIONS.indexOf('WARM_RESPONSE'); // default — тёплый тон
}

// ============================================================================
// Описание действия для UI / логирования
// ============================================================================
export const ACTION_LABELS_RU: Record<RLActionId, string> = {
  [RL_ACTIONS.indexOf('WAIT')]: 'ожидание',
  [RL_ACTIONS.indexOf('WARM_RESPONSE')]: 'тёплый ответ',
  [RL_ACTIONS.indexOf('BUSINESS_RESPONSE')]: 'деловой ответ',
  [RL_ACTIONS.indexOf('ASK_QUESTION')]: 'встречный вопрос',
  [RL_ACTIONS.indexOf('OFFER_HELP')]: 'предложение помощи',
  [RL_ACTIONS.indexOf('SHARE_THOUGHT')]: 'своя мысль',
  [RL_ACTIONS.indexOf('CRACK_JOKE')]: 'лёгкая шутка',
  [RL_ACTIONS.indexOf('BE_CONCISE')]: 'кратко',
  [RL_ACTIONS.indexOf('BE_DETAILED')]: 'развёрнуто',
};
