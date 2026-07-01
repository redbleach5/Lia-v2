# Security — Лия v2

## Threat model

Лия v2 — **local-first single-user** приложение. Пользователь запускает Next.js + Ollama на своей машине, доступ через localhost. Модель угроз отличается от cloud-приложений: нет multi-tenant изоляции, нет аутентификации пользователей, но есть риски от LLM-генерируемого кода и внешних запросов.

## Атаки и mitigations

### 1. Path traversal (agent FS tools)

**Угроза:** LLM через `read_file`/`write_file` пытается читать `/etc/passwd`, `~/.ssh/id_rsa`, `.env`.

**Mitigation:** `lib/agent/fs-scope.ts` — `safePathWithinScope(path, scope)`:
- `realpath()` для разрешения симлинков (защита от symlink-атак)
- `relative(base, target)` — если начинается с `..` или абсолютный → отказ
- Для несуществующих файлов (write_file) — проверяется parent directory
- Применяется во всех FS tools + `workspace/route.ts`

**Статус:** ✅ Реализовано (Phase 1.1.1)

### 2. SSRF (http_request + fetch_page)

**Угроза:** LLM делает запрос к `http://127.0.0.1:11434/api/tags` (Ollama), `http://169.254.169.254/` (AWS metadata), или internal сервисам.

**Mitigation:** `lib/infra/ssrf.ts` — `assertSafeUrl(url)`:
- Разрешает только `http:` и `https:` протоколы (нет `file:`, `ftp:`, `gopher:`)
- DNS resolve → проверка ALL resolved IPs
- Блокирует: loopback (127.x), private (10.x, 192.168.x, 172.16-31.x), link-local (169.254.x), CGNAT (100.64.x), 0.0.0.0/8
- IPv6: loopback (::1), ULA (fc00::), link-local (fe80::)
- IPv4-mapped IPv6 (::ffff:1.2.3.4) — рекурсивная проверка
- `localhost` hostname — блокируется
- Redirects: manual following с перепроверкой каждого target (max 5)

**Статус:** ✅ Реализовано (Phase 1.1.2). TOCTOU race (DNS rebind) — accepted risk для local-first.

### 3. Code execution (code_run tool)

**Угроза:** LLM через `code_run` выполняет `os.system('rm -rf /')`, `subprocess.Popen(...)`, читает `.env`, делает network requests.

**Mitigation:** `lib/tools/code-run.ts`:
- **Python AST analysis** (через `python3 -c ast.parse`):
  - Запрещены `Import`/`ImportFrom` для: subprocess, socket, http.*, ctypes, pickle, importlib, и др.
  - Запрещены `Call` к: eval, exec, compile, `__import__`, getattr, setattr, vars
  - Запрещены `Attribute` доступ к: `__builtins__`, `__subclasses__`, `__globals__`, `__code__`, system, popen, fork, rmtree, move
- **Resource limits** (через `resource.setrlimit` в Python prefix):
  - RLIMIT_AS: 256 MB (address space)
  - RLIMIT_FSIZE: 1 MB (max file write)
  - RLIMIT_CPU: 10 seconds
  - RLIMIT_NPROC: 0 (no child processes)
- **Environment isolation**: очищенный env (нет `DATABASE_URL`, `LIA_*`, `NODE_OPTIONS`)
- **Timeout**: 30s через `execFile` timeout
- **JavaScript**: substring blocklist (child_process, fs, eval, Function, process.exit, `__proto__`)

**Ограничения:** Не Docker sandbox. Raw socket (`socket.create_connection`) блокируется через AST (запрещён `import socket`). Filesystem read outside tempDir технически возможен — accepted risk для local-first.

**Статус:** ✅ Реализовано (Phase 1.1.3)

### 4. Python sidecar unauthorized access

**Угроза:** Любой локальный процесс (или website через CORS) вызывает `/train`, `/stats` на sidecar (port 8765).

**Mitigation:**
- `LIA_SIDECAR_API_KEY` env — обязательный (fail-closed: без ключа sidecar не запускается)
- `X-Sidecar-Key` header проверяется в middleware на всех endpoint'ах кроме `/health`
- CORS ограничен `localhost:3000` и `127.0.0.1:3000`
- Sidecar bind to `127.0.0.1` only (не доступен с других машин)
- `start-engine/route.ts` проверяет наличие ключа перед spawn, передаёт в env child process

