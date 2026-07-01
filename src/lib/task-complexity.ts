// Task Complexity Classifier — determines how hard a user message is.
//
// Used by cognitive-depth.ts to decide how many LLM calls to make.
// On a max-tier model, even simple questions get 1 call (no waste).
// On any tier, complex questions get the full pipeline.

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'research';

// ============================================================================
// Patterns
// ============================================================================

// Trivial — greetings, thanks, acknowledgements
const TRIVIAL_PATTERNS = [
  /^(привет|здравствуй|здравствуйте|хай|hi|hello|приветик)\b/i,
  /^(пока|до свидания|bye|goodbye|увидимся)\b/i,
  /^(спасибо|благодарю|thanks|thank you|спс)\b/i,
  /^(ок|окей|хорошо|ладно|да|нет|угу|ага)\b/i,
  /^(как дела|как ты|что делаешь|как настроение)\b/i,
];

// Complex — multi-step reasoning, analysis, proof, comparison
const COMPLEX_PATTERNS = [
  /\b(докажи|выведи|обоснуй|проанализируй|сравни|оцени|рассмотри)\b/i,
  /\b(архитектур|проектир|стратеги|план реализации|пошаговый план)\b/i,
  /\b(почему|зачем|как устроен|как работает|в чём разница)\b/i,
  /\b(рефакторинг|оптимизируй|найди ошибку|debug|дебаг)\b/i,
  /\b(переведи|реши|вычисли|рассчитай)\b.*\b(уравнени|задач|формул|интеграл|производн)/i,
];

// Research — needs information gathering (web search, file analysis)
const RESEARCH_PATTERNS = [
  /\b(найди информацию|поищи|загугли|что нового|актуальн|последн)/i,
  /\b(версия|release|changelog|обновлен)/i,
  /\b(документаци|docs|documentation|spec|спецификаци)/i,
  /\b(статистик|исследовани|study|paper|статья)/i,
];

// ============================================================================
// Classifier
// ============================================================================

export function classifyTaskComplexity(message: string): TaskComplexity {
  const text = message.trim();
  const lower = text.toLowerCase();

  // Length-based signals
  if (text.length < 20) {
    // Very short — likely trivial
    if (TRIVIAL_PATTERNS.some(p => p.test(text))) return 'trivial';
    // Short but with question mark — simple question
    if (text.includes('?')) return 'simple';
    return 'trivial';
  }

  // Check patterns in order of complexity
  if (RESEARCH_PATTERNS.some(p => p.test(lower))) return 'research';
  if (COMPLEX_PATTERNS.some(p => p.test(lower))) return 'complex';

  // Long message without complexity markers — moderate
  if (text.length > 500) return 'moderate';

  // Has question — simple
  if (text.includes('?')) return 'simple';

  // Default
  return 'moderate';
}
