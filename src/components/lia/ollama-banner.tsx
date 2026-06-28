'use client';

import { useChatStore } from '@/stores/chat-store';
import { AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

export function OllamaBanner() {
  const ok = useChatStore(s => s.ollamaOk);
  const error = useChatStore(s => s.ollamaError);
  const [dismissed, setDismissed] = useState(false);

  // Если настройки изменились (пользователь сменил URL) — сбрасываем dismissed,
  // чтобы баннер показал актуальный статус нового подключения.
  useEffect(() => {
    const handler = () => setDismissed(false);
    window.addEventListener('lia-settings-changed', handler);
    return () => window.removeEventListener('lia-settings-changed', handler);
  }, []);

  // Если Ollama стал доступен — сбрасываем dismissed, чтобы при следующем сбое баннер появился снова.
  useEffect(() => {
    if (ok) setDismissed(false);
  }, [ok]);

  if (ok === null) return null; // unknown — silent
  if (ok) return null;
  if (dismissed) return null;

  return (
    <div className="bg-warning/10 border-b border-warning/30 px-4 py-2 flex items-center gap-3 text-sm">
      <AlertCircle className="w-4 h-4 text-warning shrink-0" />
      <span className="text-foreground/90 flex-1">
        Не удалось подключиться к Ollama.{' '}
        <span className="text-muted-foreground">
          Проверь, что <code className="text-xs font-mono px-1 py-0.5 bg-surface-2 rounded">ollama serve</code> запущен.
        </span>
        {error && (
          <span className="text-text-dim ml-2 text-xs">({error})</span>
        )}
      </span>
      <button
        onClick={() => {
          setDismissed(true);
        }}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-surface-2"
      >
        Скрыть
      </button>
    </div>
  );
}
