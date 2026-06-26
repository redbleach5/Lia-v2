'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore, type Episode } from '@/stores/chat-store';

export function useEpisodes() {
  // Use individual selectors — store object changes on every state update,
  // which would re-create callbacks and re-trigger effects.
  const setEpisodes = useChatStore(s => s.setEpisodes);
  const addEpisode = useChatStore(s => s.addEpisode);
  const removeEpisodeFromStore = useChatStore(s => s.removeEpisode);
  const setCurrentEpisode = useChatStore(s => s.setCurrentEpisode);
  const setMessages = useChatStore(s => s.setMessages);
  const currentEpisodeId = useChatStore(s => s.currentEpisodeId);

  // Keep latest values in refs for use inside callbacks without re-creating them
  const currentEpisodeIdRef = useRef(currentEpisodeId);
  useEffect(() => {
    currentEpisodeIdRef.current = currentEpisodeId;
  }, [currentEpisodeId]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/episodes');
      if (!res.ok) return;
      const data = await res.json();
      setEpisodes(data.episodes ?? []);
    } catch (e) {
      console.error('[useEpisodes] refresh failed:', e);
    }
  }, [setEpisodes]);

  const create = useCallback(async (title?: string): Promise<Episode | null> => {
    try {
      const res = await fetch('/api/episodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const ep = data.episode as Episode;
      addEpisode(ep);
      return ep;
    } catch (e) {
      console.error('[useEpisodes] create failed:', e);
      return null;
    }
  }, [addEpisode]);

  const select = useCallback(async (id: string) => {
    if (currentEpisodeIdRef.current === id) return;
    try {
      const res = await fetch(`/api/episodes/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setCurrentEpisode(id);
      const msgs = (data.messages ?? []).map((m: { id: string; role: string; content: string; emotionJson: string | null; createdAt: string }) => ({
        id: m.id,
        role: m.role as 'user' | 'companion',
        content: m.content,
        createdAt: new Date(m.createdAt).getTime(),
      }));
      setMessages(msgs);
    } catch (e) {
      console.error('[useEpisodes] select failed:', e);
    }
  }, [setCurrentEpisode, setMessages]);

  const remove = useCallback(async (id: string) => {
    try {
      await fetch(`/api/episodes/${id}`, { method: 'DELETE' });
      removeEpisodeFromStore(id);
      // Check current state to decide what to do next
      const state = useChatStore.getState();
      if (state.currentEpisodeId === null) {
        const remaining = state.episodes.filter(e => e.id !== id);
        if (remaining.length > 0) {
          await select(remaining[0].id);
        } else {
          const ep = await create();
          if (ep) await select(ep.id);
        }
      }
    } catch (e) {
      console.error('[useEpisodes] remove failed:', e);
    }
  }, [removeEpisodeFromStore, select, create]);

  // On mount ONLY: refresh list, create first episode if empty.
  // Stable callbacks (setEpisodes etc) — these don't change after mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
      const current = useChatStore.getState();
      if (current.episodes.length === 0) {
        const ep = await create();
        if (cancelled) return;
        if (ep) await select(ep.id);
      } else if (!current.currentEpisodeId) {
        await select(current.episodes[0].id);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { refresh, create, select, remove };
}
