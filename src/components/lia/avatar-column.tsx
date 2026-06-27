'use client';

import { useChatStore } from '@/stores/chat-store';
import { EmotionBars } from './avatar-svg';
import dynamic from 'next/dynamic';

// Live2D (PixiJS ~500KB) — lazy-loaded, только если пользователь выбрал 2D режим
const Live2DAvatar = dynamic(() => import('./live2d-avatar').then(m => m.Live2DAvatar), {
  ssr: false,
  loading: () => <div className="w-full h-full flex items-center justify-center text-text-dim text-xs">загрузка 2D…</div>,
});
import { AgentPanel } from './agent-panel';
import { RLPanel } from './rl-panel';
import { CapabilityIndicator } from './capability-indicator';
import { Sparkles, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { useState, useEffect, type ReactNode } from 'react';
import { dominantEmotion } from '@/lib/emotion';
import { EMOTION_LABELS_RU, type EmotionAxis } from '@/lib/personality';
import { DEFAULT_AVATAR_CONFIG, parseAvatarConfig, type AvatarConfig } from '@/lib/avatar-config';

// VRM (3D) is heavy + needs browser APIs — load dynamically, no SSR
const VrmAvatar = dynamic(() => import('./vrm-avatar').then(m => m.VrmAvatar), {
  ssr: false,
  loading: () => (
    <div className="w-full aspect-square flex items-center justify-center text-text-dim text-xs">
      загрузка 3D…
    </div>
  ),
});

// Краткое текстовое описание текущей эмоции
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
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR_CONFIG);
  const [emotionsExpanded, setEmotionsExpanded] = useState(false);

  // Load avatar settings + config from API
  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setAvatarMode(data.avatarMode === 'live2d' ? 'live2d' : '3d');
        if (data.activeVrm) setVrmSrc(data.activeVrm);
        if (data.avatarConfig) setAvatarConfig(parseAvatarConfig(JSON.stringify(data.avatarConfig)));
      })
      .catch(() => { /* use defaults */ });
  }, []);

  const dom = dominantEmotion(emotion);
  const domLabel = EMOTION_TEXT[dom];
  const domValue = Math.round(emotion[dom] * 100);

  return (
    <aside className="w-80 flex flex-col shrink-0 overflow-hidden border-l border-border bg-surface/30">
      {/* ── Сцена с аватаром ── */}
      <div className="relative shrink-0 p-4 pb-2">
        {/* Карточка-«сцена» — аватар стоит вписанный, а не «висящий» в пустоте */}
        <div className="relative rounded-xl overflow-hidden border border-border bg-gradient-to-b from-surface to-surface-2/40 aspect-square">
          {avatarMode === '3d' ? (
            <VrmErrorBoundary onError={() => setAvatarMode('live2d')}>
              <div className="absolute inset-0">
                <VrmAvatar
                  emotion={emotion}
                  speaking={isStreaming}
                  size={288}
                  src={vrmSrc}
                  config={avatarConfig}
                />
              </div>
            </VrmErrorBoundary>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Live2DAvatar emotion={emotion} speaking={isStreaming} size={280} />
            </div>
          )}

          {/* Бейдж текущей эмоции — внизу карточки, как подпись к сцене */}
          <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-surface/85 backdrop-blur-sm border border-border/60">
            <span className="text-[10px] uppercase tracking-wider text-text-dim">
              сейчас чувствует
            </span>
            <span className="text-xs font-medium text-foreground">{domLabel}</span>
            <span className="text-[10px] font-mono text-text-dim">{domValue}%</span>
          </div>

          {/* Индикатор стриминга — верхний-правый угол */}
          {isStreaming && (
            <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/15 border border-accent/30">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="text-[10px] text-accent font-medium">говорит</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Информационные блоки (скроллящиеся) ── */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
        {/* Подробные эмоции — сворачиваемый блок */}
        <div>
          <button
            onClick={() => setEmotionsExpanded(v => !v)}
            className="w-full flex items-center gap-2 mb-2 group"
          >
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex-1 text-left">
              Эмоции
            </h3>
            {emotionsExpanded
              ? <EyeOff className="w-3.5 h-3.5 text-text-dim" />
              : <Eye className="w-3.5 h-3.5 text-text-dim" />
            }
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
