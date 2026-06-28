'use client';

import { useEffect } from 'react';
import { useChatStore } from '@/stores/chat-store';

export function useHealth() {
  const setHealth = useChatStore(s => s.setOllamaHealth);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval>;

    const check = async () => {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        if (cancelled) return;
        setHealth(data.ok, data.error);
      } catch (e) {
        if (cancelled) return;
        setHealth(false, e instanceof Error ? e.message : String(e));
      }
    };

    check();
    interval = setInterval(check, 60_000);

    // Перепроверяем health сразу после смены настроек Ollama в SettingsDialog.
    const onSettingsChanged = () => { check(); };
    window.addEventListener('lia-settings-changed', onSettingsChanged);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('lia-settings-changed', onSettingsChanged);
    };
  }, [setHealth]);
}
