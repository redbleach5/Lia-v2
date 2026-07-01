import 'server-only';

// ============================================================================
// isRepeatedMessage — detection повторяющихся сообщений пользователя.
// ============================================================================
//
// Используется в RL reward signal (wasRepeated) — если пользователь повторяет
// тот же вопрос, это негативный сигнал (Лия не ответила удовлетворительно).
//
// Подход: Jaccard similarity на нормализованных словах с порогом 0.8.
// Не используем embedding similarity (лишний HTTP-вызов к Ollama на каждое сообщение).
//
// Нормализация:
//   - lowercase
//   - trim
//   - remove punctuation (кроме букв и цифр)
//   - split на слова
//   - фильтр слов короче 2 символов (stopwords "а", "и", "в" и т.п.)

const SIMILARITY_THRESHOLD = 0.8;

export function isRepeatedMessage(current: string, previous: string): boolean {
  if (!current || !previous) return false;
  if (current.length < 10 || previous.length < 10) return false;  // слишком короткие — пропускаем

  const currentWords = normalizeToWords(current);
  const previousWords = normalizeToWords(previous);

  if (currentWords.size === 0 || previousWords.size === 0) return false;

  const similarity = jaccardSimilarity(currentWords, previousWords);
  return similarity >= SIMILARITY_THRESHOLD;
}

function normalizeToWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')  // оставляем буквы (включая кириллицу), цифры, пробелы
      .split(/\s+/)
      .filter(w => w.length >= 2),  // фильтр коротких слов
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
