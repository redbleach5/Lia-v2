'use client';

// ============================================================================
// AboutTab — информация о Лии, версия, технологии.
// ============================================================================

export function AboutTab() {
  return (
    <div className="space-y-3">
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
    </div>
  );
}
