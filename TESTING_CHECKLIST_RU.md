# Проверка независимых плагинов Memory Intelligence и AI Development Orchestrator

## 1. Установка и загрузка OpenCode V2

- Распаковать архив в корень проекта и выполнить `Install-Orchestrator.ps1` из PowerShell.
- Убедиться, что `bun install` завершился без ошибок в `.opencode`.
- Перезапустить OpenCode.
- Проверить список загруженных plugin IDs: `memory-intelligence` и `ai-development-orchestrator`.
- Проверить, что оба плагина загружаются как V2 `Plugin.define({ id, setup })`, а не через V1 `plugin()`/`server()` contract.

## 2. Единственное хранилище

- Проверить, что путь базы данных остаётся `.orchestrator/orchestrator.sqlite`.
- Вызвать `memory_embedding_status` и `memory_intelligence_status`.
- Создать запись через `memory_write`, найти её через `memory_search`, затем через `memory_semantic_search`.
- Повторно записать ту же запись с нормализованным пробелом/регистром: должен вернуться прежний ID и появиться повторное evidence, но вторая `memory_entries` запись не создаётся.
- Для длинной записи проверить семантическое совпадение только при доступном vector score и совпадающем `kind`; без vector API fallback должен сохранить новую запись.
- Проверить `/memory-list`, `/memory-forget <id>`, `/memory-restore <id>`; forgotten запись не должна появляться в обычном recall, после restore должна вернуться в FTS, embeddings после восстановления обновляются `/memory-reindex`.
- Убедиться, что таблицы `memory_entries`, `memory_chunks`, `vector_index`, `graph_nodes`, `graph_edges`, `knowledge_claims` доступны в одной базе.
- Проверить, что в `.opencode/plugins/ai-development-orchestrator/` больше нет `store.ts`, `intelligence.ts`, `schema.sql` и самостоятельного подключения к `.orchestrator/orchestrator.sqlite`.

## 3. Доступность другим агентам

- Открыть обычную сессию с агентом, отличным от `ai-development-orchestrator`.
- Убедиться, что ему доступны `memory_write`, `memory_search`, `memory_semantic_search`, `memory_graph_query` и остальные `memory_*` инструменты.
- Проверить, что memory context добавляется через V2 `ctx.session.hook("context", ...)`.
- Выполнить `/memory-search` и `/memory-status`.
- Проверить, что контекстный hook использует последний пользовательский prompt: релевантная запись должна попадать в context pack, нерелевантная — не попадать в режиме `recall.mode="relevant"`.
- Повторить тот же запрос в tool-loop в течение `cacheMs`; проверить отсутствие лишнего нового retrieval-события.

## 4. Совместное использование сервиса несколькими плагинами

Из `.opencode/packages/memory-intelligence-core` выполнить:

```powershell
bun run test:shared-client
```

Тест должен подтвердить, что два потребителя одного проекта получают один `MemoryIntelligenceClient`, а освобождение первого lease не закрывает соединение второго потребителя.

## 5. Retrieval и embeddings

Из `.opencode/packages/memory-intelligence-core` выполнить:

```powershell
bun run test:vector
```

- Проверить `memory_embedding_status`: провайдер, модель, наличие ключа (без раскрытия значения) и доступность `sqlite-vec`.
- Создать русскоязычную запись о refresh-token rotation.
- Найти её перефразированным вопросом, в котором нет исходных терминов; ожидается vector channel.
- Запустить `memory_vector_reindex`, пока pending chunks не останется.
- Отключить embedding API и проверить явный fallback без потери исходной записи.

## 6. Privacy, recall и дедупликация

Из `.opencode/packages/memory-intelligence-core` выполнить:

```powershell
bun run test:privacy
bun run test:auto-save
```

- Убедиться, что OpenRouter/API/GitHub/Slack/AWS/Bearer/JWT-like секреты и `<private>...</private>` redacted до DB/remote LLM/context injection.
- Проверить nested private tags, незакрытый private tag, shared-but-acyclic object и настоящий circular object.
- В `memory.config.json` проверить `privacy.redactCredentials`, `privacy.redactPrivateTags`, `recall.*`, `deduplication.*`.
- Подтвердить, что редактирование — best effort, а не гарантия DLP.

## 7. Memory Intelligence

Из `.opencode/packages/memory-intelligence-core` выполнить:

```powershell
bun run test:intelligence
```

Дополнительно вручную проверить:

