# Memory Intelligence + AI Development Orchestrator для OpenCode

Подробная инструкция по установке и эксплуатации: [`ИНСТРУКЦИЯ_ПО_РАБОТЕ_С_ПЛАГИНАМИ.md`](./docs/USER_GUIDE_RU.md).  
Сравнение с `opencode-mem@latest` и перечень внедрённых/отложенных функций: [`СРАВНЕНИЕ_OPENCODE_MEM_RU.md`](./docs/COMPARISON_OPENCODE_MEM_RU.md).

Сборка разделена на два самостоятельных OpenCode-плагина и общий пакет ядра. Memory Intelligence отвечает за единственное хранилище знаний и его API. AI Development Orchestrator отвечает за планирование работ и использует Memory Intelligence как потребитель.

## Архитектура

```text
OpenCode V2
│
├── .opencode/plugins/memory-intelligence/       # самостоятельный OpenCode plugin
│   └── index.ts                                  # memory_* tools, hooks, slash-команды
│
├── .opencode/plugins/ai-development-orchestrator/ # отдельный OpenCode plugin
│   ├── index.ts                                  # orchestrator_* tools, /orch-*
│   └── session-history.ts                       # импорт полной истории активной сессии
│
├── .opencode/packages/memory-intelligence-core/  # общий сервисный пакет
│   └── src/
│       ├── client.ts                             # публичный API и shared-client registry
│       ├── store.ts                              # единственный владелец SQLite/vector/graph
│       ├── intelligence.ts                       # extraction, conflicts, temporal state
│       ├── config.ts                             # единый загрузчик конфигурации
│       └── schema.sql
│
└── .orchestrator/orchestrator.sqlite             # существующая база; путь сохранён
```

### Границы ответственности

**Memory Intelligence** — единственный владелец базы `.orchestrator/orchestrator.sqlite`, SQLite schema/migrations, FTS5, sqlite-vec, embeddings, hybrid retrieval, Graph RAG, extraction, conflicts, confidence/provenance и исторической реконструкции. Он регистрирует `memory_*` инструменты и доступен всем агентам OpenCode.

**AI Development Orchestrator** — потребитель клиентского API ядра. Он отвечает за decomposition/planning, задачи, зависимости, жизненный цикл сессий, создание child sessions и `/orch-ingest-session`. В нём больше нет копии `store.ts`, `intelligence.ts`, SQLite-соединения, индекса embeddings или второго retrieval-пайплайна.

**Memory Intelligence Core** — общий сервисный API и реализация. Обе плагины импортируют один workspace-пакет. Публичный контракт — `acquireMemoryIntelligence(projectRoot)` и `MemoryIntelligenceClient`; низкоуровневые `MemoryStore`/`MemoryIntelligence` скрыты внутри клиента. Внутрипроцессный registry с ref-count выдаёт плагинам один объект клиента на canonical project path: один плагин не закроет SQLite, пока другой продолжает его использовать.

## Совместимость с OpenCode

Обе плагины используют текущий V2 plugin contract: `import { Plugin } from "@opencode/plugin"`, `Plugin.define({ id, async setup(ctx) { ... } })`, `ctx.tool.transform`, `ctx.command.transform`, `ctx.session.hook` и `ctx.event.subscribe`.

Локальные плагины размещены в `.opencode/plugins/`, каждая папка — самостоятельный пакет с `package.json`, `name` и `exports`. Общий core находится вне папки автозагрузки плагинов — в `.opencode/packages/`, поэтому OpenCode не пытается загрузить его как третий plugin. Зависимости связываются через Bun workspaces.

