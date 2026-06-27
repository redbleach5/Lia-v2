'use client';

import { useChatStore } from '@/stores/chat-store';
import { Sparkles } from 'lucide-react';

export function EmptyState() {
  const emotion = useChatStore(s => s.emotion);

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] text-center py-12">
      <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mb-6">
        <Sparkles className="w-7 h-7 text-accent" />
      </div>
      <h2 className="text-xl font-medium mb-2">
        Привет! Я Лия.
      </h2>
      <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
        Напиши мне что-нибудь — и начнём.
        Можешь попросить нарисовать SVG-логотип, найти что-то в интернете,
        или просто поговорить.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-2 max-w-sm">
        <Suggestion
          text="Нарисуй SVG-логотип для проекта Lia"
          onClick={() => {
            // Suggestion fills the textarea via custom event
            const event = new CustomEvent('lia-suggestion', { detail: 'Нарисуй SVG-логотип для проекта Lia' });
            window.dispatchEvent(event);
          }}
        />
        <Suggestion
          text="Что нового в Next.js 16?"
          onClick={() => {
            const event = new CustomEvent('lia-suggestion', { detail: 'Что нового в Next.js 16?' });
            window.dispatchEvent(event);
          }}
        />
        <Suggestion
          text="Расскажи о себе"
          onClick={() => {
            const event = new CustomEvent('lia-suggestion', { detail: 'Расскажи о себе' });
            window.dispatchEvent(event);
          }}
        />
      </div>
    </div>
  );
}

function Suggestion({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left text-xs px-3 py-2 rounded-md border border-border bg-surface hover:border-accent hover:bg-accent/5 transition-colors text-muted-foreground"
    >
      {text}
    </button>
  );
}
