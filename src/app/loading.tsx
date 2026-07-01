// Loading state — показывается при начальной загрузке page.tsx (Server Component).

export default function Loading() {
  return (
    <div className="h-screen flex flex-col items-center justify-center gap-3 bg-background">
      <div className="w-8 h-8 rounded-md bg-accent flex items-center justify-center">
        <span className="text-sm font-bold text-background animate-pulse">Л</span>
      </div>
      <div className="text-sm text-text-dim">Загрузка…</div>
    </div>
  );
}
