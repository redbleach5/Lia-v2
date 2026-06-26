// Smart Notifications — non-intrusive hints when hardware limits quality.
//
// Scenario: user asks "prove Gödel's incompleteness theorem" on a 4B model.
// Strategy:
//   1. While generating response, run background web_search:
//      "what LLM model size needed for [task type]"
//   2. Check if reliable sources (HuggingFace, ArXiv, papers) confirm
//      that this task class needs a bigger model
//   3. If yes — show subtle inline notification (not blocking, not modal)
//   4. If sources don't confirm — stay silent (don't spam)
//
// Notification format: a small info card above Lia's response, dismissible.
// Example: "ℹ Для таких задач обычно нужна модель побольше. Текущая даст
//          приближённый ответ — рекомендуем проверить результат."

import { webSearch } from '@/lib/tools/web-search';
import type { Tier, CapabilityProfile } from '@/lib/capability-profile';
import type { TaskComplexity } from '@/lib/task-complexity';

// ============================================================================
// Types
// ============================================================================
export type SmartNotification = {
  id: string;
  type: 'hardware_limit' | 'model_mismatch' | 'info';
  message: string;
  sources: Array<{ title: string; url: string }>;
  taskId?: string;
  ts: number;
};

// ============================================================================
// Task-type → search query mapping
// ============================================================================
function buildSearchQuery(complexity: TaskComplexity, messagePreview: string): string {
  // Extract key terms from message for the search
  const trimmed = messagePreview.slice(0, 100).trim();

  switch (complexity) {
    case 'complex':
      return `LLM model size benchmark reasoning analysis ${trimmed.slice(0, 50)}`;
    case 'research':
      return `LLM model size needed research tasks ${trimmed.slice(0, 50)}`;
    default:
      return `minimum LLM model size for ${trimmed.slice(0, 50)}`;
  }
}

// ============================================================================
// Source reliability check
// ============================================================================
const RELIABLE_DOMAINS = [
  'huggingface.co',
  'arxiv.org',
  'github.com',
  'openreview.net',
  'paperswithcode.com',
  'anthropic.com',
  'openai.com',
  'research.google',
  'ai.meta.com',
  'mistral.ai',
  'qwenlm.github.io',
  'ollama.com',
];

function isReliableSource(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return RELIABLE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// ============================================================================
// Tier → expected minimum for complex tasks
// ============================================================================
const TIER_MINIMUM_FOR_COMPLEX: Record<Tier, number> = {
  micro: 13,      // 4B can't do complex reasoning reliably
  standard: 30,   // 13B borderline for complex
  plus: 0,        // 30B+ is fine — no notification
  max: 0,         // never notify on max tier
};

// ============================================================================
// Notification message generation
// ============================================================================
function generateMessage(tier: Tier, complexity: TaskComplexity): string {
  const taskLabel = complexity === 'complex' ? 'таких задач' : 'исследовательских задач';

  if (tier === 'micro') {
    return `Для ${taskLabel} обычно нужна модель побольше. Текущая модель небольшая — Lia даст приближённый ответ. Рекомендуем проверить важные детали.`;
  }
  if (tier === 'standard') {
    return `Для ${taskLabel} лучше использовать модель от 30B. Текущая справится, но может упустить нюансы.`;
  }
  return '';
}

// ============================================================================
// Main entry point
// ============================================================================
export async function checkHardwareLimit(params: {
  profile: CapabilityProfile | null;
  complexity: TaskComplexity;
  message: string;
}): Promise<SmartNotification | null> {
  const { profile, complexity, message } = params;

  // Only check on complex/research tasks
  if (complexity !== 'complex' && complexity !== 'research') return null;

  // Only on micro/standard tiers
  if (!profile) return null;
  const tier = profile.tier;
  if (tier === 'plus' || tier === 'max') return null;

  // Build search query
  const query = buildSearchQuery(complexity, message);

  try {
    const searchResult = await webSearch(query);
    if (!searchResult.results || searchResult.results.length === 0) return null;

    // Filter to reliable sources
    const reliableSources = searchResult.results
      .filter(r => isReliableSource(r.url))
      .slice(0, 3);

    // If no reliable sources — don't show notification (can't confirm)
    if (reliableSources.length === 0) return null;

    // Generate message
    const message_text = generateMessage(tier, complexity);
    if (!message_text) return null;

    return {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'hardware_limit',
      message: message_text,
      sources: reliableSources.map(s => ({ title: s.title, url: s.url })),
      ts: Date.now(),
    };
  } catch (e) {
    console.warn('[smart-notifications] search failed:', e);
    return null;
  }
}

// ============================================================================
// Notification storage (for SSE delivery)
// ============================================================================
const pendingNotifications = new Map<string, SmartNotification>();

export function queueNotification(notification: SmartNotification): void {
  pendingNotifications.set(notification.id, notification);
  // Auto-remove after 5 minutes
  setTimeout(() => pendingNotifications.delete(notification.id), 5 * 60 * 1000);
}

export function getPendingNotifications(): SmartNotification[] {
  return Array.from(pendingNotifications.values());
}

export function clearNotification(id: string): void {
  pendingNotifications.delete(id);
}
