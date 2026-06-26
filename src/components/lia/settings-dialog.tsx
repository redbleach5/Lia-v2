'use client';

// Settings dialog — все настройки Lia в одном окне.
//
// Разделы:
//   1. Ollama — URL, выбор модели диалога, выбор embed-модели
//   2. Аватар — 2D/3D, выбор VRM файла, загрузка своего, скачивание sample
//   3. О Lia — версия, ссылка на GitHub

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
  Server,
  User,
  Info,
  Check,
  Loader2,
  Upload,
  Download,
  AlertCircle,
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
  availableEmbedModels: string[];
  vrmFiles: string[];
  activeVrm: string | null;
  avatarMode: string;
};

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Form state
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [embedModel, setEmbedModel] = useState('');
  const [avatarMode, setAvatarMode] = useState<'2d' | '3d'>('3d');
  const [activeVrm, setActiveVrm] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data);
      setBaseUrl(data.baseUrl ?? '');
      setModel(data.model ?? '');
      setEmbedModel(data.embedModel ?? '');
      setAvatarMode(data.avatarMode === '2d' ? '2d' : '3d');
      setActiveVrm(data.activeVrm);
    } catch (e) {
      toast.error('Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const saveOllama = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, model, embedModel }),
      });
      if (!res.ok) throw new Error('Save failed');
      toast.success('Настройки Ollama сохранены');
      await refresh();
    } catch (e) {
      toast.error('Не удалось сохранить настройки');
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
      toast.success('Настройки аватара сохранены');
      // Force page reload to apply VRM change
      window.location.reload();
    } catch (e) {
      toast.error('Не удалось сохранить настройки аватара');
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

      const res = await fetch('/api/settings/upload-vrm', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Upload failed');
      }

      toast.success(`VRM загружен: ${data.filename} (${data.sizeMb} МБ)`);
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
      if (!res.ok) {
        throw new Error(data.error || 'Download failed');
      }
      toast.success(data.alreadyExisted ? 'Sample VRM уже был скачан' : `Sample VRM скачан (${data.sizeMb} МБ)`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Скачивание не удалось');
    } finally {
      setDownloading(false);
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
      <DialogContent className="max-w-2xl bg-popover border-border">
        <DialogHeader>
          <DialogTitle>Настройки</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          </div>
        )}

        {settings && !loading && (
          <Tabs defaultValue="ollama" className="w-full">
            <TabsList className="grid grid-cols-3 mb-4">
              <TabsTrigger value="ollama" className="text-xs">
                <Server className="w-3 h-3 mr-1.5" />
                Ollama
              </TabsTrigger>
              <TabsTrigger value="avatar" className="text-xs">
                <User className="w-3 h-3 mr-1.5" />
                Аватар
              </TabsTrigger>
              <TabsTrigger value="about" className="text-xs">
                <Info className="w-3 h-3 mr-1.5" />
                О Lia
              </TabsTrigger>
            </TabsList>

            {/* ── Ollama tab ── */}
            <TabsContent value="ollama" className="space-y-4">
              {/* Connection status */}
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
                    ? `Ollama подключена · ${settings.availableModels.length} моделей доступно`
                    : `Не удалось подключиться к Ollama${settings.ollamaError ? `: ${settings.ollamaError}` : ''}`}
                </span>
              </div>

              {/* Base URL */}
              <div className="space-y-1.5">
                <Label htmlFor="baseUrl" className="text-xs">URL Ollama</Label>
                <Input
                  id="baseUrl"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://127.0.0.1:11434"
                  className="text-sm font-mono"
                />
                <p className="text-[10px] text-text-dim">
                  По умолчанию Ollama слушает на http://127.0.0.1:11434
                </p>
              </div>

              {/* Dialog model */}
              <div className="space-y-1.5">
                <Label className="text-xs">Модель диалога</Label>
                {settings.availableModels.length === 0 ? (
                  <p className="text-xs text-text-dim">
                    Нет доступных моделей. Запусти Ollama и скачай модель: <code className="font-mono">ollama pull qwen2.5:7b</code>
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
                <Label className="text-xs">Embedding-модель (для памяти)</Label>
                {settings.availableEmbedModels.length === 0 ? (
                  <p className="text-xs text-text-dim">
                    Нет embedding-моделей. Скачай: <code className="font-mono">ollama pull nomic-embed-text</code>
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-1">
                    {settings.availableEmbedModels.map(m => (
                      <button
                        key={m}
                        onClick={() => setEmbedModel(m)}
                        className={cn(
                          'text-left text-xs px-2 py-1.5 rounded border transition-colors',
                          embedModel === m
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border hover:border-accent/50',
                        )}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate font-mono">{m}</span>
                          {embedModel === m && <Check className="w-3 h-3 shrink-0" />}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <Button
                onClick={saveOllama}
                disabled={saving}
                className="w-full"
                size="sm"
              >
                {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : null}
                Сохранить настройки Ollama
              </Button>
            </TabsContent>

            {/* ── Avatar tab ── */}
            <TabsContent value="avatar" className="space-y-4">
              {/* Mode: 2D / 3D */}
              <div className="space-y-1.5">
                <Label className="text-xs">Тип аватара</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setAvatarMode('2d')}
                    className={cn(
                      'rounded-md border p-3 text-left transition-colors',
                      avatarMode === '2d'
                        ? 'border-accent bg-accent/10'
                        : 'border-border hover:border-accent/50',
                    )}
                  >
                    <div className="text-xs font-medium mb-0.5">2D SVG</div>
                    <div className="text-[10px] text-text-dim">Лёгкий, быстрый, работает везде</div>
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
                    <div className="text-[10px] text-text-dim">Полноценный 3D-аватар с эмоциями</div>
                  </button>
                </div>
              </div>

              {/* VRM model selection (only for 3D) */}
              {avatarMode === '3d' && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">VRM-модель</Label>
                    {settings.vrmFiles.length === 0 ? (
                      <div className="rounded border border-warning/40 bg-warning/5 p-3 text-xs text-warning flex items-start gap-2">
                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <p className="mb-2">Нет VRM-моделей. Можно:</p>
                          <div className="flex gap-2">
                            <button
                              onClick={handleDownloadSample}
                              disabled={downloading}
                              className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors text-[11px]"
                            >
                              {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                              Скачать sample
                            </button>
                            <span className="text-text-dim text-[11px] self-center">или</span>
                            <button
                              onClick={() => fileInputRef.current?.click()}
                              disabled={uploading}
                              className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors text-[11px]"
                            >
                              {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                              Загрузить свой
                            </button>
                          </div>
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
                            Скачать sample
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
                    Создать свой VRM: <a href="https://vroid.com/en/studio" target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">VRoid Studio</a> (бесплатно)
                  </div>
                </>
              )}

              <Button
                onClick={saveAvatar}
                disabled={saving}
                className="w-full"
                size="sm"
              >
                {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : null}
                Сохранить настройки аватара
              </Button>
            </TabsContent>

            {/* ── About tab ── */}
            <TabsContent value="about" className="space-y-3">
              <div className="rounded-md border border-border bg-surface/50 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-md bg-accent flex items-center justify-center">
                    <span className="text-sm font-bold text-white">Л</span>
                  </div>
                  <div>
                    <div className="text-sm font-medium">Лия v2.0</div>
                    <div className="text-[10px] text-text-dim">Personal AI Companion</div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Тёплый собеседник и помощник с собственным характером.
                  Local-first: все данные остаются на твоей машине.
                </p>
                <div className="flex gap-3 pt-2 text-[11px]">
                  <a
                    href="https://github.com/redbleach5/Lia-v2"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline"
                  >
                    GitHub репозиторий
                  </a>
                  <a
                    href="https://vroid.com/en/studio"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline"
                  >
                    VRoid Studio
                  </a>
                  <a
                    href="https://ollama.com"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline"
                  >
                    Ollama
                  </a>
                </div>
              </div>

              <div className="rounded-md border border-border bg-surface/50 p-3 text-[11px] text-muted-foreground leading-relaxed">
                <div className="font-medium text-foreground mb-1">Технологии</div>
                Next.js 16 · React 19 · TypeScript · Tailwind 4 · shadcn/ui ·
                Prisma + SQLite + sqlite-vec · Vercel AI SDK v5 ·
                three.js + @pixiv/three-vrm · Python + PyTorch (RL)
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
