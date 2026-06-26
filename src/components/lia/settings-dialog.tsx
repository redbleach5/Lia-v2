'use client';

// Настройки Лии — все в одном окне, простым языком.
//
// Разделы:
//   1. Языковая модель — какую модель Ollama использует Лия для разговора
//   2. Внешний вид — выбор аватара (Live2D или 3D VRM), загрузка своих моделей
//   3. Обучение — управление стилем общения Лии (бывший RL sidecar)
//   4. О Лии — версия и краткое описание

import { useEffect, useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Settings as SettingsIcon,
  MessageSquare,
  User,
  GraduationCap,
  Info,
  Check,
  Loader2,
  Upload,
  Download,
  AlertCircle,
  Play,
  Square,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type Settings = {
  baseUrl: string;
  model: string;
  embedModel: string;
  ollamaOk: boolean;
  ollamaError?: string;
  availableModels: string[];
  hasEmbedModel: boolean;
  vrmFiles: string[];
  activeVrm: string | null;
  avatarMode: string;
};

type RLStats = {
  sidecar_ok: boolean;
  sidecar_stats?: {
    transitions_count: number;
    model_versions: Array<{
      version: number;
      size_onnx_kb: number;
      created_at: number;
    }>;
    active_version: number | null;
  };
  sidecar_error?: string;
  local_experiences: number;
};

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rlStats, setRlStats] = useState<RLStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [training, setTraining] = useState(false);
  const [startingEngine, setStartingEngine] = useState(false);

  // Form state
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [avatarMode, setAvatarMode] = useState<'live2d' | '3d'>('3d');
  const [activeVrm, setActiveVrm] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [settingsRes, rlRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/rl/stats'),
      ]);
      const settingsData = await settingsRes.json();
      const rlData = await rlRes.json();
      setSettings(settingsData);
      setRlStats(rlData);
      setBaseUrl(settingsData.baseUrl ?? '');
      setModel(settingsData.model ?? '');
      setAvatarMode(settingsData.avatarMode === 'live2d' ? 'live2d' : '3d');
      setActiveVrm(settingsData.activeVrm);
    } catch {
      toast.error('Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const saveModel = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, model }),
      });
      if (!res.ok) throw new Error('Save failed');
      toast.success('Настройки модели сохранены');
      await refresh();
    } catch {
      toast.error('Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const saveAvatar = async () => {
    setSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarMode, activeVrm }),
      });
      toast.success('Настройки внешнего вида сохранены');
      window.location.reload();
    } catch {
      toast.error('Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/settings/upload-vrm', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast.success(`Модель загружена: ${data.filename}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Загрузка не удалась');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownloadSample = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/api/settings/download-vrm', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Download failed');
      toast.success(data.alreadyExisted ? 'Образец уже был скачан' : 'Образец модели скачан');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Скачивание не удалось');
    } finally {
      setDownloading(false);
    }
  };

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
      // Wait a bit then refresh
      setTimeout(() => refresh(), 3000);
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
      await refresh();
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
      await refresh();
    } catch {
      toast.error('Не удалось активировать');
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="p-2 rounded-md hover:bg-surface-2 transition-colors text-muted-foreground hover:text-foreground"
          title="Настройки"
        >
          <SettingsIcon className="w-4 h-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl bg-popover border-border max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Настройки</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          </div>
        )}

        {settings && !loading && (
          <Tabs defaultValue="model" className="w-full">
            <TabsList className="grid grid-cols-4 mb-4">
              <TabsTrigger value="model" className="text-xs">
                <MessageSquare className="w-3 h-3 mr-1.5" />
                Модель
              </TabsTrigger>
              <TabsTrigger value="avatar" className="text-xs">
                <User className="w-3 h-3 mr-1.5" />
                Внешний вид
              </TabsTrigger>
              <TabsTrigger value="learning" className="text-xs">
                <GraduationCap className="w-3 h-3 mr-1.5" />
                Обучение
              </TabsTrigger>
              <TabsTrigger value="about" className="text-xs">
                <Info className="w-3 h-3 mr-1.5" />
                О Лии
              </TabsTrigger>
            </TabsList>

            {/* ── Модель ── */}
            <TabsContent value="model" className="space-y-4">
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

              {/* Подсказка про память */}
              {!settings.hasEmbedModel && settings.ollamaOk && (
                <div className="rounded border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    Для долговременной памяти Лии нужна специальная модель (nomic-embed-text).
                    Скачай её в программе Ollama, чтобы Лия запоминала ваши разговоры.
                  </span>
                </div>
              )}

              <Button onClick={saveModel} disabled={saving} className="w-full" size="sm">
                {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : null}
                Сохранить
              </Button>
            </TabsContent>

            {/* ── Внешний вид ── */}
            <TabsContent value="avatar" className="space-y-4">
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
                  <div className="space-y-1.5">
                    <Label className="text-xs">3D-модель персонажа</Label>
                    {settings.vrmFiles.length === 0 ? (
                      <div className="rounded border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
                        <p className="mb-2">Нет 3D-моделей. Можно:</p>
                        <div className="flex gap-2 flex-wrap">
                          <button
                            onClick={handleDownloadSample}
                            disabled={downloading}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors text-[11px]"
                          >
                            {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                            Скачать готовую
                          </button>
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors text-[11px]"
                          >
                            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
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
                            disabled={uploading}
                            className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:border-accent/50 text-xs transition-colors"
                          >
                            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                            Загрузить ещё
                          </button>
                          <button
                            onClick={handleDownloadSample}
                            disabled={downloading}
                            className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:border-accent/50 text-xs transition-colors"
                          >
                            {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
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
            </TabsContent>

            {/* ── Обучение ── */}
            <TabsContent value="learning" className="space-y-4">
              <div className="rounded-md border border-border bg-surface/50 p-3 text-xs leading-relaxed">
                <p className="font-medium text-foreground mb-1">Что это такое?</p>
                <p className="text-muted-foreground">
                  Лия может учиться на твоих разговорах и подстраивать свой стиль общения:
                  быть теплее или сдержаннее, задавать больше вопросов или давать развёрнутые ответы.
                  Чем больше вы общаетесь — тем точнее Лия понимает, как тебе комфортнее.
                </p>
              </div>

              {/* Движок обучения status */}
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
            </TabsContent>

            {/* ── О Лии ── */}
            <TabsContent value="about" className="space-y-3">
              <div className="rounded-md border border-border bg-surface/50 p-4 space-y-2">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-md bg-accent flex items-center justify-center">
                    <span className="text-base font-bold text-white">Л</span>
                  </div>
                  <div>
                    <div className="text-sm font-medium">Лия v2.0</div>
                    <div className="text-[10px] text-text-dim">тёплый собеседник и помощник</div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Лия — это твой персональный ИИ-компаньон. Все разговоры остаются на твоём компьютере,
                  ничего не отправляется в интернет. Лия умеет запоминать факты о тебе, искать информацию,
                  сохранять файлы, и подстраивает свой стиль общения под тебя.
                </p>
              </div>

              <div className="rounded-md border border-border bg-surface/50 p-3 text-[11px] text-muted-foreground">
                <div className="font-medium text-foreground mb-1">Технические детали (для интересующихся)</div>
                Основана на Next.js 16, React 19, Ollama, sqlite-vec. 3D-аватар через three-vrm.
                Обучение через PyTorch. Полная документация и исходный код — в файле README.md проекта.
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
