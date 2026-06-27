'use client';

import { cn } from '@/lib/utils';
import { Search, FileText, Loader2, Check, AlertCircle, type LucideIcon } from 'lucide-react';

type ToolCallCardProps = {
  name: string;
  input: unknown;
  output: unknown;
};

export function ToolCallCard({ name, input, output }: ToolCallCardProps) {
  const isSearch = name === 'web_search';
  const isSave = name === 'save_artifact';

  const Icon: LucideIcon = isSearch ? Search : isSave ? FileText : FileText;
  const title = isSearch ? 'Поиск в интернете' : isSave ? 'Сохранён файл' : name;

  // For save_artifact: show download link
  const savedFile = isSave && output && typeof output === 'object'
    ? (output as { filename?: string; url?: string; size?: number })
    : null;

  return (
    <div className="rounded-md border border-border bg-surface/50 overflow-hidden">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
        <Icon className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-medium">{title}</span>
        <Check className="w-3 h-3 text-success ml-auto" />
      </div>

      {/* Tool-specific body */}
      {isSearch && (
        <SearchResults input={input} output={output} />
      )}

      {isSave && savedFile && (
        <div className="px-3 py-2 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-mono truncate">{savedFile.filename}</div>
            <div className="text-[10px] text-text-dim">
              {savedFile.size ? `${(savedFile.size / 1024).toFixed(1)} КБ` : ''}
            </div>
          </div>
          <a
            href={savedFile.url}
            download={savedFile.filename}
            className="shrink-0 px-2 py-1 rounded text-[11px] bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            Скачать
          </a>
        </div>
      )}
    </div>
  );
}

function SearchResults({ input, output }: { input: unknown; output: unknown }) {
  const query = (input as { query?: string })?.query ?? '';
  const results = output && typeof output === 'object' && 'results' in output
    ? ((output as { results: Array<{ title: string; url: string; snippet: string }> }).results ?? [])
    : [];

  return (
    <div className="px-3 py-2 space-y-2">
      <div className="text-[11px] text-text-dim">
        Запрос: <span className="text-foreground">«{query}»</span>
      </div>
      {results.length > 0 ? (
        <div className="space-y-1.5 max-h-40 overflow-y-auto">
          {results.slice(0, 5).map((r, i) => (
            <a
              key={i}
              href={r.url}
              target="_blank"
              rel="noreferrer noopener"
              className="block text-xs hover:bg-surface-2 -mx-1 px-1 py-0.5 rounded transition-colors"
            >
              <div className="font-medium truncate text-accent">{r.title}</div>
              <div className="text-text-dim text-[10px] truncate">{r.url}</div>
              {r.snippet && (
                <div className="text-muted-foreground text-[10px] line-clamp-2">{r.snippet}</div>
              )}
            </a>
          ))}
          {results.length > 5 && (
            <div className="text-[10px] text-text-dim">
              +{results.length - 5} ещё
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-text-dim italic">Ничего не найдено</div>
      )}
    </div>
  );
}
