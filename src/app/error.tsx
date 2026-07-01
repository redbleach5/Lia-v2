'use client';

// ============================================================================
// Global error boundary — показывается если весь page.tsx крашится.
// ============================================================================

import { AlertCircle, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <div className="h-screen flex flex-col items-center justify-center gap-4 p-6 bg-background text-foreground">
      <AlertCircle className="w-12 h-12 text-destructive" />
      <div className="text-lg font-medium">Что-то пошло не так</div>
      <div className="text-sm text-muted-foreground text-center max-w-md">
        {error.message || 'Произошла непредвиденная ошибка.'}
        {error.digest && (
          <div className="mt-1 text-xs text-text-dim font-mono">ID: {error.digest}</div>
        )}
      </div>
      <button
        onClick={reset}
        className="flex items-center gap-2 px-4 py-2 rounded-md bg-accent hover:bg-accent/90 text-background text-sm transition-colors"
      >
        <RotateCcw className="w-4 h-4" />
        Попробовать снова
      </button>
    </div>
  );
}
