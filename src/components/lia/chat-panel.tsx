'use client';

import { useChatStore } from '@/stores/chat-store';
import { useChat } from '@/hooks/use-chat';
import { ChatMessage } from '@/components/lia/chat-message';
import { ChatInput } from '@/components/lia/chat-input';
import { SmartNotificationBanner } from '@/components/lia/smart-notification-banner';
import { useEffect, useRef, useCallback } from 'react';
import { EmptyState } from '@/components/lia/empty-state';

export function ChatPanel() {
  const messages = useChatStore(s => s.messages);
  const episodeId = useChatStore(s => s.currentEpisodeId);
  const isStreaming = useChatStore(s => s.isStreaming);
  const episodes = useChatStore(s => s.episodes);
  const { sendMessage, stop } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Track whether user is "pinned to bottom" — only auto-scroll if they are.
  // Это исправляет: пользователь скроллит вверх читать историю → стриминг
  // не дёргает его вниз на каждом chunk'е.
  const isPinnedToBottomRef = useRef(true);

  const currentEpisode = episodes.find(e => e.id === episodeId);

  // IntersectionObserver — следит за sentinel элементом в конце списка.
  // Если sentinel visible → user pinned to bottom → auto-scroll разрешён.
  // Если sentinel not visible → user scrolled up → auto-scroll блокируется.
  useEffect(() => {
    const sentinel = bottomRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        isPinnedToBottomRef.current = entries[0]?.isIntersecting ?? true;
      },
      { root, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [episodeId]);  // re-observe при смене эпизода

  // Auto-scroll только если pinned to bottom
  const scrollToBottom = useCallback(() => {
    if (isPinnedToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // При смене эпизода — всегда скроллим вниз (новый чат)
  useEffect(() => {
    isPinnedToBottomRef.current = true;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [episodeId]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Chat header */}
      <div className="h-12 border-b border-border flex items-center px-4 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {currentEpisode?.title || 'Новый чат'}
          </div>
          {messages.length > 0 && (
            <div className="text-[10px] text-text-dim">
              {messages.length} сообщений
            </div>
          )}
        </div>
      </div>

      {/* Smart notifications (non-blocking, dismissible) */}
      <SmartNotificationBanner />

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-label="История чата"
      >
        <div className="max-w-[720px] mx-auto px-6 py-6 space-y-4">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map(m => (
              <ChatMessage
                key={m.id}
                message={m}
              />
            ))
          )}
          {/* Sentinel for IntersectionObserver */}
          <div ref={bottomRef} className="h-1" />
        </div>
      </div>

      {/* Input */}
      <ChatInput
        onSend={(text, mode) => sendMessage(text, mode)}
        isStreaming={isStreaming}
        onStop={stop}
        disabled={!episodeId}
      />
    </div>
  );
}
