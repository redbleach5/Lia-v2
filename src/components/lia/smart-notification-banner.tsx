'use client';

// Smart Notification — тонкое уведомление о лимитах железа.
//
// Появляется сверху чата (не блокирующее), автоматически исчезает через 30 сек
// или по клику. Показывается только когда smart-notifications.ts решил что
// уместно (сложная задача на слабой модели + подтверждение из поиска).

import { useEffect, useState } from 'react';
import { Info, X, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

type Notification = {
  id: string;
  type: string;
  message: string;
  sources: Array<{ title: string; url: string }>;
  ts: number;
};

export function SmartNotificationBanner() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const fetchNotifications = async () => {
    try {
      const res = await fetch('/api/notifications');
      const data = await res.json();
      const notifs = (data.notifications ?? []) as Notification[];
      // Filter out dismissed
      const visible = notifs.filter(n => !dismissed.has(n.id));
      setNotifications(visible);
    } catch {
      /* ignore */
    }
  };

  const dismiss = async (id: string) => {
    setDismissed(prev => new Set(prev).add(id));
    setNotifications(prev => prev.filter(n => n.id !== id));
    try {
      await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    // Fetch once on mount, then poll
    let active = true;

    const doFetch = async () => {
      try {
        const res = await fetch('/api/notifications');
        if (!active) return;
        const data = await res.json();
        const notifs = (data.notifications ?? []) as Notification[];
        const visible = notifs.filter(n => !dismissed.has(n.id));
        setNotifications(visible);
      } catch {
        /* ignore */
      }
    };

    doFetch();
    const interval = setInterval(doFetch, 10_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [dismissed]);

  if (notifications.length === 0) return null;

  return (
    <div className="space-y-1.5 px-4 pt-2">
      {notifications.map(notif => (
        <div
          key={notif.id}
          className={cn(
            'rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs',
            'flex items-start gap-2 lia-fade-in',
          )}
        >
          <Info className="w-3.5 h-3.5 text-sky-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-foreground/90 leading-relaxed">
              {notif.message}
            </div>
            {notif.sources.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-1.5">
                {notif.sources.slice(0, 2).map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[10px] text-sky-500 hover:text-sky-400 transition-colors flex items-center gap-0.5"
                  >
                    <ExternalLink className="w-2.5 h-2.5" />
                    <span className="truncate max-w-[150px]">{s.title}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => dismiss(notif.id)}
            className="text-text-dim hover:text-foreground transition-colors p-0.5 rounded shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
