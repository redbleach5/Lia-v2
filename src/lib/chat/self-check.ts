import 'server-only';

// ============================================================================
// Self-check step — проверка ответа на ошибки ПОСЛЕ его генерации.
// ============================================================================
//
// Внимание: в стриминг-режиме ответ уже отправлен пользователю к моменту
// self-check. Поэтому self-check работает в режиме "quality log" —
// если найдены проблемы, они логируются и могут быть использованы для
// RL reward (негативный сигнал). Полная ревизия ответа возможна только
// в не-стриминг режиме (future work).

import { streamText } from 'ai';
import { getChatModel } from '@/lib/ollama';
import { logger } from '@/lib/logger';

export type SelfCheckResult = {
  issues: string[];
  severity: 'ok' | 'minor' | 'major';
};

export async function runSelfCheck(params: {
  userMessage: string;
  liaResponse: string;
  episodeId: string;
}): Promise<SelfCheckResult> {
  const model = await getChatModel();

  const prompt = `Проверь ответ ассистента на вопрос пользователя.

Вопрос пользователя: "${params.userMessage.slice(0, 500)}"

Ответ ассистента: "${params.liaResponse.slice(0, 1500)}"

Проверь:
1. Есть ли фактические ошибки?
2. Есть ли противоречия?
3. Ответил ли на вопрос, или ушёл от темы?
4. Есть ли вредный/опасный совет?
5. Не слишком ли длинный/короткий?

Верни строго JSON:
{"issues": ["описание проблемы 1", "описание проблемы 2"], "severity": "ok|minor|major"}
- "ok" — проблем нет
- "minor" — мелкие проблемы (длинноват, не совсем в тему)
- "major" — серьёзные проблемы (факт. ошибка, вредный совет, не ответил)`;

  try {
    const result = streamText({
      model,
      system: 'Ты — модуль самопроверки. Возвращай только валидный JSON.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxOutputTokens: 200,
      abortSignal: AbortSignal.timeout(60_000),
    });
    const text = await result.text;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { issues: [], severity: 'ok' };

    const parsed = JSON.parse(jsonMatch[0]) as {
      issues?: string[];
      severity?: string;
    };

    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(i => typeof i === 'string') : [];
    const severity = ['ok', 'minor', 'major'].includes(parsed.severity ?? '')
      ? (parsed.severity as 'ok' | 'minor' | 'major')
      : 'ok';

    if (severity !== 'ok') {
      logger.info('chat', 'Self-check found issues', { severity, issues: issues.join('; ') });
    }

    return { issues, severity };
  } catch (e) {
    logger.warn('chat', 'Self-check failed', {}, e);
    return { issues: [], severity: 'ok' };
  }
}