- `memory_intelligence_extract` извлекает сущности, claims, решения, риски и вопросы из транскрипта.
- Повторный extract для одного source не создаёт повторных записей.
- `memory_conflicts` показывает конфликтующие утверждения с provenance.
- `memory_conflict_resolve` сохраняет явное решение, не удаляя исходные claims.
- `memory_intelligence_consolidate` создаёт review candidates без автоматического удаления источников.
- `memory_state_at` корректно учитывает `asOf` и `knownAt`.
- `/memory-checkpoint` сохраняет checkpoint; перед compaction checkpoint создаётся до обработки summary.

## 8. Оркестрация и импорт уже открытой сессии

Из `.opencode/plugins/ai-development-orchestrator` выполнить:

```powershell
bun run test:ingest
```

Затем проверить в OpenCode:

- В давно открытой сессии выполнить `/orch-ingest-session`; новая OpenCode-сессия не создаётся.
- Полная история читается из OpenCode SQLite read-only; если источник неполный, отчёт явно помечает coverage как partial.
- Исходный transcript checkpoint сохраняется в shared Memory Intelligence DB до запросов к модели.
- Создаются главная задача, подзадачи и `depends_on` связи; запись связывается с исходной сессией.
- Повторный запуск без новых сообщений идемпотентен; новые сообщения не дублируют существующие стабильные подзадачи.
- `orchestrator_*` инструменты доступны агенту-оркестратору; общие `memory_*` — через независимый Memory Intelligence plugin.

## 9. Конкурентная работа и надёжность

- Запустить две сессии/плагина на одном проекте и проверить, что они используют один DB path и общий сервисный singleton.
- Проверить cooperative file lock для одного и того же файла двумя разными session IDs.
- Перезагрузить плагины: cleanup должен отпускать lease; соединение закрывается только после освобождения последнего lease.
- Перезапустить OpenCode и проверить, что все записи сохранились.
- Создать backup и выполнить `PRAGMA integrity_check`.

## 10. Будущая проверка npm-пакетов

Перед публикацией:

1. Убедиться, что `opencode-memory-intelligence-core` опубликован первым.
2. Обновить на него зависимость в обоих plugin package manifests.
3. Опубликовать `opencode-memory-intelligence`, затем `opencode-ai-development-orchestrator`.
4. Выполнить `npm pack` для каждого пакета.
5. Установить архивы именно в чистый тестовый OpenCode-проект через `opencode.json` и `plugins`, а не проверять только workspace symlinks.
6. Проверить все tools, commands, hooks, event subscription и cleanup на целевой версии OpenCode V2.

## Ограничения текущей проверки

Статический синтаксис TypeScript, JSON и выполнение SQLite schema проверяются отдельно. Runtime Bun/OpenCode и запросы OpenRouter требуется запускать в пользовательском окружении. Успешное workspace-тестирование само по себе не заменяет тест установленного npm tarball.

## 11. Автоматическое сохранение по token threshold

Из `.opencode/packages/memory-intelligence-core` запустить:

```powershell
bun run test:auto-save
```

На тестовом проекте OpenCode:

- Установить `.opencode/orchestrator.config.json` → `memory.autoSave.tokenThreshold=1000`.
- Проверить V2 event envelope (`event.data.sessionID`) и terminal events `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted`; `session.idle` остаётся compatibility fallback.
- Создать несколько реплик с token usage, превышающим порог; проверить, что в `.orchestrator/orchestrator.sqlite` создаются `checkpoints`, `session_auto_save_runs` и `session_auto_save_state`.
- Проверить, что `session_auto_save_state.last_saved_tokens` и `last_message_id` обновляются только после завершения обработки.
- Проверить повторный event / повторный запуск с одинаковым transcript hash: вторая completed run не создаётся и checkpoint не дублируется.
- Проверить, что в следующем цикле анализируется только delta после предыдущего `last_message_id`.
- Проверить, что exact duplicate memory возвращает прежний `memoryId`; повторные claims/decisions связываются через `knowledge_claim_evidence`, `knowledge_decision_evidence` и графовые отношения `reaffirms_claim` / `reaffirms_decision`.
- Убедиться, что новый факт с отличающимся значением не подавляется как дубликат, а может создать конфликт.
- Выключить remote processing: raw checkpoint должен сохраниться, извлечение должно быть пропущено без потери транскрипции.
- Проверить статус `/memory-autosave-status`, затем вернуть threshold к 50000.

Триггер V2 проверяется в установленном OpenCode runtime; unit smoke test проверяет подсчёт usage, fallback, cursor, chunking, checkpoint state, run idempotency и точную дедупликацию memory entry.
