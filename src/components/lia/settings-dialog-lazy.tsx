'use client';

// ============================================================================
// SettingsDialogLazy — code-splitting обёртка для SettingsDialog.
// ============================================================================
//
// SettingsDialog (~1000 строк с tab-компонентами) грузится только когда
// пользователь открывает настройки. До этого — только иконка шестерёнки.
//
// next/dynamic с ssr: false — компонент не попадает в server bundle,
// грузится отдельным chunk'ом при первом клике.

import dynamic from 'next/dynamic';
import { Settings as SettingsIcon } from 'lucide-react';
import { useState } from 'react';

// Lazy-load SettingsDialog — отдельный chunk
const SettingsDialog = dynamic(
  () => import('@/components/lia/settings-dialog').then(m => ({ default: m.SettingsDialog })),
  {
    ssr: false,
    loading: () => (
      <button
        className="p-2 rounded-md hover:bg-surface-2 transition-colors text-muted-foreground"
        disabled
      >
        <SettingsIcon className="w-4 h-4 animate-pulse" />
      </button>
    ),
  },
);

export function SettingsDialogLazy() {
  const [hasOpened, setHasOpened] = useState(false);

  // Рендерим lazy SettingsDialog только после первого клика.
  // До клика — показываем иконку, но не грузим chunk.
  if (!hasOpened) {
    return (
      <button
        onClick={() => setHasOpened(true)}
        className="p-2 rounded-md hover:bg-surface-2 transition-colors text-muted-foreground hover:text-foreground"
        title="Настройки"
        aria-label="Открыть настройки"
      >
        <SettingsIcon className="w-4 h-4" />
      </button>
    );
  }

  return <SettingsDialog />;
}
