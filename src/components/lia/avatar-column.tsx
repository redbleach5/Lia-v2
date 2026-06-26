'use client';

import { useChatStore } from '@/stores/chat-store';
import { EmotionBars } from './avatar-svg';
import { Live2DAvatar } from './live2d-avatar';
import { AgentPanel } from './agent-panel';
import { RLPanel } from './rl-panel';
import { CapabilityIndicator } from './capability-indicator';
import { Sparkles } from 'lucide-react';
import { useState, useEffect, type ReactNode } from 'react';
import dynamic from 'next/dynamic';

// VRM (3D) is heavy + needs browser APIs — load dynamically, no SSR
const VrmAvatar = dynamic(() => import('./vrm-avatar').then(m => m.VrmAvatar), {
  ssr: false,
  loading: () => <div className="w-[280px] h-[280px] flex items-center justify-center text-text-dim text-xs">загрузка 3D…</div>,
});

export function AvatarColumn() {
  const emotion = useChatStore(s => s.emotion);
  const isStreaming = useChatStore(s => s.isStreaming);
  const [avatarMode, setAvatarMode] = useState<'live2d' | '3d'>('3d');
  const [vrmSrc, setVrmSrc] = useState<string | undefined>(undefined);

  // Load avatar settings from API
  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setAvatarMode(data.avatarMode === 'live2d' ? 'live2d' : '3d');
        if (data.activeVrm) setVrmSrc(data.activeVrm);
      })
      .catch(() => { /* use defaults */ });
  }, []);

  return (
    <aside className="w-72 border-l border-border bg-background flex flex-col shrink-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Avatar */}
        <div className="flex justify-center pt-2 pb-4 min-h-[200px] items-center">
          {avatarMode === '3d' ? (
            <VrmErrorBoundary onError={() => setAvatarMode('live2d')}>
              <VrmAvatar emotion={emotion} speaking={isStreaming} size={280} src={vrmSrc} />
            </VrmErrorBoundary>
          ) : (
            <Live2DAvatar emotion={emotion} speaking={isStreaming} size={280} />
          )}
        </div>

        {/* Emotions */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Эмоции
            </h3>
          </div>
          <EmotionBars emotion={emotion} />
        </div>

        {/* Agent tasks */}
        <AgentPanel />

        {/* RL — обучаемая личность */}
        <RLPanel />

        {/* Capability — текущий tier */}
        <CapabilityIndicator />
      </div>
    </aside>
  );
}

// ============================================================================
// Error boundary — falls back to SVG if VRM fails to load
// ============================================================================
import { Component } from 'react';

class VrmErrorBoundary extends Component<{ children: ReactNode; onError: () => void }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; onError: () => void }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[VrmErrorBoundary] VRM render failed, falling back to SVG:', error);
    this.props.onError();
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
