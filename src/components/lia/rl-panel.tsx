'use client';

// RL Panel — управление обучаемой личностью.
//
// Показывает:
//   - Статус sidecar (запущен / нет)
//   - Кол-во накопленных experiences (тренировочных данных)
//   - Список версий политик
//   - Активную версию
//   - Кнопку «Обучить новую политику»
//   - Кнопку «Активировать» для каждой версии
//   - Превью reward-функции (read-only)

import { useEffect, useState } from 'react';
import {
  Brain,
  RefreshCw,
  Play,
  Check,
  AlertCircle,
  Loader2,
  Cpu,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type RLStats = {
  sidecar_ok: boolean;
  sidecar_stats?: {
    transitions_count: number;
    model_versions: Array<{
      version: number;
      pt_path: string;
      onnx_path: string;
      size_pt_kb: number;
      size_onnx_kb: number;
      created_at: number;
    }>;
    active_version: number | null;
    db_path: string;
  };
  sidecar_error?: string;
  local_experiences: number;
};

export function RLPanel() {
  const [stats, setStats] = useState<RLStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [training, setTraining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trainResult, setTrainResult] = useState<{
    version: number;
    avg_reward: number;
    samples: number;
    duration: number;
  } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/rl/stats');
      const data = await res.json();
      setStats(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const train = async () => {
    setTraining(true);
    setError(null);
    setTrainResult(null);
    try {
      const res = await fetch('/api/rl/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nEpochs: 10 }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setTrainResult({
        version: data.result.version,
        avg_reward: data.result.avg_reward,
        samples: data.result.samples_count,
        duration: data.result.duration_sec,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTraining(false);
    }
  };

  const activate = async (version: number) => {
    try {
      await fetch('/api/rl/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-3.5 h-3.5 text-violet-400" />
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Обучаемая личность
        </h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="ml-auto text-text-dim hover:text-foreground transition-colors"
          title="Обновить"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Sidecar status */}
      <div className={cn(
        'rounded-md border p-2 mb-2 text-[11px] flex items-center gap-2',
        stats?.sidecar_ok
          ? 'border-success/40 bg-success/5 text-success'
          : 'border-warning/40 bg-warning/5 text-warning',
      )}>
        <Cpu className="w-3 h-3 shrink-0" />
        <span>
          {stats?.sidecar_ok
            ? 'Python sidecar запущен'
            : 'Python sidecar не запущен'}
        </span>
        {!stats?.sidecar_ok && (
          <span className="ml-auto text-text-dim text-[10px]">
            запусти: python python-sidecar/main.py
          </span>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 mb-3 text-[11px]">
          <div className="rounded border border-border bg-surface/50 p-2">
            <div className="text-text-dim">Опыт в БД</div>
            <div className="text-base font-mono text-foreground">
              {stats.local_experiences}
            </div>
          </div>
          <div className="rounded border border-border bg-surface/50 p-2">
            <div className="text-text-dim">Моделей</div>
            <div className="text-base font-mono text-foreground">
              {stats.sidecar_stats?.model_versions?.length ?? 0}
            </div>
          </div>
        </div>
      )}

      {/* Active version */}
      {stats?.sidecar_stats?.active_version && (
        <div className="rounded border border-accent/40 bg-accent/5 p-2 mb-2 text-[11px] flex items-center gap-2">
          <Check className="w-3 h-3 text-accent" />
          <span className="text-muted-foreground">Активна:</span>
          <span className="font-mono text-accent">v{stats.sidecar_stats.active_version}</span>
        </div>
      )}

      {/* Train button */}
      <button
        onClick={train}
        disabled={training || !stats?.sidecar_ok}
        className={cn(
          'w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs transition-colors mb-2',
          'border border-border hover:border-accent hover:bg-accent/5',
          (training || !stats?.sidecar_ok) && 'opacity-50 cursor-not-allowed',
        )}
      >
        {training ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Play className="w-3 h-3" />
        )}
        <span>{training ? 'Обучаю…' : 'Обучить новую политику'}</span>
      </button>

      {/* Train result */}
      {trainResult && (
        <div className="rounded border border-success/40 bg-success/5 p-2 mb-2 text-[11px]">
          <div className="flex items-center gap-1.5 text-success mb-1">
            <TrendingUp className="w-3 h-3" />
            <span className="font-medium">Готово: v{trainResult.version}</span>
          </div>
          <div className="text-text-dim">
            avg reward: <span className="font-mono text-foreground">{trainResult.avg_reward.toFixed(3)}</span>
          </div>
          <div className="text-text-dim">
            samples: <span className="font-mono text-foreground">{trainResult.samples}</span>
            {' · '}
            duration: <span className="font-mono text-foreground">{trainResult.duration.toFixed(1)}s</span>
          </div>
        </div>
      )}

      {/* Model versions list */}
      {stats?.sidecar_stats?.model_versions && stats.sidecar_stats.model_versions.length > 0 && (
        <div className="space-y-1 mt-2">
          <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">
            Версии
          </div>
          {stats.sidecar_stats.model_versions.map(m => {
            const isActive = m.version === stats.sidecar_stats?.active_version;
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
                  {m.size_onnx_kb.toFixed(0)} КБ
                </span>
                {!isActive && (
                  <button
                    onClick={() => activate(m.version)}
                    className="ml-auto text-[10px] text-accent hover:text-accent/80 transition-colors"
                  >
                    активировать
                  </button>
                )}
                {isActive && (
                  <Check className="ml-auto w-3 h-3 text-accent" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-2 mt-2 text-[11px] text-destructive flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      {/* Reward function note */}
      <div className="mt-3 p-2 rounded border border-border bg-surface/30 text-[10px] text-text-dim leading-relaxed">
        Reward-функция редактируется в <code className="font-mono">python-sidecar/rl/reward.py</code>.
        Sidecar перезагружает её при каждом обучении.
      </div>
    </div>
  );
}
