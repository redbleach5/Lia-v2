'use client';

// ============================================================================
// SettingsDialog — главное окно настроек.
// ============================================================================
//
// Тонкая обёртка: управляет open/close, loading, form state, refresh.
// Вся логика табов вынесена в отдельные компоненты:
//   - settings/model-tab.tsx    — ModelTab
//   - settings/avatar-tab.tsx   — AvatarTab
//   - settings/learning-tab.tsx — LearningTab
//   - settings/about-tab.tsx    — AboutTab
//
// Разделение god-component (1228 строк) на 4 таб-компонента + shared helpers
// было сделано в Phase 2.4 для улучшения поддерживаемости.

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Settings as SettingsIcon,
  MessageSquare,
  User,
  GraduationCap,
  Info,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_AVATAR_CONFIG,
  parseAvatarConfig,
  type AvatarConfig,
} from '@/lib/avatar-config';
import { ModelTab } from './settings/model-tab';
import { AvatarTab } from './settings/avatar-tab';
import { LearningTab } from './settings/learning-tab';
import { AboutTab } from './settings/about-tab';
import type { Settings, RLStats } from './settings/types';

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rlStats, setRlStats] = useState<RLStats | null>(null);
  const [loading, setLoading] = useState(false);

  // Form state — общее для ModelTab и AvatarTab.
  // Каждый tab читает и обновляет свои поля.
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [embedModel, setEmbedModel] = useState('auto');
  const [avatarMode, setAvatarMode] = useState<'live2d' | '3d'>('3d');
  const [activeVrm, setActiveVrm] = useState<string | null>(null);
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR_CONFIG);

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

            <TabsContent value="model">
              <ModelTab
                settings={settings}
                baseUrl={baseUrl}
                model={model}
                embedModel={embedModel}
                setBaseUrl={setBaseUrl}
                setModel={setModel}
                setEmbedModel={setEmbedModel}
                onSaved={refresh}
              />
            </TabsContent>

            <TabsContent value="avatar">
              <AvatarTab
                settings={settings}
                avatarMode={avatarMode}
                activeVrm={activeVrm}
                avatarConfig={avatarConfig}
                setAvatarMode={setAvatarMode}
                setActiveVrm={setActiveVrm}
                setAvatarConfig={setAvatarConfig}
                onSaved={refresh}
                onUploadComplete={refresh}
              />
            </TabsContent>

            <TabsContent value="learning">
              <LearningTab
                rlStats={rlStats}
                onRefresh={refresh}
              />
            </TabsContent>

            <TabsContent value="about">
              <AboutTab />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
