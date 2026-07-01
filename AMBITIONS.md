# Ambitions — планы развития Лии

Документ с фичами, которые хотят добавить, но они требуют значительной работы.
Каждая амбиция — отдельный подпроект. Если берётесь за реализацию, создавайте
отдельную ветку и PR.

---

## Document RAG — загрузка документов и semantic search

**Статус:** идея, не реализована
**Сложность:** ~6-7 часов работы
**Спонсор:** пользователь (хочет загружать 80 файлов документации и задавать
вопросы по конкретным пунктам)

### Проблема

Сейчас Lia может искать информацию только через `web_search` (DuckDuckGo) или
читать файлы по одному через `read_file` в agent mode. Нет возможности
загрузить пул документов (PDF, DOCX, MD, TXT) и искать по ним семантически.

Сценарий пользователя: «загружаю 80 файлов документации проекта, спрашиваю
'в каком файле описана аутентификация?' — Lia должна найти релевантные
кусочки и ответить с цитатой».

### Что нужно построить

| Этап | Файлы | Сложность |
|---|---|---|
| 1. Prisma-таблицы `Document` + `DocumentChunk` | `prisma/schema.prisma` | легко |
| 2. `/api/docs/upload` — multipart загрузка файлов | `src/app/api/docs/upload/route.ts` | средне |
| 3. Парсеры: PDF (pdf-parse), DOCX (mammoth), MD/TXT (native) | `src/lib/docs/parsers.ts` | средне |
| 4. Чанкинг: markdown-aware, ~1000 токенов с overlap 200 | `src/lib/docs/chunker.ts` | средне |
| 5. Embedding через существующий `embed()` (nomic-embed-text) | `src/lib/docs/ingest.ts` | легко |
| 6. Сохранение в vec_virtual с `source_type='document'` | `src/lib/db-vec.ts` | легко |
| 7. `/api/docs/search` — semantic search по документам | `src/app/api/docs/search/route.ts` | легко |
| 8. `search_docs` tool в chat mode | `src/lib/tools/index.ts` | легко |
| 9. UI: Настройки → Документы → drag&drop загрузка | `src/components/lia/settings/docs-tab.tsx` | средне |
| 10. Citation: Lia указывает файл + страницу/строку | `src/lib/docs/citation.ts` | средне |
| 11. Интеграция в system prompt: «если вопрос про документы — search_docs» | `src/lib/system-prompt.ts` | легко |

### Архитектура

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│  UI: drag&drop  │ →  │ /api/docs/   │ →  │ Parser (PDF/    │
│  80 файлов      │    │ upload       │    │ DOCX/MD/TXT)    │
└─────────────────┘    └──────────────┘    └─────────────────┘
                                                   ↓
                                           ┌─────────────────┐
                                           │ Chunker         │
                                           │ ~1000 tok/overlap│
                                           └─────────────────┘
                                                   ↓
                                           ┌─────────────────┐
                                           │ embed() (Ollama)│
                                           │ 768-dim float   │
                                           └─────────────────┘
                                                   ↓
                                           ┌─────────────────┐
                                           │ DocumentChunk   │
                                           │ table +         │
                                           │ vec_virtual idx │
                                           └─────────────────┘
                                                   ↑
                                           ┌─────────────────┐
                                           │ search_docs     │
                                           │ tool в chat     │
                                           └─────────────────┘
                                                   ↑
                                           ┌─────────────────┐
                                           │ Lia получает    │
                                           │ топ-5 чанков +  │
                                           │ citation        │
                                           └─────────────────┘
```

### Design decisions (открытые вопросы)

1. **Глобальные документы или per-episode?**
   - Глобальные: один пул на все чаты. Пользователь загружает 1 раз.
   - Per-episode: каждый чат имеет свой набор документов.
   - Рекомендация: **глобальные** — больше похоже на «библиотеку», проще UX.

2. **Формат citation?**
   - `[file.pdf, p.12]` — короткая ссылка
   - `[file.pdf, p.12, ¶3]` — с параграфом
   - Полный snippet с подсветкой — лучше для UX, но длиннее
   - Рекомендация: **короткая ссылка** + clickable → открывает файл на странице

3. **Re-indexing при обновлении файла?**
   - Auto-detect mtime → re-ingest
   - Manual кнопка «обновить»
   - Рекомендация: **manual** — auto может surprises при больших файлах

4. **Лимит на размер пула?**
   - 100 MB? 1 GB? Без лимита?
   - Рекомендация: **500 MB default**, configurable в .env

5. **Quota на embedding запросы?**
   - Ollama локально — без лимитов
   - Groq embeddings — нет (используем только Ollama)
   - Рекомендация: **без квоты**, но с debounce на upload (не более 1 файла/сек)

### Migration plan

1. Создать `feat/document-rag` ветку
2. Добавить Prisma-таблицы, запустить `prisma db push`
3. Реализовать parsers + chunker (тесты на 5 форматах)
4. `/api/docs/upload` endpoint
5. `search_docs` tool
6. UI tab
7. System prompt интеграция
8. Тесты end-to-end: загрузить 5 PDF, задать вопрос, проверить citation

### Out of scope (для будущих амбиций)

- OCR для сканов PDF (нужен tesseract)
- Audio transcription (нужен whisper)
- Web crawler для автоматической загрузки doc sites
- Multi-modal (изображения в документах)
- Versioning документов (старая → новая версия с diff)

---

## Другие амбиции (коротко)

- **Voice I/O** — микрофон → STT (Whisper), TTS для ответов Лии
- **Multi-user** — сейчас local-first single-user, добавить auth + sessions
- **Plugin system** — пользователь может добавлять свои tools через UI
- **Mobile app** — Tauri/React Native обёртка над тем же backend
- **Cross-episode memory** — GlobalFacts уже есть, но нужно auto-extraction
- **Emotional memory consolidation** — ReflectionEngine для слияния похожих эмоциональных воспоминаний
- **Agent templates marketplace** — пользователи делятся своими агентами
