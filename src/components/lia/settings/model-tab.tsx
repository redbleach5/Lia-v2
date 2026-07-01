'use client';

// ============================================================================
// ModelTab — настройки языковой модели Ollama (URL, model, embed model).
// ============================================================================

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Check, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Settings } from './types';
import { describeEmbedModel } from './describe-embed-model';

type ModelTabProps = {
  settings: Settings;
  // Form state (владелец — parent SettingsDialog)
  baseUrl: string;
  model: string;
  embedModel: string;
  setBaseUrl: (v: string) => void;
  setModel: (v: string) => void;
  setEmbedModel: (v: string) => void;
  onSaved: () => Promise<void>;  // refresh после save
};

export function ModelTab({
  settings,
  baseUrl,
  model,
  embedModel,
  setBaseUrl,
  setModel,
  setEmbedModel,
  onSaved,
}: ModelTabProps) {
  const [saving, setSaving] = useState(false);

  const saveModel = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          model,
          embedModel: embedModel === 'auto' ? '' : embedModel,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = (data as { error?: string }).error || `HTTP ${res.status}`;
        throw new Error(errMsg);
      }
      if (data.ollamaOk) {
        toast.success('Настройки сохранены. Ollama на связи.');
      } else {
        toast.warning(`Настройки сохранены, но Ollama не отвечает: ${data.ollamaError ?? 'unknown'}`);
      }
      await onSaved();
      window.dispatchEvent(new CustomEvent('lia-settings-changed'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Не удалось сохранить: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Ollama health status */}
      <div className={cn(
        'rounded-md border p-3 text-xs flex items-center gap-2',
        settings.ollamaOk
          ? 'border-success/40 bg-success/5 text-success'
          : 'border-warning/40 bg-warning/5 text-warning',
      )}>
        <div className={cn(
          'w-2 h-2 rounded-full',
          settings.ollamaOk ? 'bg-success' : 'bg-warning',
        )} />
        <span className="flex-1">
          {settings.ollamaOk
            ? `Ollama подключена · доступно моделей: ${settings.availableModels.length}`
            : 'Не удалось подключиться к Ollama. Проверь, что программа запущена.'}
        </span>
      </div>

      {/* Base URL */}
      <div className="space-y-1.5">
        <Label htmlFor="baseUrl" className="text-xs">Адрес сервера Ollama</Label>
        <Input
          id="baseUrl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://127.0.0.1:11434"
          className="text-sm font-mono"
        />
        <p className="text-[10px] text-text-dim">
          Обычно Ollama работает на этом адресе по умолчанию
        </p>
      </div>

      {/* Chat model */}
      <div className="space-y-1.5">
        <Label className="text-xs">Модель для разговора</Label>
        {settings.availableModels.length === 0 ? (
          <p className="text-xs text-text-dim">
            Нет доступных моделей. Открой программу Ollama и скачай модель — например qwen2.5:7b
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
            {settings.availableModels.map(m => (
              <button
                key={m}
                onClick={() => setModel(m)}
                className={cn(
                  'text-left text-xs px-2 py-1.5 rounded border transition-colors',
                  model === m
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border hover:border-accent/50',
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-mono">{m}</span>
                  {model === m && <Check className="w-3 h-3 shrink-0" />}
                </div>
              </button>
            ))}
          </div>
        )}
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="qwen2.5:7b"
          className="text-sm font-mono mt-1"
        />
      </div>

      {/* Embed model */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          Модель для памяти
          <span className="text-text-dim font-normal ml-1.5">
            — запоминает смысл разговоров
          </span>
        </Label>

        <button
          onClick={() => setEmbedModel('auto')}
          className={cn(
            'w-full text-left text-xs px-2 py-1.5 rounded border transition-colors flex items-start gap-2',
            embedModel === 'auto'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border hover:border-accent/50',
          )}
        >
          <div className="flex-1">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium">Авто</span>
              {embedModel === 'auto' && <Check className="w-3 h-3 shrink-0" />}
            </div>
            <div className="text-[10px] text-text-dim mt-0.5">
              Лия сама выберет подходящую модель из доступных
            </div>
          </div>
        </button>

        {settings.availableEmbedModels.length > 0 ? (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {settings.availableEmbedModels.map(m => (
              <button
                key={m}
                onClick={() => setEmbedModel(m)}
                className={cn(
                  'w-full text-left text-xs px-2 py-1.5 rounded border transition-colors',
                  embedModel === m
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border hover:border-accent/50',
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-mono">{m}</span>
                  {embedModel === m && <Check className="w-3 h-3 shrink-0" />}
                </div>
                <div className="text-[10px] text-text-dim mt-0.5">
                  {describeEmbedModel(m)}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Не найдено моделей для памяти. Скачай любую из них в Ollama:
              <code className="font-mono ml-1">nomic-embed-text</code>,
              <code className="font-mono ml-1">bge-m3</code>,
              <code className="font-mono ml-1">mxbai-embed-large</code>.
              Без этого Лия не сможет запоминать разговоры.
            </span>
          </div>
        )}

        <details className="mt-1">
          <summary className="text-[10px] text-text-dim cursor-pointer hover:text-foreground">
            Указать вручную
          </summary>
          <Input
            value={embedModel === 'auto' ? '' : embedModel}
            onChange={(e) => setEmbedModel(e.target.value || 'auto')}
            placeholder="например, bge-m3:latest"
            className="text-sm font-mono mt-1"
          />
        </details>
      </div>

      <Button onClick={saveModel} disabled={saving} className="w-full" size="sm">
        {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : null}
        Сохранить
      </Button>
    </div>
  );
}
