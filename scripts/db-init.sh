#!/bin/bash
# db-init.sh — идемпотентная инициализация БД.
#
# Проблема: prisma db push падает если БД уже содержит vec_virtual (virtual table),
# потому что Prisma не может описать virtual tables при сравнении схемы.
#
# Решение: делать db push только если БД не существует. Если существует —
# пропускаем (схема уже применена, vec_virtual создаётся в db-vec.ts при
# первом подключении).
#
# Для смены схемы: удали db/custom.db вручную и запусти этот скрипт.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_FILE="$PROJECT_DIR/db/custom.db"

if [ -f "$DB_FILE" ]; then
  echo "[db-init] Database already exists at $DB_FILE — skipping prisma db push."
  echo "[db-init] If you changed the schema, delete the DB file and re-run:"
  echo "          rm $DB_FILE && bun run db:push"
  exit 0
fi

echo "[db-init] Database not found — running prisma db push..."
cd "$PROJECT_DIR"
bunx prisma db push
echo "[db-init] Done."
