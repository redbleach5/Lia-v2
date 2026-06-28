// Fact extraction — извлечение фактов из диалога через LLM.
//
// Вызывается после каждого ответа Лии (в onFinish callback chat route).
// Использует отдельный LLM-вызов с жёстким JSON-промптом:
//   "Извлеки факты из этого диалога в формате key:value"
//
// Глобальные факты (user.name, user.profession) — переживают смену чата.
// Эпизодные факты (current_project, topic) — только для этого чата.
//
// Чтобы не делать LLM-вызов на каждое сообщение (дорого), используется
// эвристика: извлекаем только если сообщение содержит "меня зовут",
// "я работаю", "мой проект" и подобные паттерны, ИЛИ если сообщение
// длиннее 200 символов (возможно содержит контекст).

import { streamText } from 'ai';
import { getChatModel } from '@/lib/ollama';
import { upsertGlobalFact, upsertEpisodeFact } from './facts';
import { logger } from '@/lib/logger';

// ============================================================================
// Эвристика — стоит ли извлекать факты из этого сообщения
// ============================================================================
const FACT_TRIGGER_PATTERNS = [
  // Имя, профессия, личное
  /\b(меня зовут|моё имя|я [\wа-яё]+,? а ты|зови меня)\b/iu,
  /\b(я работаю|я учусь|моя профессия|по профессии)\b/iu,
  /\b(мне \d+ лет|мне исполнилось)\b/iu,
  // Проекты, контекст
  /\b(мой проект|я делаю|я пишу|я разрабатываю|мы работаем над)\b/iu,
  /\b(использую|пишу на|язык программирования|фреймворк)\b/iu,
  // Предпочтения
  /\b(мне нравится|я люблю|не люблю|предпочитаю|мой любимый)\b/iu,
  // Цели, задачи
  /\b(моя цель|я хочу сделать|планирую|задача —)\b/iu,
];

const MIN_LENGTH_FOR_EXTRACTION = 200;

function shouldExtractFacts(userMessage: string): boolean {
  // Короткие сообщения типа "привет" / "да" / "спасибо" — не извлекаем
  if (userMessage.length < 30) return false;
  // Длинные сообщения — возможно содержат контекст
  if (userMessage.length > MIN_LENGTH_FOR_EXTRACTION) return true;
  // Проверяем триггер-паттерны
  return FACT_TRIGGER_PATTERNS.some(re => re.test(userMessage));
}

// ============================================================================
// Промпт для извлечения фактов
// ============================================================================
const EXTRACTION_PROMPT = `Проанализируй диалог между пользователем и ассистентом Лией.
Извлеки ФАКТЫ — устойчивую информацию о пользователе и контексте.

Правила:
1. Только ФАКТЫ, не интерпретации. "Меня зовут Иван" → user.name: Иван. Не "пользователь представился".
2. Глобальные факты (профиль пользователя): префикс "user."
   - user.name — имя
   - user.profession — профессия
   - user.age — возраст
   - user.favorite_language — любимый язык программирования
   - user.location — где живёт
3. Эпизодные факты (контекст текущего чата): префикс "current."
   - current.project — над чем работает
   - current.task — что делает сейчас
   - current.topic — тема обсуждения
   - current.tech_stack — используемые технологии
4. Не выдумывай факты. Если информации нет — не включай.
5. Если факт уже известен и не изменился — не дублируй.
6. Формат: строго JSON {"global": {"key": "value", ...}, "episode": {"key": "value", ...}}
7. Если фактов нет — верни {"global": {}, "episode": {}}

Диалог:
Пользователь: {USER_MSG}
Лия: {LIA_MSG}

Извлеки факты (JSON):`;

// ============================================================================
// Извлечь факты из диалога и сохранить в БД
// ============================================================================
export async function extractAndSaveFacts(params: {
  userMessage: string;
  liaMessage: string;
  episodeId: string;
}): Promise<{ globalCount: number; episodeCount: number }> {
  const { userMessage, liaMessage, episodeId } = params;

  // Эвристика — не делаем LLM-вызов на каждое сообщение
  if (!shouldExtractFacts(userMessage)) {
    return { globalCount: 0, episodeCount: 0 };
  }

  try {
    const model = await getChatModel();
    const prompt = EXTRACTION_PROMPT
      .replace('{USER_MSG}', userMessage.slice(0, 1000))
      .replace('{LIA_MSG}', liaMessage.slice(0, 500));

    const result = streamText({
      model,
      system: 'Ты — модуль извлечения фактов. Возвращай только валидный JSON, без markdown.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1, // низкая температура — детерминированность
      maxOutputTokens: 300,
    });

    const text = await result.text;

    // Парсим JSON — модель может обернуть в markdown fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { globalCount: 0, episodeCount: 0 };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      global?: Record<string, string>;
      episode?: Record<string, string>;
    };

    let globalCount = 0;
    let episodeCount = 0;

    // Сохраняем глобальные факты
    if (parsed.global && typeof parsed.global === 'object') {
      for (const [key, value] of Object.entries(parsed.global)) {
        if (typeof value === 'string' && value.trim().length > 0 && value.trim().length < 500) {
          await upsertGlobalFact(`user.${key}`, value.trim());
          globalCount++;
        }
      }
    }

    // Сохраняем эпизодные факты
    if (parsed.episode && typeof parsed.episode === 'object') {
      for (const [key, value] of Object.entries(parsed.episode)) {
        if (typeof value === 'string' && value.trim().length > 0 && value.trim().length < 500) {
          await upsertEpisodeFact(episodeId, `current.${key}`, value.trim());
          episodeCount++;
        }
      }
    }

    if (globalCount + episodeCount > 0) {
      logger.info('memory', `Facts extracted`, { globalCount, episodeCount });
    }

    return { globalCount, episodeCount };
  } catch (e) {
    logger.warn('memory', 'extraction failed (non-fatal)', {}, e);
    return { globalCount: 0, episodeCount: 0 };
  }
}
