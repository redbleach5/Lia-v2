# db-init.ps1 — идемпотентная инициализация БД (Windows / PowerShell)
#
# Проблема: prisma db push падает если БД уже содержит vec_virtual (virtual table),
# потому что Prisma не может описать virtual tables при сравнении схемы.
#
# Решение: делать db push только если БД не существует. Если существует —
# пропускаем (схема уже применена, vec_virtual создаётся в db-vec.ts при
# первом подключении).
#
# Для смены схемы: удали db\custom.db вручную и запусти этот скрипт.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$DbFile = Join-Path $ProjectDir "db\custom.db"

if (Test-Path $DbFile) {
    Write-Host "[db-init] Database already exists at $DbFile — skipping prisma db push."
    Write-Host "[db-init] If you changed the schema, delete the DB file and re-run:"
    Write-Host "          Remove-Item $DbFile; bun run db:push"
    exit 0
}

Write-Host "[db-init] Database not found — running prisma db push..."
Set-Location $ProjectDir
bunx prisma db push
if ($LASTEXITCODE -ne 0) {
    Write-Error "[db-init] prisma db push failed"
    exit 1
}
Write-Host "[db-init] Done."
