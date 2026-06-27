// Эмоции Lia — 5-осевая модель.
// БЕЗ LLM-классификации: rule-based perceive + экспоненциальный decay к baseline.
//
// Это чинит багу LIA v1, где LLM-вызов classify.yml часто ошибался
// (например, помечал "купи молоко" как rudeness) и загрязнял эмоциональное состояние.

import { LIA_PERSONALITY, type EmotionVector, type EmotionAxis } from './personality';

export function createInitialEmotion(): EmotionVector {
  return { ...LIA_PERSONALITY.baselineEmotion };
}

// ============================================================================
// Rule-based perceive — what does Lia FEEL given a user message?
// ============================================================================
//
// Эвристики (Cyrillic-safe regex). БЕЗ LLM-вызова.
// На каждый trigger — детерминированный delta к эмоциям.

type Trigger =
  | 'warmth'
  | 'rudeness'
  | 'sadTopic'
  | 'enthusiasm'
  | 'curiosity'
  | 'deepQuestion'
  | 'disagreement'
  | 'task'
  | 'trivial';

const TRIGGERS: Array<{ name: Trigger; regex: RegExp; weight: number }> = [
  // грубость — только настоящие оскорбления
  { name: 'rudeness', regex: /(?:^|[^a-zа-яё0-9_])(иди|отстань|заткнис|дурак|тупой|раздражаешь|бесишь|чушь|бред|хрень|идиот|придурок|урод|сволочь|нахуй|пизд|ебан|сука)(?![a-zа-яё0-9_])/iu, weight: 0.9 },

  // грустные темы
  { name: 'sadTopic', regex: /(умер|погиб|похорон|боле|рак|депресс|одинок|бросил|бросила|развод|умира|тяжело|не могу больше|устал жить)/i, weight: 0.8 },

  // энтузиазм
  { name: 'enthusiasm', regex: /(обожаю|получилось|ура|класс|супер|потрясающе|вау|шикарно|обалденно)/i, weight: 0.85 },

  // любопытство
  { name: 'curiosity', regex: /(почему|как устроен|как работает|откуда|зачем нужно|что будет если)/i, weight: 0.7 },

  // глубокие вопросы
  { name: 'deepQuestion', regex: /(в чём смысл|что такое.*на самом деле|существует ли|свобода воли|сознани|бессмерти|душа|бог|смерть|добро и зло)/i, weight: 0.85 },

  // тепло
  { name: 'warmth', regex: /(спасибо|благодар|доброе утро|добрый день|добрый вечер|привет|скучал|рад видеть|люблю тебя)/i, weight: 0.6 },

  // несогласие
  { name: 'disagreement', regex: /(не согласен|не согласна|ты неправ|ошибаешься|это не так|не верю|ерунда это)/i, weight: 0.65 },

  // задача — Lia любит помогать
  { name: 'task', regex: /(найди|поиск|загугли|создай|напиши|сделай|нарисуй|сгенерируй|проанализируй|проверь|обнови|исправь|оптимизируй|рефактор)/i, weight: 0.75 },

  // тривиальные вопросы
  { name: 'trivial', regex: /^(привет|как дела|что делаешь|как ты|приветик)\??\.?$/i, weight: 0.4 },
];

const EMOTION_DELTAS: Record<Trigger, Partial<EmotionVector>> = {
  warmth:       { joy: +0.20, calm: +0.15, irritation: -0.15, sadness: -0.10 },
  rudeness:     { irritation: +0.30, joy: -0.20, calm: -0.20, sadness: +0.10 },
  sadTopic:     { sadness: +0.30, joy: -0.20, calm: -0.10, curiosity: +0.05 },
  enthusiasm:   { joy: +0.25, curiosity: +0.10, calm: -0.05 },
  curiosity:    { curiosity: +0.20, joy: +0.05 },
  deepQuestion: { curiosity: +0.25, joy: +0.10, irritation: -0.10 },
  disagreement: { curiosity: +0.15, irritation: +0.05, calm: -0.05 },
  task:         { curiosity: +0.15, joy: +0.05 },
  trivial:      { curiosity: -0.05, irritation: +0.02 },
};

export function perceive(text: string, current: EmotionVector): {
  emotion: EmotionVector;
  triggers: Trigger[];
} {
  let emotion = { ...current };
  const triggers: Trigger[] = [];

  for (const { name, regex, weight } of TRIGGERS) {
    if (regex.test(text)) {
      triggers.push(name);
      const delta = EMOTION_DELTAS[name];
      for (const axis in delta) {
        const a = axis as EmotionAxis;
        emotion[a] = clamp(emotion[a] + (delta[a] ?? 0) * weight);
      }
    }
  }

  return { emotion, triggers };
}

// ============================================================================
// Decay — exponential toward baseline per minute
// ============================================================================
const DECAY_PER_MIN = 0.02;

export function decayEmotion(current: EmotionVector, dtMinutes: number): EmotionVector {
  const factor = Math.exp(-DECAY_PER_MIN * dtMinutes);
  const baseline = LIA_PERSONALITY.baselineEmotion;
  return {
    joy:        blendToward(current.joy, baseline.joy, factor),
    curiosity:  blendToward(current.curiosity, baseline.curiosity, factor),
    calm:       blendToward(current.calm, baseline.calm, factor),
    irritation: blendToward(current.irritation, baseline.irritation, factor),
    sadness:    blendToward(current.sadness, baseline.sadness, factor),
  };
}

function blendToward(current: number, baseline: number, factor: number): number {
  return clamp(current * factor + baseline * (1 - factor));
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// ============================================================================
// Textual description for the prompt
// ============================================================================
export function emotionToText(e: EmotionVector): string {
  const parts: string[] = [];
  if (e.joy > 0.7) parts.push('радость');
  else if (e.joy < 0.3) parts.push('грусть');

  if (e.curiosity > 0.7) parts.push('любопытство');
  if (e.irritation > 0.5) parts.push('лёгкое раздражение');
  if (e.calm > 0.7) parts.push('спокойствие');
  if (e.sadness > 0.5) parts.push('грусть');

  if (parts.length === 0) return 'нейтральное настроение';
  return parts.join(', ');
}

export function dominantEmotion(e: EmotionVector): EmotionAxis {
  let max: EmotionAxis = 'joy';
  let maxVal = -Infinity;
  for (const axis of ['joy', 'curiosity', 'calm', 'irritation', 'sadness'] as EmotionAxis[]) {
    if (e[axis] > maxVal) {
      maxVal = e[axis];
      max = axis;
    }
  }
  return max;
}
