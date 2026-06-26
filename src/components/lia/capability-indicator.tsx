'use client';

// Capability indicator — показывает текущий tier Лии (Микро/Стандарт/Плюс/Максимум).
//
// Маленький badge в правой колонке. Пользователь видит на что способна Lia
// прямо сейчас, без необходимости открывать настройки.

import { useEffect, useState } from 'react';
import { Cpu, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

type CapabilityInfo = {
  profile: {
    tier: string;
    modelSize: number;
    modelName: string;
    vramGb: number;
    gpuCount: number;
    gpuName: string | null;
    isCpuOnly: boolean;
  } | null;
  tierInfo: {
    label: string;
    description: string;
    color: string;
  } | null;
};

const TIER_COLORS: Record<string, string> = {
  micro: 'border-amber-500/40 bg-amber-500/5 text-amber-500',
  standard: 'border-sky-500/40 bg-sky-500/5 text-sky-500',
  plus: 'border-violet-500/40 bg-violet-500/5 text-violet-500',
  max: 'border-rose-500/40 bg-rose-500/5 text-rose-500',
};

export function CapabilityIndicator() {
  const [info, setInfo] = useState<CapabilityInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/capability');
      const data = await res.json();
      setInfo(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  const forceRefresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/capability/refresh', { method: 'POST' });
      const data = await res.json();
      setInfo(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (!info?.profile) {
    return null;
  }

  const tier = info.profile.tier;
  const tierColor = TIER_COLORS[tier] ?? 'border-border bg-surface text-muted-foreground';

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Режим
        </h3>
        <button
          onClick={forceRefresh}
          disabled={loading}
          className="ml-auto text-text-dim hover:text-foreground transition-colors"
          title="Перепроверить"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>

      <div className={cn('rounded-md border p-2.5', tierColor)}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium">
            {info.tierInfo?.label ?? tier}
          </span>
          <span className="text-[10px] opacity-70 ml-auto">
            {info.profile.modelSize > 0
              ? `${info.profile.modelSize}B`
              : info.profile.modelName}
          </span>
        </div>
        <div className="text-[10px] opacity-80 leading-relaxed">
          {info.tierInfo?.description}
        </div>
        {(info.profile.gpuCount > 0 || info.profile.isCpuOnly) && (
          <div className="text-[10px] opacity-60 mt-1">
            {info.profile.isCpuOnly
              ? 'CPU режим'
              : `${info.profile.gpuName ?? 'GPU'} · ${info.profile.vramGb.toFixed(0)} GB${info.profile.gpuCount > 1 ? ` × ${info.profile.gpuCount}` : ''}`}
          </div>
        )}
      </div>
    </div>
  );
}
