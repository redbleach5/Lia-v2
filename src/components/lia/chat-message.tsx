'use client';

import { memo } from 'react';
import type { ChatMessage as ChatMessageType } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { ToolCallCard } from './tool-call-card';
import { MarkdownRenderer } from './markdown-renderer';

// React.memo предотвращает ре-рендер ранее отрендеренных сообщений
// при стриминговом обновлении последнего сообщения.
export const ChatMessage = memo(function ChatMessage({ message }: { message: ChatMessageType }) {
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
        <MessageContent text={message.content} isStreaming={isStreaming} isUser={isUser} />
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
});

// ============================================================================
// MessageContent — рендерит текст сообщения.
// ============================================================================
// Phase 3: заменён stub-парсер (только code fences + inline code) на
// MarkdownRenderer (react-markdown + remark-gfm).
// Теперь поддерживаются: headings, lists, tables, blockquotes, links,
// bold/italic, strikethrough, code blocks (с кнопкой copy).
//
// Для user-сообщений используем whitespace-pre-wrap (без markdown parsing) —
// пользовательский ввод не должен интерпретироваться как markdown (безопасность).
function MessageContent({ text, isStreaming, isUser }: { text: string; isStreaming: boolean; isUser: boolean }) {
  if (!text && isStreaming) {
    return <span className="text-text-dim italic">думаю…</span>;
  }

  // User messages — plain text, no markdown (security: prevent interpretation)
  if (isUser) {
    return <div className="whitespace-pre-wrap break-words">{text}</div>;
  }

  // Companion messages — full markdown
  return <MarkdownRenderer content={text} />;
}