**Статус:** ✅ Реализовано (Phase 1.1.4 + Phase 5.1)

### 5. Pickle deserialization (PyTorch model loading)

**Угроза:** Tampered `.pt` файл выполняет arbitrary code через `torch.load(weights_only=False)`.

**Mitigation:** `model.py` — `torch.load(path, weights_only=True)`. `.pt` файл содержит только dict примитивов (state_dim, num_actions, hidden_dim, state_dict) — `weights_only=True` работает.

**Статус:** ✅ Реализовано (Phase 1.1.5)

### 6. Proxy auth bypass

**Угроза:** Reverse proxy stripping `X-Forwarded-For` → `getClientIp` returns `'unknown'` → treated as localhost → auth bypass.

**Mitigation:** `proxy.ts`:
- `ip === 'unknown'` НЕ трактуется как localhost (Phase 1.1.6)
- В production: если `LIA_INTERNAL_TOKEN` не задан → 503 (fail-closed)
- Если задан: все non-localhost запросы требуют `X-Lia-Internal` header
- Rate-limiting активен в dev (×3 пороги) и prod

**Статус:** ✅ Реализовано (Phase 1.1.6)

### 7. ReDoS (edit_file regex mode)

**Угроза:** LLM передаёт catastrophic backtracking regex (`(a+)+`) в `edit_file` → event loop hang.

**Mitigation:** Текущая реализация использует `new RegExp(pattern, 'g')` без timeout. Для local-first — accepted risk (LLM редко генерирует malicious regex). Если понадобится — заменить на `re2` library.

**Статус:** ⚠️ Accepted risk

### 8. VRM upload

**Угроза:** Пользователь загружает malicious файл с расширением `.vrm` (например, Python script).

**Mitigation:**
- Проверка расширения `.vrm`
- Проверка размера (max 50MB)
- `sanitizeFilename` — removes path separators, leading dots
- VRM загружается через GLTFLoader (Three.js) — если файл не glTF, загрузка падает безопасно

**Ограничения:** Нет magic bytes проверки (VRM = glTF binary, начинается с `glTF` magic). Можно добавить.

**Статус:** ⚠️ Partial (extension check only)

### 9. Data persistence

**Угроза:** Чувствительные данные (факты о пользователе, эмоции, разговоры) хранятся в SQLite без шифрования.

**Mitigation:** Для local-first — SQLite файл на диске пользователя. Шифрование не реализовано (если нужен — SQLCipher). Файлы артефактов в `download/lia-artifacts/` — без auth (local-first).

**Статус:** ⚠️ Accepted risk (local-first)

## Конфигурация безопасности

### .env переменные

| Переменная | Обязательная | Описание |
|---|---|---|
| `LIA_SIDECAR_API_KEY` | Да (для RL) | API key для Python sidecar. Сгенерируй `openssl rand -hex 32`. |
| `LIA_INTERNAL_TOKEN` | Нет | Token для non-localhost access в production. Если не задан — 503 для внешних запросов. |
| `DATABASE_URL` | Да | SQLite path. Относительный (`file:./db/custom.db`). |
| `OLLAMA_BASE_URL` | Нет | URL Ollama. Default: `http://127.0.0.1:11434`. |
| `LIA_ROOT` | Нет | Override project root (для Tauri/desktop). |

### Production checklist

- [ ] `LIA_SIDECAR_API_KEY` задан (случайная строка 32+ chars)
- [ ] `LIA_INTERNAL_TOKEN` задан (если доступ не только localhost)
- [ ] `NODE_ENV=production`
- [ ] Ollama bind to `127.0.0.1` only
- [ ] Python sidecar bind to `127.0.0.1` only (default)
- [ ] Firewall блокирует port 8765 извне
- [ ] `.env` не в git (проверь `.gitignore`)

## Что НЕ реализовано (accepted risks для local-first)

1. **SQLCipher** — SQLite не зашифрован. Для local-first приемлемо (файл на диске пользователя).
2. **Docker sandbox для code_run** — AST analysis + resource limits достаточно для local-first. Для multi-user нужен Docker/firejail.
3. **CSRF tokens** — API использует `Content-Type: application/json` (не form), что усложняет CSRF. Для local-first приемлемо.
4. **Rate limiting per-user** — single-user, rate limit per-IP достаточно.
5. **Audit log** — все действия логируются через Pino, но нет отдельного audit trail.
