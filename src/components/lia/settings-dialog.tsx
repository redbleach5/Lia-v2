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
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
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
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  DEFAULT_AVATAR_CONFIG,
  parseAvatarConfig,
  type AvatarConfig,
  type CameraPreset,
  type PlatformShape,
  type RingAnimation,
  type BackgroundStyle,
  type LightingPreset,
  type ArmPose,
} from '@/lib/avatar-config';

type Settings = {
  baseUrl: string;
  model: string;
  embedModel: string;
  ollamaOk: boolean;
  ollamaError?: string;
  availableModels: string[];
  availableEmbedModels: string[];
  vrmFiles: string[];
  activeVrm: string | null;
  avatarMode: string;
  avatarConfig: AvatarConfig;
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
  const [embedModel, setEmbedModel] = useState('auto');
  const [avatarMode, setAvatarMode] = useState<'live2d' | '3d'>('3d');
  const [activeVrm, setActiveVrm] = useState<string | null>(null);
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR_CONFIG);

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
      setEmbedModel(settingsData.embedModel ?? 'auto');
      setAvatarMode(settingsData.avatarMode === 'live2d' ? 'live2d' : '3d');
      setActiveVrm(settingsData.activeVrm);
      setAvatarConfig(settingsData.avatarConfig
        ? parseAvatarConfig(JSON.stringify(settingsData.avatarConfig))
        : DEFAULT_AVATAR_CONFIG);
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
        body: JSON.stringify({
          baseUrl,
          model,
          // 'auto' means: let the backend pick the best available embed model
          embedModel: embedModel === 'auto' ? '' : embedModel,
        }),
      });
      // Сервер возвращает обновлённые настройки + свежий health-статус.
      // Используем их, чтобы сразу показать пользователю результат.
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = (data as { error?: string }).error || `HTTP ${res.status}`;
        throw new Error(errMsg);
      }
      // Обновляем settings напрямую из ответа POST — refresh() идёт за всем комплектом.
      setSettings(s => s ? { ...s, ...data } : (data as Settings));
      // Проверяем что Ollama ответил на health-check после смены URL.
      if (data.ollamaOk) {
        toast.success('Настройки сохранены. Ollama на связи.');
      } else {
        toast.warning(`Настройки сохранены, но Ollama не отвечает: ${data.ollamaError ?? 'unknown'}`);
      }
      // Всё равно делаем полный refresh чтобы обновить availableModels.
      await refresh();
      // Триггерим событие для OllamaBanner и других компонентов, которые
      // слушают health-статус — они перечитают /api/health.
      window.dispatchEvent(new CustomEvent('lia-settings-changed'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Не удалось сохранить: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

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
      // Обновляем store + AvatarColumn через refresh — без перезагрузки страницы.
      // Раньше тут был window.location.reload() — это ломало текущий чат и эмоции.
      await refresh();
      // Триггерим событие для AvatarColumn и других компонентов, которые
      // читают настройки при mount — они перечитают /api/settings.
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

  // Partial updater — shallow-merges a section of the config
  const updateConfig = <K extends keyof AvatarConfig>(section: K, patch: Partial<AvatarConfig[K]>) => {
    setAvatarConfig(prev => ({ ...prev, [section]: { ...prev[section], ...patch } }));
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

              {/* Модель для памяти (embeddings) */}
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Модель для памяти
                  <span className="text-text-dim font-normal ml-1.5">
                    — запоминает смысл разговоров
                  </span>
                </Label>

                {/* Опция Авто */}
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

                {/* Список доступных embed-моделей */}
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

                {/* Ручной ввод (для нестандартных моделей) */}
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
            </TabsContent>

            {/* ── Внешний вид ── */}
            <TabsContent value="avatar" className="space-y-4">
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
                    {/* Форма платформы */}
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

                        {/* Высота платформы — особенно важна для pedestal */}
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

                        {/* Анимация светящегося кольца */}
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

                        {/* Скорость вращения — только если ringAnimation === 'rotate' */}
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
                    <span className="text-base font-bold text-background">Л</span>
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

// ============================================================================
// Helper: describe an embed model by its name prefix
// ============================================================================
function describeEmbedModel(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (lower.startsWith('nomic-embed-text')) {
    return 'Быстрая и лёгкая. Хорошо для русского и английского. По умолчанию.';
  }
  if (lower.startsWith('bge-m3')) {
    return 'Мультиязычная, поддерживает 100+ языков. Точнее nomic, но медленнее.';
  }
  if (lower.startsWith('bge-')) {
    return 'Серия BGE — хорошие embedding-модели для разных языков.';
  }
  if (lower.startsWith('mxbai-embed-large')) {
    return 'Высокое качество поиска. Точнее nomic, но требует больше памяти.';
  }
  if (lower.startsWith('snowflake-arctic-embed')) {
    return 'Хорошо для поиска по коду и техническим текстам.';
  }
  if (lower.startsWith('e5-')) {
    return 'Серия E5 от Microsoft. Мультиязычная, хорошего качества.';
  }
  return 'Embedding-модель — используется для запоминания смысла текстов.';
}

// ============================================================================
// Avatar customization helpers — LabelBlock (поле с подписью и контентом)
// и ToggleRow (строка с подписью и Switch)
// ============================================================================
function LabelBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

