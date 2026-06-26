'use client';

import { useChatStore } from '@/stores/chat-store';
import { useChat } from '@/hooks/use-chat';
import { ChatMessage } from '@/components/lia/chat-message';
import { ChatInput } from '@/components/lia/chat-input';
import { useEffect, useRef } from 'react';
import { EmptyState } from '@/components/lia/empty-state';

export function ChatPanel() {
  const messages = useChatStore(s => s.messages);
  const episodeId = useChatStore(s => s.currentEpisodeId);
  const isStreaming = useChatStore(s => s.isStreaming);
  const episodes = useChatStore(s => s.episodes);
  const { sendMessage, stop } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentEpisode = episodes.find(e => e.id === episodeId);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-[720px] mx-auto px-6 py-6 space-y-4">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((m, i) => (
              <ChatMessage
                key={m.id}
                message={m}
                isLast={i === messages.length - 1}
              />
            ))
          )}
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
