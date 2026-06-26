'use client';

import { useEffect } from 'react';
import { useEpisodes } from '@/hooks/use-episodes';
import { useHealth } from '@/hooks/use-health';
import { EpisodesSidebar } from '@/components/lia/episodes-sidebar';
import { ChatPanel } from '@/components/lia/chat-panel';
import { AvatarColumn } from '@/components/lia/avatar-column';
import { OllamaBanner } from '@/components/lia/ollama-banner';
import { SettingsDialog } from '@/components/lia/settings-dialog';

export default function HomePage() {
  useEpisodes();
  useHealth();

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="h-12 border-b border-border flex items-center px-4 gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md bg-accent flex items-center justify-center">
            <span className="text-[10px] font-bold text-white">Л</span>
          </div>
          <span className="text-sm font-medium tracking-tight">Лия</span>
          <span className="text-[10px] text-text-dim font-mono">v2.0</span>
        </div>
        <div className="flex-1" />
        <SettingsDialog />
      </header>

      {/* Ollama connection banner */}
      <OllamaBanner />

      {/* Main 3-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: episodes sidebar */}
        <EpisodesSidebar />

        {/* Center: chat panel */}
        <main className="flex-1 flex flex-col min-w-0">
          <ChatPanel />
        </main>

        {/* Right: avatar column */}
        <AvatarColumn />
      </div>
    </div>
  );
}
