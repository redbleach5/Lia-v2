'use client';

// ============================================================================
// AvatarTab — выбор аватара (Live2D / 3D VRM) + тонкая настройка 3D-модели.
// ============================================================================
//
// Самый большой таб: камера, платформа, фон, освещение, тело, анимации.
// Все настройки хранятся в avatarConfig (AvatarConfig из lib/avatar-config.ts).

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Check, Loader2, Upload, Download, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  DEFAULT_AVATAR_CONFIG,
  type AvatarConfig,
  type CameraPreset,
  type PlatformShape,
  type RingAnimation,
  type BackgroundStyle,
  type LightingPreset,
  type ArmPose,
} from '@/lib/avatar-config';
import type { Settings } from './types';
import { LabelBlock, ToggleRow } from './avatar-helpers';

type AvatarTabProps = {
  settings: Settings;
  avatarMode: 'live2d' | '3d';
  activeVrm: string | null;
  avatarConfig: AvatarConfig;
  setAvatarMode: (v: 'live2d' | '3d') => void;
  setActiveVrm: (v: string | null) => void;
  setAvatarConfig: (v: AvatarConfig) => void;
  onSaved: () => Promise<void>;  // refresh после save
  onUploadComplete: () => Promise<void>;  // refresh после upload
};

export function AvatarTab({
  settings,
  avatarMode,
  activeVrm,
  avatarConfig,
  setAvatarMode,
  setActiveVrm,
  setAvatarConfig,
  onSaved,
  onUploadComplete,
}: AvatarTabProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);

  const saveAvatar = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarMode, activeVrm, avatarConfig }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      toast.success('Настройки внешнего вида сохранены');
      await onSaved();
      window.dispatchEvent(new CustomEvent('lia-settings-changed'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Не удалось сохранить: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const resetAvatarConfig = () => {
    setAvatarConfig({ ...DEFAULT_AVATAR_CONFIG });
    toast.info('Сброшено к значениям по умолчанию. Не забудь сохранить.');
  };

  const updateConfig = <K extends keyof AvatarConfig>(section: K, patch: Partial<AvatarConfig[K]>) => {
    setAvatarConfig({ ...avatarConfig, [section]: { ...avatarConfig[section], ...patch } });
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/settings/upload-vrm', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast.success(`Модель загружена: ${data.filename}`);
      await onUploadComplete();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Загрузка не удалась');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownloadSample = async () => {
    try {
      const res = await fetch('/api/settings/download-vrm', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Download failed');
      toast.success(data.alreadyExisted ? 'Образец уже был скачан' : 'Образец модели скачан');
      await onUploadComplete();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Скачивание не удалось');
    }
  };

  return (
    <div className="space-y-4">
      {/* Тип аватара */}
      <div className="space-y-1.5">
        <Label className="text-xs">Тип аватара</Label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setAvatarMode('live2d')}
            className={cn(
              'rounded-md border p-3 text-left transition-colors',
              avatarMode === 'live2d'
                ? 'border-accent bg-accent/10'
                : 'border-border hover:border-accent/50',
            )}
          >
            <div className="text-xs font-medium mb-0.5">Live2D</div>
            <div className="text-[10px] text-text-dim">Анимированный 2D-аватар</div>
          </button>
          <button
            onClick={() => setAvatarMode('3d')}
            className={cn(
              'rounded-md border p-3 text-left transition-colors',
              avatarMode === '3d'
                ? 'border-accent bg-accent/10'
                : 'border-border hover:border-accent/50',
            )}
          >
            <div className="text-xs font-medium mb-0.5">3D VRM</div>
            <div className="text-[10px] text-text-dim">Полноценная 3D-модель с эмоциями</div>
          </button>
        </div>
      </div>

      {avatarMode === '3d' && (
        <>
          {/* Выбор 3D-модели */}
          <div className="space-y-1.5">
            <Label className="text-xs">3D-модель персонажа</Label>
            {settings.vrmFiles.length === 0 ? (
              <div className="rounded border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
                <p className="mb-2">Нет 3D-моделей. Можно:</p>
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={handleDownloadSample}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors text-[11px]"
                  >
                    <Download className="w-3 h-3" />
                    Скачать готовую
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors text-[11px]"
                  >
                    <Upload className="w-3 h-3" />
                    Загрузить свою
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {settings.vrmFiles.map(url => {
                    const filename = url.split('/').pop() ?? url;
                    return (
                      <button
                        key={url}
                        onClick={() => setActiveVrm(url)}
                        className={cn(
                          'w-full text-left text-xs px-2 py-1.5 rounded border transition-colors flex items-center gap-2',
                          activeVrm === url
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border hover:border-accent/50',
                        )}
                      >
                        <span className="truncate font-mono flex-1">{filename}</span>
                        {activeVrm === url && <Check className="w-3 h-3 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:border-accent/50 text-xs transition-colors"
                  >
                    <Upload className="w-3 h-3" />
                    Загрузить ещё
                  </button>
                  <button
                    onClick={handleDownloadSample}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:border-accent/50 text-xs transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    Скачать готовую
                  </button>
                </div>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".vrm"
              onChange={handleUpload}
              className="hidden"
            />
          </div>

          <div className="rounded border border-border bg-surface/50 p-2 text-[10px] text-text-dim">
            Файл модели должен быть в формате .vrm. Создать свою модель можно в бесплатной программе VRoid Studio.
          </div>

          {/* ── Кастомизация аватара ── */}
          <div className="flex items-center justify-between pt-2">
            <Label className="text-xs font-medium">Тонкая настройка аватара</Label>
            <button
              onClick={resetAvatarConfig}
              className="flex items-center gap-1 text-[10px] text-text-dim hover:text-foreground transition-colors"
              title="Сбросить к значениям по умолчанию"
            >
              <RotateCcw className="w-3 h-3" />
              Сбросить
            </button>
          </div>

          {/* Камера */}
          <div className="rounded-md border border-border bg-surface/40 p-3 space-y-2.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Камера
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {([
                ['portrait', 'По грудь'],
                ['fullbody', 'В полный рост'],
                ['closeup', 'Крупный план'],
                ['custom', 'Своя'],
              ] as Array<[CameraPreset, string]>).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => updateConfig('camera', { preset: id })}
                  className={cn(
                    'text-[10px] px-2 py-1.5 rounded border transition-colors',
                    avatarConfig.camera.preset === id
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border hover:border-accent/50',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {avatarConfig.camera.preset === 'custom' && (
              <div className="grid grid-cols-3 gap-2 pt-1">
                <LabelBlock label="Угол обзора (°)">
                  <Slider
                    value={[avatarConfig.camera.fov]}
                    min={20}
                    max={65}
                    step={1}
                    onValueChange={([v]) => updateConfig('camera', { fov: v })}
                  />
                  <span className="text-[10px] text-text-dim font-mono">{avatarConfig.camera.fov}°</span>
                </LabelBlock>
              </div>
            )}
            <p className="text-[10px] text-text-dim">
              Колесо мыши над аватаром меняет зум, перетаскивание — поворот.
              Пресеты задают стартовую позицию.
            </p>
          </div>

          {/* Платформа */}
          <div className="rounded-md border border-border bg-surface/40 p-3 space-y-2.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Платформа
            </div>
            <LabelBlock label="Форма">
              <div className="grid grid-cols-5 gap-1.5">
                {([
                  ['disc', 'Диск'],
                  ['hexagon', 'Шестиугольник'],
                  ['ring', 'Кольцо'],
                  ['pedestal', 'Пьедестал'],
                  ['off', 'Без платформы'],
                ] as Array<[PlatformShape, string]>).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => updateConfig('platform', { shape: id })}
                    className={cn(
                      'text-[10px] px-1 py-1.5 rounded border transition-colors',
                      avatarConfig.platform.shape === id
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border hover:border-accent/50',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </LabelBlock>

            {avatarConfig.platform.shape !== 'off' && (
              <>
                <LabelBlock label={`Радиус: ${avatarConfig.platform.radius.toFixed(2)}`}>
                  <Slider
                    value={[avatarConfig.platform.radius]}
                    min={0.25}
                    max={0.6}
                    step={0.01}
                    onValueChange={([v]) => updateConfig('platform', { radius: v })}
                  />
                </LabelBlock>

                <LabelBlock label={`Высота: ${avatarConfig.platform.height.toFixed(2)}`}>
                  <Slider
                    value={[avatarConfig.platform.height]}
                    min={0.02}
                    max={0.2}
                    step={0.01}
                    onValueChange={([v]) => updateConfig('platform', { height: v })}
                  />
                </LabelBlock>

                <LabelBlock label={`Непрозрачность: ${Math.round(avatarConfig.platform.opacity * 100)}%`}>
                  <Slider
                    value={[avatarConfig.platform.opacity]}
                    min={0.3}
                    max={1}
                    step={0.05}
                    onValueChange={([v]) => updateConfig('platform', { opacity: v })}
                  />
                </LabelBlock>

                <LabelBlock label="Анимация кольца">
                  <div className="grid grid-cols-4 gap-1.5">
                    {([
                      ['solid', 'Постоянное'],
                      ['pulse', 'Пульс'],
                      ['breathing', 'Дыхание'],
                      ['rotate', 'Вращение'],
                    ] as Array<[RingAnimation, string]>).map(([id, label]) => (
                      <button
                        key={id}
                        onClick={() => updateConfig('platform', { ringAnimation: id })}
                        className={cn(
                          'text-[10px] px-1 py-1.5 rounded border transition-colors',
                          avatarConfig.platform.ringAnimation === id
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border hover:border-accent/50',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </LabelBlock>

                {avatarConfig.platform.ringAnimation === 'rotate' && (
                  <LabelBlock label={`Скорость вращения: ${avatarConfig.platform.rotateSpeed.toFixed(2)}×`}>
                    <Slider
                      value={[avatarConfig.platform.rotateSpeed]}
                      min={0.1}
                      max={2}
                      step={0.1}
                      onValueChange={([v]) => updateConfig('platform', { rotateSpeed: v })}
                    />
                  </LabelBlock>
                )}

                <div className="space-y-1.5 pt-1">
                  <ToggleRow
                    label="Внутреннее кольцо"
                    checked={avatarConfig.platform.showInnerRing}
                    onChange={v => updateConfig('platform', { showInnerRing: v })}
                  />
                  <ToggleRow
                    label="Свечение под платформой (halo)"
                    checked={avatarConfig.platform.showHalo}
                    onChange={v => updateConfig('platform', { showHalo: v })}
                  />
                  <ToggleRow
                    label="Контактная тень под аватаром"
                    checked={avatarConfig.platform.showShadow}
                    onChange={v => updateConfig('platform', { showShadow: v })}
                  />
                </div>
              </>
            )}
          </div>

          {/* Фон */}
          <div className="rounded-md border border-border bg-surface/40 p-3 space-y-2.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Фон сцены
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {([
                ['transparent', 'Прозрачный'],
                ['solid', 'Заливка'],
                ['gradient', 'Градиент'],
                ['radial', 'Радиал'],
              ] as Array<[BackgroundStyle, string]>).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => updateConfig('background', { style: id })}
                  className={cn(
                    'text-[10px] px-2 py-1.5 rounded border transition-colors',
                    avatarConfig.background.style === id
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border hover:border-accent/50',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {avatarConfig.background.style !== 'transparent' && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <LabelBlock label="Цвет центра">
                  <Input
                    type="color"
                    value={avatarConfig.background.color}
                    onChange={e => updateConfig('background', { color: e.target.value })}
                    className="h-8 p-1 cursor-pointer"
                  />
                </LabelBlock>
                {(avatarConfig.background.style === 'gradient' || avatarConfig.background.style === 'radial') && (
                  <LabelBlock label="Цвет краёв">
                    <Input
                      type="color"
                      value={avatarConfig.background.edgeColor}
                      onChange={e => updateConfig('background', { edgeColor: e.target.value })}
                      className="h-8 p-1 cursor-pointer"
                    />
                  </LabelBlock>
                )}
              </div>
            )}
          </div>

          {/* Освещение */}
          <div className="rounded-md border border-border bg-surface/40 p-3 space-y-2.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Освещение
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {([
                ['warm', 'Тёплое'],
                ['cool', 'Холодное'],
                ['neutral', 'Нейтральное'],
                ['soft', 'Мягкое'],
                ['dramatic', 'Драма'],
              ] as Array<[LightingPreset, string]>).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => updateConfig('lighting', { preset: id })}
                  className={cn(
                    'text-[10px] px-1 py-1.5 rounded border transition-colors',
                    avatarConfig.lighting.preset === id
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border hover:border-accent/50',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <LabelBlock label={`Яркость: ${Math.round(avatarConfig.lighting.intensity * 100)}%`}>
              <Slider
                value={[avatarConfig.lighting.intensity]}
                min={0.4}
                max={1.6}
                step={0.05}
                onValueChange={([v]) => updateConfig('lighting', { intensity: v })}
              />
            </LabelBlock>
          </div>

          {/* Тело и поза */}
          <div className="rounded-md border border-border bg-surface/40 p-3 space-y-2.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Тело и поза
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {([
                ['natural', 'Естеств.'],
                ['relaxed', 'Расслабл.'],
                ['crossed', 'Скрещен.'],
                ['hands-pockets', 'В карманах'],
                ['t-pose', 'T-pose'],
              ] as Array<[ArmPose, string]>).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => updateConfig('body', { armPose: id })}
                  className={cn(
                    'text-[10px] px-1 py-1.5 rounded border transition-colors',
                    avatarConfig.body.armPose === id
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border hover:border-accent/50',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <LabelBlock label={`Масштаб: ${avatarConfig.body.scale.toFixed(2)}×`}>
              <Slider
                value={[avatarConfig.body.scale]}
                min={0.8}
                max={1.2}
                step={0.01}
                onValueChange={([v]) => updateConfig('body', { scale: v })}
              />
            </LabelBlock>
            <LabelBlock label={`Смещение по Y: ${avatarConfig.body.yOffset.toFixed(2)}`}>
              <Slider
                value={[avatarConfig.body.yOffset]}
                min={-0.15}
                max={0.15}
                step={0.01}
                onValueChange={([v]) => updateConfig('body', { yOffset: v })}
              />
            </LabelBlock>
          </div>

          {/* Движения и анимации */}
          <div className="rounded-md border border-border bg-surface/40 p-3 space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
              Движения и анимации
            </div>
            <div className="text-[10px] text-text-dim mb-2">
              Делают аватар живым. Каждый канал можно включить/выключить отдельно.
            </div>
            <ToggleRow
              label="Дыхание"
              checked={avatarConfig.animation.breathing}
              onChange={v => updateConfig('animation', { breathing: v })}
            />
            <ToggleRow
              label="Моргание (с редкими двойными)"
              checked={avatarConfig.animation.blinking}
              onChange={v => updateConfig('animation', { blinking: v })}
            />
            <ToggleRow
              label="Покачивание головой"
              checked={avatarConfig.animation.headSway}
              onChange={v => updateConfig('animation', { headSway: v })}
            />
            <ToggleRow
              label="Покачивание телом (бёдра + плечи)"
              checked={avatarConfig.animation.bodySway}
              onChange={v => updateConfig('animation', { bodySway: v })}
            />
            <ToggleRow
              label="Микро-движения рук"
              checked={avatarConfig.animation.armSway}
              onChange={v => updateConfig('animation', { armSway: v })}
            />
            <ToggleRow
              label="Перенос веса с ноги на ногу"
              checked={avatarConfig.animation.weightShift}
              onChange={v => updateConfig('animation', { weightShift: v })}
            />
            <ToggleRow
              label="Взгляд следует за курсором"
              checked={avatarConfig.animation.gazeFollow}
              onChange={v => updateConfig('animation', { gazeFollow: v })}
            />
            <ToggleRow
              label="Липсинк при ответе"
              checked={avatarConfig.animation.lipSync}
              onChange={v => updateConfig('animation', { lipSync: v })}
            />
            <ToggleRow
              label="Плавная смена эмоций (мимика)"
              checked={avatarConfig.animation.emotionMorph}
              onChange={v => updateConfig('animation', { emotionMorph: v })}
            />
            <ToggleRow
              label="Эмоциональная поза (плечи, наклон)"
              checked={avatarConfig.animation.emotionPose}
              onChange={v => updateConfig('animation', { emotionPose: v })}
            />

            <div className="pt-2">
              <LabelBlock label={`Частота движений: ${avatarConfig.animation.idleFrequency.toFixed(2)}×`}>
                <Slider
                  value={[avatarConfig.animation.idleFrequency]}
                  min={0.3}
                  max={2}
                  step={0.1}
                  onValueChange={([v]) => updateConfig('animation', { idleFrequency: v })}
                />
                <div className="flex justify-between text-[9px] text-text-dim mt-0.5">
                  <span>спокойно</span>
                  <span>оживлённо</span>
                </div>
              </LabelBlock>
            </div>
          </div>
        </>
      )}

      {avatarMode === 'live2d' && (
        <div className="rounded border border-border bg-surface/50 p-2 text-[10px] text-text-dim">
          Live2D — это технология анимации 2D-изображений. Подходит, если 3D-модели нет или они слишком тяжёлые.
        </div>
      )}

      <Button onClick={saveAvatar} disabled={saving} className="w-full" size="sm">
        {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : null}
        Сохранить
      </Button>
    </div>
  );
}
