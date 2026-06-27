'use client';

import { useChatStore } from '@/stores/chat-store';
import { EmotionBars } from './avatar-svg';
import { Live2DAvatar } from './live2d-avatar';
import { AgentPanel } from './agent-panel';
import { RLPanel } from './rl-panel';
import { CapabilityIndicator } from './capability-indicator';
import { Sparkles, ChevronDown } from 'lucide-react';
import { useState, useEffect, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { dominantEmotion } from '@/lib/emotion';
import { EMOTION_LABELS_RU, type EmotionAxis } from '@/lib/personality';

// VRM (3D) is heavy + needs browser APIs — load dynamically, no SSR
const VrmAvatar = dynamic(() => import('./vrm-avatar').then(m => m.VrmAvatar), {
  ssr: false,
  loading: () => <div className="w-[280px] h-[280px] flex items-center justify-center text-text-dim text-xs">загрузка 3D…</div>,
});

// Краткое текстовое описание текущей эмоции — рядом с аватаром
const EMOTION_TEXT: Record<EmotionAxis, string> = {
  joy:        'радость',
  curiosity:  'любопытство',
  calm:       'спокойствие',
  irritation: 'раздражение',
  sadness:    'грусть',
};

export function AvatarColumn() {
  const emotion = useChatStore(s => s.emotion);
  const isStreaming = useChatStore(s => s.isStreaming);
  const [avatarMode, setAvatarMode] = useState<'live2d' | '3d'>('3d');
  const [vrmSrc, setVrmSrc] = useState<string | undefined>(undefined);
  const [emotionsExpanded, setEmotionsExpanded] = useState(false);

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

  const dom = dominantEmotion(emotion);
  const domLabel = EMOTION_TEXT[dom];
  const domValue = Math.round(emotion[dom] * 100);

  return (
    <aside className="w-72 flex flex-col shrink-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Avatar — стоит на платформе, цвет которой = текущая эмоция */}
        <div className="flex justify-center pt-2 pb-2 min-h-[300px] items-end">
          {avatarMode === '3d' ? (
            <VrmErrorBoundary onError={() => setAvatarMode('live2d')}>
              <VrmAvatar emotion={emotion} speaking={isStreaming} size={280} src={vrmSrc} />
            </VrmErrorBoundary>
          ) : (
            <Live2DAvatar emotion={emotion} speaking={isStreaming} size={280} />
          )}
        </div>

        {/* Текущая эмоция — короткая подпись под аватаром */}
        <div className="flex items-center justify-center gap-2 -mt-2">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">
            сейчас чувствует:
          </span>
          <span className="text-xs font-medium text-foreground">{domLabel}</span>
          <span className="text-[10px] font-mono text-text-dim">{domValue}%</span>
        </div>

        {/* Подробные эмоции — сворачиваемый блок (по умолчанию свёрнут, чтобы не дублировать платформу) */}
        <div>
          <button
            onClick={() => setEmotionsExpanded(v => !v)}
            className="w-full flex items-center gap-2 mb-2 group"
          >
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex-1 text-left">
              Эмоции
            </h3>
            <ChevronDown
              className={`w-3.5 h-3.5 text-text-dim transition-transform ${emotionsExpanded ? 'rotate-180' : ''}`}
            />
          </button>
          {emotionsExpanded && <EmotionBars emotion={emotion} />}
          {!emotionsExpanded && (
            <p className="text-[10px] text-text-dim leading-relaxed pl-5">
              Цвет платформы под аватаром отражает текущую эмоцию.
              Разверни, чтобы увидеть все 5 осей.
            </p>
          )}
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