Это именно портирование под API V2, а не переименование каталога или сохранение старого V1 `plugin`/`server`-обработчика. Актуальные контракты: [Building plugins](https://opencode.ai/docs/build/plugins/), [Server plugins](https://opencode.ai/docs/build/plugins/server/), [V1 migration guide](https://opencode.ai/docs/build/plugins/migrate-v1/).

## Требования

- OpenCode с поддержкой V2 plugins.
- Bun — для workspace-зависимостей и запуска TypeScript smoke tests.
- Windows, macOS или Linux.
- API-ключ выбранного embedding/LLM provider, если включена удалённая обработка OpenRouter.

## Установка в Windows PowerShell

Распакуйте архив в корень существующего проекта (рядом с `.opencode` и папкой `.orchestrator`) и выполните из корня проекта:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\AI-Development-Orchestrator\Install-Orchestrator.ps1
```

Установщик:

1. создаёт/обновляет `.opencode/memory.config.json`, сохраняя существующие пользовательские значения;
2. переносит значения из прежнего `.opencode/orchestrator.config.json` в новый конфиг, если новый ещё не существует;
3. оставляет существующий `.opencode/orchestrator.config.json` и его пользовательские значения, дополняя только отсутствующие defaults для auto-save;
4. устанавливает core, затем Memory Intelligence и Orchestrator;
5. добавляет workspace-пути в `.opencode/package.json`, сохраняя существующие настройки;
6. создаёт резервные копии заменяемых plugin/package каталогов;
7. запускает `bun install` из `.opencode`.

После установки перезапустите OpenCode. Оба плагина находятся в `.opencode/plugins/` и загружаются автоматически. Все агенты получают `memory_*`, агент-оркестратор дополнительно получает `orchestrator_*`.

Если Bun не был установлен, после его установки выполните:

```powershell
cd .opencode
bun install
```

## Конфигурация

Конфигурация разделена по назначению:

```text
.opencode/memory.config.json       # embedding/intelligence provider, model, API key
.opencode/orchestrator.config.json # session auto-save token threshold
```

Провайдеры embeddings и Memory Intelligence настраиваются независимо. Ключ можно задавать в `providers.openrouter.apiKey` либо отдельно в `embedding.apiKey` / `intelligence.apiKey`:

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-v1-ВАШ_КЛЮЧ"
    }
  },
  "embedding": {
    "provider": "openrouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "qwen/qwen3-embedding-8b",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "promptProfile": "plain",
    "timeoutMs": 120000,
    "batchSize": 24
  },
  "intelligence": {
    "enabled": true,
    "provider": "openrouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "google/gemini-3.6-flash",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "timeoutMs": 90000,
    "maxTranscriptChars": 45000,
    "minTranscriptChars": 300,
    "autoExtractOnCompaction": true,
    "allowRemoteProcessing": true
  }
}
```

Пороговое сохранение настраивается в `.opencode/orchestrator.config.json` через `memory.autoSave.tokenThreshold`. Новые настройки auto-save добавляйте туда; настройки моделей и ключи — в `memory.config.json`. Ключи не добавляйте в Git: исключите `/.opencode/memory.config.json` и `/.orchestrator/` из репозитория или используйте env vars.

## Команды и инструменты

### Memory Intelligence — доступно всем агентам

Инструменты namespace `memory` (effective tool IDs). `projectId` необязателен для основных операций: по умолчанию используется текущий проект, из которого загружен плагин. Это позволяет обычным агентам использовать память без предварительного поиска ID проекта:

- `memory_write`
- `memory_search`
- `memory_semantic_search`
- `memory_vector_reindex`
- `memory_embedding_status`
- `memory_intelligence_extract`
- `memory_intelligence_status`
- `memory_intelligence_consolidate`
- `memory_intelligence_report`
- `memory_conflicts`
- `memory_conflict_resolve`
- `memory_state_at`
- `memory_graph_query`
- `memory_checkpoint`
- `memory_consolidate`
- `memory_database_backup`
- `memory_export`
- `memory_file_lock`
- `memory_project_report`
- `memory_autosave_status`
- `memory_list`
- `memory_forget`
- `memory_restore`

Slash-команды:

- `/memory-search <query>` — hybrid semantic search;
- `/memory-status` — статус Memory Intelligence и embeddings;
- `/memory-checkpoint` — checkpoint активной сессии;
- `/memory-consolidate` — non-destructive консолидация;
- `/memory-intelligence` — отчёт о знаниях;
- `/memory-conflicts` — открытые противоречия;
- `/memory-state <ISO timestamp>` — срез проекта во времени;
- `/memory-reindex` — переиндексация embeddings;
- `/memory-autosave-status` — состояние токен-пороговых автоматических сохранений;
- `/memory-list [query]` — просмотр активных воспоминаний;
- `/memory-forget <memory-id>` — мягко исключить запись из поиска и recall;
- `/memory-restore <memory-id>` — восстановить ранее исключённую запись.

Плагин автоматически извлекает последний запрос пользователя и подбирает релевантный контекст на `context` hook. Повторные tool-loop запросы кэшируются; при сбое retrieval включается recent-memory fallback. Общий privacy sanitizer применяется перед сохранением записей/checkpoints/events, удалённым extraction и context injection. Дедупликация `memory_write` включает нормализованное точное совпадение и консервативное семантическое сравнение вектором для одинакового `kind`. Автоматическое извлечение через OpenRouter можно отключить через `intelligence.autoExtractOnCompaction` или `intelligence.allowRemoteProcessing`.

Настройки этих функций находятся в `memory.config.json` в секциях `recall`, `privacy` и `deduplication`; подробные параметры приведены в инструкции.

### AI Development Orchestrator — управление проектом

Инструменты `orchestrator_*` включают:

- `orchestrator_project_register`
- `orchestrator_task_create`
- `orchestrator_task_update`
- `orchestrator_session_update`
- `orchestrator_session_spawn`

Slash-команды:

- `/orch-status`
- `/orch-memory <query>` — consumer wrapper поверх Memory Intelligence search;
- `/orch-checkpoint` — consumer wrapper поверх shared checkpoint API;
- `/orch-ingest-session` — прочитать полную историю уже открытой сессии, сохранить оригинал, выделить знания и создать дерево задач;
- `/orch-report`
- `/orch-consolidate`
- `/orch-intelligence`
- `/orch-state <ISO timestamp>`.

## Автоматическое сохранение сессии по порогу токенов

Memory Intelligence проверяет порог после завершения каждого выполнения по событиям V2 `session.execution.succeeded`, `session.execution.failed` и `session.execution.interrupted` (плюс совместимый `session.idle`). V2 session ID читается из `event.data`. По умолчанию при накоплении ещё 50 000 токенов с предыдущего успешного сохранения плагин сохраняет полную исходную транскрипцию в SQLite, выделяет новый фрагмент и извлекает новые объекты знаний. Дубликаты сущностей, фактов и решений повторно не создаются: к существующим объектам добавляется provenance нового источника.

Настройка хранится в `.opencode/orchestrator.config.json`:

```json
{
  "memory": {
    "autoSave": {
      "enabled": true,
      "tokenThreshold": 50000,
      "checkOnSessionIdle": true,
      "saveRawTranscript": true,
      "extractNewObjects": true,
      "estimateFallback": true,
      "maxTranscriptCharsPerChunk": 38000
    }
  }
}
```

Порог относится к накопленным токенам input/output/reasoning/cache-read/cache-write по статистике OpenCode: сначала используется агрегированная статистика сессии, затем сумма usage assistant-сообщений, и только при её отсутствии — оценка текста (если `estimateFallback=true`). Проверка выполняется по завершении взаимодействия, а не в середине генерации. При извлечении выполняется дедупликация сущностей по каноническим именам и aliases, фактов с учётом интервалов действия, решений и идентичных memory-записей. Повторные источники фиксируются в evidence-таблицах, а новые конфликтующие факты сохраняются как отдельные утверждения. Статус: `/memory-autosave-status` или `memory_autosave_status`.

## Импорт уже существующей сессии

В давно открытой OpenCode-сессии выполните:

```text
/orch-ingest-session
```

Оркестратор читает историю из OpenCode SQLite в read-only режиме (V2 `session_message` / `session_part` и legacy `message` / `part`), затем CLI export как запасной вариант. Доступные checkpoints и активный контекст дополняют базовую историю.

Далее он сохраняет исходные сообщения в таблице `checkpoints` до обращения к модели, передаёт фрагменты в Memory Intelligence, строит сводку знаний, вызывает task planner и создаёт основную задачу, подзадачи и зависимости. Команда не создаёт новую OpenCode-сессию. Если получить всю историю не удалось, отчёт помечает покрытие как partial.

Повторный запуск для того же хэша транскрипта идемпотентен. При новых сообщениях система может повторно сопоставить существующие задачи по stable key/title и обновить их без массового дублирования.

## Общая база данных и миграция

Путь остаётся прежним:

```text
.orchestrator/orchestrator.sqlite
```

Данные не переносятся и не копируются в новое хранилище. После установки Memory Intelligence открывает ту же базу и продолжает существующие таблицы, векторные индексы и записи. Старый plugin-каталог заменяется резервной копией, но папка базы `.orchestrator/` не меняется.

## Smoke tests

После `bun install` из `.opencode`:

```powershell
cd packages/memory-intelligence-core
bun run test:shared-client
bun run test:vector
bun run test:intelligence
bun run test:auto-save

cd ..\..\plugins\ai-development-orchestrator
bun run test:ingest
```

`test:auto-save` дополнительно проверяет дедупликацию entities/aliases, facts, decisions и provenance. `test:shared-client` проверяет, что два потребителя получают один объект клиента и освобождение одного lease не закрывает базу для второго. `test:ingest` проверяет чтение V2 сессии из тестовой базы, checkpoint, создание дерева задач, зависимости, связь с существующей сессией и идемпотентность.

Статический синтаксис TypeScript и SQLite schema можно проверить без OpenCode. Полный plugin runtime и запросы OpenRouter нужно запускать в установленном OpenCode с Bun и действительным API key.

## Подготовка к npm-публикации

Собраны три workspace-пакета:

| Каталог | npm package | Назначение |
|---|---|---|
| `.opencode/packages/memory-intelligence-core` | `opencode-memory-intelligence-core` | SQLite, retrieval, Knowledge Graph, public client API |
| `.opencode/plugins/memory-intelligence` | `opencode-memory-intelligence` | OpenCode V2 plugin adapter и memory tools/hooks |
| `.opencode/plugins/ai-development-orchestrator` | `opencode-ai-development-orchestrator` | независимый orchestration plugin, потребитель core API |

Пока пакеты собраны локально и не опубликованы в npm. Перед публикацией нужно проверить имена пакетов, версию OpenCode V2, `bun pack`/`npm pack`, peer/runtime dependencies и установить именно упакованные архивы в чистый тестовый OpenCode-проект. В будущем пользовательский `opencode.json` будет содержать обе плагины:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-memory-intelligence",
    "opencode-ai-development-orchestrator"
  ]
}
```

Core подтягивается как зависимость обеих npm-плагин-пакетов. Его не нужно регистрировать как OpenCode plugin. Порядок публикации: сначала `opencode-memory-intelligence-core`, затем `opencode-memory-intelligence` и `opencode-ai-development-orchestrator`. Имена пакетов предварительные — доступность имён в npm нужно проверить непосредственно перед публикацией.

Для отдельного проекта, которому нужна только общая память, в `opencode.json` достаточно зарегистрировать один plugin:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-memory-intelligence"]
}
```

Чтобы добавить управление задачами/дочерними сессиями и `/orch-ingest-session`, подключите второй пакет `opencode-ai-development-orchestrator`. Оба пакета используют тот же core API и одну проектную базу. Таким образом, Memory Intelligence можно переиспользовать независимо от Orchestrator.

