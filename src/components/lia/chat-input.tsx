'use client';

import { useState, useRef, useEffect } from 'react';
import type { ChatMode } from '@/stores/chat-store';
import { useChatStore } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { Send, StopCircle, ChevronDown, Zap, Brain, Rocket, Sparkles } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { LucideIcon } from 'lucide-react';

type ChatInputProps = {
  onSend: (text: string, mode: ChatMode) => void;
  isStreaming: boolean;
  onStop: () => void;
  disabled?: boolean;
};

const MODES: Array<{ id: ChatMode; label: string; icon: LucideIcon; description: string; color: string }> = [
  { id: 'auto',     label: 'Авто',     icon: Sparkles, description: 'Лия сама выбирает глубину под задачу и железо. Рекомендуется.', color: 'text-accent' },
  { id: 'fast',     label: 'Быстрый',  icon: Zap,      description: '1 вызов, без инструментов. Для «привет» и бытовых вопросов.', color: 'text-amber-500' },
  { id: 'standard', label: 'Стандарт', icon: Brain,    description: '1 вызов + инструменты + self-check. Для обычных вопросов.', color: 'text-sky-500' },
  { id: 'deep',     label: 'Глубокий', icon: Brain,    description: 'Анализ → ответ → проверка. Для сложных задач.', color: 'text-violet-500' },
  { id: 'agent',    label: 'Агент',    icon: Rocket,   description: 'Многошаговый режим с инструментами. Для больших задач.', color: 'text-rose-500' },
];

export function ChatInput({ onSend, isStreaming, onStop, disabled }: ChatInputProps) {
  const [text, setText] = useState('');
  const mode = useChatStore(s => s.mode);
  const setMode = useChatStore(s => s.setMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
  }, [text]);

  // Listen for suggestion events (from EmptyState)
  useEffect(() => {
    const handler = (e: Event) => {
      const suggestion = (e as CustomEvent<string>).detail;
      if (suggestion && typeof suggestion === 'string') {
        setText(suggestion);
        textareaRef.current?.focus();
      }
    };
    window.addEventListener('lia-suggestion', handler);
    return () => window.removeEventListener('lia-suggestion', handler);
  }, []);

  const currentMode = MODES.find(m => m.id === mode) ?? MODES[0];

  const handleSend = () => {
    const t = text.trim();
    if (!t || isStreaming || disabled) return;
    onSend(t, mode);
    setText('');
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-border bg-background p-3 shrink-0">
      <div className="max-w-[720px] mx-auto flex items-end gap-2">
        {/* Mode toggle — DropdownMenu с keyboard navigation, ARIA, focus management */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={isStreaming}
              title={`Режим: ${currentMode.label}. ${currentMode.description}`}
              aria-label={`Режим чата: ${currentMode.label}`}
              aria-haspopup="menu"
              className={cn(
                'h-[40px] px-2.5 gap-1.5 rounded-md border border-border text-xs flex items-center shrink-0',
                'hover:border-accent hover:bg-accent/5 transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-accent/40',
                isStreaming && 'opacity-50 cursor-not-allowed',
                currentMode.color,
              )}
            >
              <currentMode.icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{currentMode.label}</span>
              <ChevronDown className="w-3 h-3 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-72 p-1">
            {MODES.map(m => (
              <DropdownMenuItem
                key={m.id}
                onSelect={() => setMode(m.id)}
                className="flex items-start gap-2 py-2 cursor-pointer"
              >
                <m.icon className={cn('w-4 h-4 mt-0.5 shrink-0', m.color)} />
                <div className="flex-1 min-w-0">
                  <div className={cn('font-medium', m.color)}>{m.label}</div>
                  <div className="text-text-dim text-[11px] leading-tight mt-0.5">{m.description}</div>
                </div>
                {mode === m.id && (
                  <span className="text-[10px] text-accent mt-0.5">✓</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={
            disabled
              ? 'Создай чат чтобы начать…'
              : isStreaming
                ? 'Лия отвечает…'
                : mode === 'agent'
                  ? 'Опиши задачу для агентского режима…'
                  : 'Напиши Лие…  (Enter — отправить)'
          }
          disabled={isStreaming || disabled}
          rows={1}
          aria-label="Сообщение для Лии"
          className={cn(
            'flex-1 resize-none min-h-[40px] max-h-[160px] px-3 py-2 rounded-md border border-border bg-surface text-sm',
            'placeholder:text-text-dim focus:outline-none focus:border-accent transition-colors',
            'disabled:opacity-50',
          )}
        />

        {/* Send / Stop */}
        {isStreaming ? (
          <button
            onClick={onStop}
            title="Остановить"
            aria-label="Остановить генерацию"
            className="h-[40px] w-[40px] shrink-0 rounded-md bg-destructive hover:bg-destructive/90 text-background flex items-center justify-center transition-colors"
          >
            <StopCircle className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim() || disabled}
            title="Отправить (Enter)"
            aria-label="Отправить сообщение"
            className={cn(
              'h-[40px] w-[40px] shrink-0 rounded-md flex items-center justify-center transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-accent/40',
              mode === 'agent'
                ? 'bg-taupe hover:bg-taupe/90 text-background'
                : 'bg-accent hover:bg-accent/90 text-background',
              (!text.trim() || disabled) && 'opacity-50 cursor-not-allowed',
            )}
          >
            {mode === 'agent' ? <Rocket className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
