'use client';

// ============================================================================
// LearningTab — управление обучаемым стилем общения (RL sidecar).
// ============================================================================

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Check, GraduationCap, Loader2, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { RLStats } from './types';

type LearningTabProps = {
  rlStats: RLStats | null;
  onRefresh: () => Promise<void>;
};

export function LearningTab({ rlStats, onRefresh }: LearningTabProps) {
  const [training, setTraining] = useState(false);
  const [startingEngine, setStartingEngine] = useState(false);

  const startEngine = async () => {
    setStartingEngine(true);
    try {
      const res = await fetch('/api/rl/start-engine', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start engine');
      if (data.already_running) {
        toast.success('Движок обучения уже запущен');
      } else {
        toast.success('Движок обучения запускается… (это займёт несколько секунд)');
      }
      // Если есть warning (например, torch не установлен) — показываем его
      // как info-toast чтобы пользователь понимал: sidecar работает, но
      // обучение недоступно пока не установит torch.
      if (data.warning) {
        toast.info(data.warning, { duration: 8000 });
      }
      setTimeout(() => onRefresh(), 3000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось запустить движок');
    } finally {
      setStartingEngine(false);
    }
  };

  const train = async () => {
    setTraining(true);
    try {
      const res = await fetch('/api/rl/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nEpochs: 10 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Training failed');
      toast.success(`Готово! Создан стиль общения v${data.result.version}`);
      await onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Обучение не удалось');
    } finally {
      setTraining(false);
    }
  };

  const activateVersion = async (version: number) => {
    try {
      await fetch('/api/rl/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      toast.success(`Стиль общения v${version} активирован`);
      await onRefresh();
    } catch {
      toast.error('Не удалось активировать');
    }
  };

  return (
    <div className="space-y-4">
      {/* Description */}
      <div className="rounded-md border border-border bg-surface/50 p-3 text-xs leading-relaxed">
        <p className="font-medium text-foreground mb-1">Что это такое?</p>
        <p className="text-muted-foreground">
          Лия может учиться на твоих разговорах и подстраивать свой стиль общения:
          быть теплее или сдержаннее, задавать больше вопросов или давать развёрнутые ответы.
          Чем больше вы общаетесь — тем точнее Лия понимает, как тебе комфортнее.
        </p>
      </div>

      {/* Engine status */}
      <div className={cn(
        'rounded-md border p-3 text-xs flex items-center gap-2',
        rlStats?.sidecar_ok
          ? 'border-success/40 bg-success/5 text-success'
          : 'border-warning/40 bg-warning/5 text-warning',
      )}>
        <div className={cn(
          'w-2 h-2 rounded-full',
          rlStats?.sidecar_ok ? 'bg-success' : 'bg-warning',
        )} />
        <span className="flex-1">
          {rlStats?.sidecar_ok
            ? 'Движок обучения работает'
            : 'Движок обучения не запущен'}
        </span>
        {!rlStats?.sidecar_ok && (
          <button
            onClick={startEngine}
            disabled={startingEngine}
            className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors text-[11px]"
          >
            {startingEngine ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Запустить
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded border border-border bg-surface/50 p-2">
          <div className="text-text-dim">Разговоров записано</div>
          <div className="text-base font-mono text-foreground">
            {rlStats?.local_experiences ?? 0}
          </div>
          <div className="text-[10px] text-text-dim">нужно от 10 для обучения</div>
        </div>
        <div className="rounded border border-border bg-surface/50 p-2">
          <div className="text-text-dim">Стилей создано</div>
          <div className="text-base font-mono text-foreground">
            {rlStats?.sidecar_stats?.model_versions?.length ?? 0}
          </div>
        </div>
      </div>

      {/* Train button */}
      <Button
        onClick={train}
        disabled={training || !rlStats?.sidecar_ok || (rlStats?.local_experiences ?? 0) < 10}
        className="w-full"
        size="sm"
      >
        {training ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <GraduationCap className="w-3 h-3 mr-1.5" />}
        {training ? 'Учу…' : 'Обучить новый стиль'}
      </Button>

      {(rlStats?.local_experiences ?? 0) < 10 && (
        <p className="text-[10px] text-text-dim text-center">
          Поговори с Лией ещё {(10 - (rlStats?.local_experiences ?? 0))} раз, чтобы накопить достаточно данных для обучения
        </p>
      )}

      {/* Versions list */}
      {rlStats?.sidecar_stats?.model_versions && rlStats.sidecar_stats.model_versions.length > 0 && (
        <div className="space-y-1 mt-2">
          <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">
            Версии стиля общения
          </div>
          {rlStats.sidecar_stats.model_versions.map(m => {
            const isActive = m.version === rlStats.sidecar_stats?.active_version;
            return (
              <div
                key={m.version}
                className={cn(
                  'rounded border p-2 text-[11px] flex items-center gap-2',
                  isActive ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface/50',
                )}
              >
                <span className="font-mono">v{m.version}</span>
                <span className="text-text-dim">
                  {new Date(m.created_at * 1000).toLocaleString('ru-RU', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
                {!isActive && (
                  <button
                    onClick={() => activateVersion(m.version)}
                    className="ml-auto text-[10px] text-accent hover:text-accent/80 transition-colors"
                  >
                    включить
                  </button>
                )}
                {isActive && (
                  <span className="ml-auto text-[10px] text-accent flex items-center gap-1">
                    <Check className="w-3 h-3" /> активна
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded border border-border bg-surface/50 p-2 text-[10px] text-text-dim leading-relaxed">
        Обучение идёт на отдельном движке (Python) и не мешает разговору.
        Обычно занимает 5-30 секунд. Новые версии можно включать и отключать —
        если новый стиль не понравится, всегда можно вернуться к старому.
      </div>
    </div>
  );
}
