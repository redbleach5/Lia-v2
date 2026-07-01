import 'server-only';

// ============================================================================
// Deliberate step — internal analysis before responding.
// ============================================================================
//
// Запускается ДО основного streamText, если plan.deliberate = true.
// Результат добавляется в system prompt как "ВНУТРЕННИЙ АНАЛИЗ".

import { streamText } from 'ai';
import { getChatModel } from '@/lib/ollama';
import { logger } from '@/lib/logger';
import type { EmotionVector } from '@/lib/personality';

export async function runDeliberate(userMessage: string, _emotion: EmotionVector, _tier: string): Promise<string> {
  const model = await getChatModel();

  const prompt = `Проанализируй вопрос собеседника перед ответом.

Вопрос: "${userMessage}"

Что важно учесть:
- Какие аспекты вопроса есть?
- Какие скрытые предположения?
- Какие рамки/контекст применимы?
- Что может быть упущено в поспешном ответе?

Дай краткий внутренний анализ (3-5 предложений). Не отвечай на вопрос — только проанализируй.`;

  try {
    const result = streamText({
      model,
      system: 'Ты — внутренний аналитический модуль Лии. Анализируй вопрос, не отвечай на него.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxOutputTokens: 400,
      abortSignal: AbortSignal.timeout(60_000),
    });
    return await result.text;
  } catch (e) {
    logger.warn('chat', 'Deliberate step failed', {}, e);
    return '';
  }
}
