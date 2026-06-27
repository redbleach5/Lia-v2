'use client';

import type { ChatMessage } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { ToolCallCard } from './tool-call-card';

export function ChatMessage({ message, isLast }: { message: ChatMessage; isLast: boolean }) {
  const isUser = message.role === 'user';
  const isStreaming = message.streaming === true;

  return (
    <div className={cn('lia-fade-in flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      {/* Author label */}
      <div className={cn('text-[10px] text-text-dim px-1', isUser ? 'text-right' : 'text-left')}>
        {isUser ? 'ты' : 'Лия'}
      </div>

      {/* Message bubble */}
      <div
        className={cn(
          'max-w-[85%] px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-accent/10 text-foreground rounded-2xl rounded-tr-md'
            : 'text-foreground rounded-2xl rounded-tl-md',
          isStreaming && 'lia-cursor',
        )}
      >
        <MessageContent text={message.content} isStreaming={isStreaming} />
      </div>

      {/* Tool calls */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="w-full space-y-1.5 mt-1">
          {message.toolCalls.map((tc, i) => (
            <ToolCallCard key={i} name={tc.name} input={tc.input} output={tc.output} />
          ))}
        </div>
      )}

      {/* Metadata for non-streaming messages */}
      {!isStreaming && !isUser && (
        <div className="text-[10px] text-text-dim px-1">
          {new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Message content — simple markdown-ish renderer.
// MVP: code blocks + inline code + paragraphs.
// Full markdown rendering comes via react-markdown later.
// ============================================================================
function MessageContent({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  if (!text && isStreaming) {
    return <span className="text-text-dim italic">думаю…</span>;
  }

  // Split by code fences
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);

  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        // Even indices = text, odd = lang, even+2 = code
        if (i % 3 === 1) return null; // language tag — skip, handled in next iteration
        if (i % 3 === 2) {
          const lang = parts[i - 1] || 'text';
          return <CodeBlock key={i} language={lang} code={part} />;
        }
        // Regular text — render paragraphs
        if (!part.trim()) return null;
        return (
          <div key={i} className="whitespace-pre-wrap break-words">
            {renderInline(part)}
          </div>
        );
      })}
    </div>
  );
}

function renderInline(text: string) {
  // Inline code with backticks
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) {
      return (
        <code key={i} className="px-1.5 py-0.5 rounded bg-surface-2 text-xs font-mono text-accent">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const trimmed = code.replace(/\n$/, '');
  return (
    <div className="rounded-md border border-border bg-background/50 overflow-hidden my-2">
      <div className="px-3 py-1.5 border-b border-border bg-surface-2/50 flex items-center justify-between">
        <span className="text-[10px] font-mono text-text-dim uppercase">{language}</span>
        <button
          onClick={() => navigator.clipboard.writeText(trimmed)}
          className="text-[10px] text-text-dim hover:text-foreground transition-colors"
        >
          копировать
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-xs font-mono leading-relaxed">
        <code>{trimmed}</code>
      </pre>
    </div>
  );
}
