'use client';

import { useChatStore } from '@/stores/chat-store';
import { useEpisodes } from '@/hooks/use-episodes';
import { Plus, MessageSquare, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

export function EpisodesSidebar() {
  const episodes = useChatStore(s => s.episodes);
  const currentId = useChatStore(s => s.currentEpisodeId);
  const { create, select, remove } = useEpisodes();

  // Group by period
  const grouped = useMemo(() => groupEpisodesByPeriod(episodes), [episodes]);

  const handleNew = async () => {
    const ep = await create();
    if (ep) await select(ep.id);
  };

  return (
    <aside className="w-60 border-r border-border flex flex-col shrink-0 bg-background">
      {/* New chat button */}
      <div className="p-3 border-b border-border">
        <button
          onClick={handleNew}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-border hover:border-accent hover:bg-accent/5 transition-colors text-sm"
        >
          <Plus className="w-4 h-4" />
          <span>Новый чат</span>
        </button>
      </div>

      {/* Episodes list */}
      <div className="flex-1 overflow-y-auto">
        {episodes.length === 0 ? (
          <div className="p-4 text-xs text-text-dim">
            Пока нет чатов. Создай первый.
          </div>
        ) : (
          <div className="py-2">
            {grouped.map(group => (
              <div key={group.label} className="mb-3">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-text-dim font-medium">
                  {group.label}
                </div>
                {group.items.map(ep => (
                  <div
                    key={ep.id}
                    onClick={() => select(ep.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        select(ep.id);
                      }
                    }}
                    className={cn(
                      'group w-full text-left px-3 py-2 mx-1 rounded-md flex items-center gap-2 transition-colors cursor-pointer',
                      'hover:bg-surface-2',
                      currentId === ep.id && 'bg-accent/10',
                    )}
                    style={{ width: 'calc(100% - 8px)' }}
                  >
                    {currentId === ep.id && (
                      <div className="w-0.5 h-4 bg-accent rounded-full -ml-1 mr-1" />
                    )}
                    <MessageSquare className="w-3.5 h-3.5 text-text-dim shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">
                        {ep.title || 'Новый чат'}
                      </div>
                      <div className="text-[10px] text-text-dim">
                        {ep.messageCount} сообщ.
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Удалить чат «${ep.title || 'Новый чат'}»?`)) {
                          remove(ep.id);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-text-dim hover:text-destructive transition-all p-1 rounded hover:bg-surface"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

// ============================================================================
// Grouping
// ============================================================================
type GroupedEpisodes = { label: string; items: typeof useChatStore extends { getState: () => infer S } ? S extends { episodes: infer E } ? E : never : never };

function groupEpisodesByPeriod(episodes: { id: string; title: string | null; createdAt: string; updatedAt: string; messageCount: number }[]) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const groups: Record<string, typeof episodes> = {
    'Сегодня': [],
    'Вчера': [],
    'На этой неделе': [],
    'Раньше': [],
  };

  for (const ep of episodes) {
    const ts = new Date(ep.updatedAt).getTime();
    if (ts >= startOfToday) groups['Сегодня'].push(ep);
    else if (ts >= startOfYesterday) groups['Вчера'].push(ep);
    else if (ts >= startOfWeek) groups['На этой неделе'].push(ep);
    else groups['Раньше'].push(ep);
  }

  return Object.entries(groups)
    .filter(([_, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}
