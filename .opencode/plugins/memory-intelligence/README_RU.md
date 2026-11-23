# Memory Intelligence — OpenCode V2 plugin

Самостоятельный OpenCode V2 plugin для совместной проектной памяти всех агентов. Этот плагин является единственным владельцем SQLite/FTS5/sqlite-vec/Knowledge Graph, embeddings и Memory Intelligence.

## Роль в системе

- `memory_*` инструменты для записи и поиска памяти;
- hybrid retrieval: vector KNN + FTS5 + graph expansion;
- извлечение сущностей, временных фактов, решений, рисков и открытых вопросов;
- обнаружение и ручное разрешение противоречий;
- temporal project-state reconstruction;
- автоматический checkpoint перед session compaction;
- автоматическое token-threshold сохранение после терминальных событий V2 `session.execution.*` (с fallback на `session.idle`), по умолчанию каждые 50 000 накопленных токенов;
- дедупликация извлечённых сущностей, claims и решений с добавлением evidence новых источников;
- автоматический relevance-based recall: семантический поиск по последнему пользовательскому запросу и injection релевантных воспоминаний перед каждым model request; cache повторов в tool-loop; fallback на recent память;
- защита конфиденциальных данных: redaction распознаваемых API-ключей, токенов и содержимого `<private>...</private>` перед записью в memory/checkpoint, перед remote extraction и перед injection;
- нормализованная и семантическая дедупликация записей одного типа; повторные источники добавляются как evidence, исходная запись не удаляется и не переписывается;
- инструменты списка, мягкого удаления и восстановления memory-записей;
- backup, export, cooperative file locks.

## Реализация

Plugin entrypoint — `index.ts`, использует `Plugin.define()` из `@opencode/plugin`. Хранилище и сервис API вынесены в зависимый workspace/npm пакет `opencode-memory-intelligence-core`. Оркестратор импортирует тот же core напрямую; второй SQLite store не создаётся. `acquireMemoryIntelligence()` использует project-scoped singleton registry и ref-count cleanup.

Путь БД совместим с предыдущими версиями: `.orchestrator/orchestrator.sqlite`. Конфигурация: провайдеры/модели/API keys, recall, privacy и deduplication — `.opencode/memory.config.json`; порог авто-сохранения — `.opencode/orchestrator.config.json` (`memory.autoSave.tokenThreshold`). Полное руководство находится в корне проекта: `ИНСТРУКЦИЯ_ПО_РАБОТЕ_С_ПЛАГИНАМИ.md`.

## Tools

Используйте `memory_write`, `memory_list`, `memory_forget`, `memory_restore`, `memory_search`, `memory_semantic_search`, `memory_vector_reindex`, `memory_embedding_status`, `memory_intelligence_extract`, `memory_intelligence_report`, `memory_conflicts`, `memory_conflict_resolve`, `memory_state_at`, `memory_graph_query`, `memory_checkpoint`, `memory_database_backup` и другие инструменты namespace `memory`.

`projectId` для основных инструментов не требуется: по умолчанию plugin привязывает вызов к текущему проекту. При необходимости можно явно передать другой ID проекта.

Подробности установки, конфигурации и тестов смотрите в корневом `README_RU.md`.

## Автоматическое сохранение сессий

Плагин слушает V2 события завершения выполнения `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted` и совместимый `session.idle`; session ID извлекается из `event.data.sessionID`. Если накопленная OpenCode session usage с предыдущей контрольной точки достигла `memory.autoSave.tokenThreshold`, он сохраняет полную транскрипцию в SQLite и анализирует только новые сообщения. Если агрегированная usage недоступна, используется сумма provider usage assistant-сообщений; если нет и её — оценка по тексту (`estimateFallback`). Исходный checkpoint сохраняется до обращения к LLM. Дубликаты сущностей/фактов/решений пропускаются как новые записи, но источники фиксируются в evidence-таблицах и Knowledge Graph.

Для диагностики используйте `/memory-autosave-status` или инструмент `memory_autosave_status`.


## Автоматический релевантный recall

Перед каждым model request context hook извлекает последний authored user prompt из V2 `event.messages` и ищет связанные воспоминания. По умолчанию режим `relevant`, до 6 записей, до 10 000 символов; повторные tool-loop запросы с тем же prompt кэшируются 15 секунд. Если embeddings недоступны, semanticSearch использует FTS5/Knowledge Graph, а при ошибке поиска включается recent-memory fallback. Context injection не блокирует основной запрос модели.

Настройки в `.opencode/memory.config.json`:

```json
"recall": {
  "enabled": true,
  "mode": "relevant",
  "maxMemories": 6,
  "maxContextChars": 10000,
  "cacheMs": 15000,
  "includeRecentFallback": true
}
```

Режимы: `relevant` — семантически связанные записи; `recent` — последние записи; `both` — сначала релевантные, затем недостающие последние записи.

## Приватность и редактирование секретов

Новые записи memory, checkpoint-транскрипты, event payloads и данные, передаваемые в extraction-модель, проходят общий sanitizer. Он редактирует узнаваемые OpenAI/OpenRouter/Anthropic/GitHub/Slack/Google ключи, AWS access key ID, Bearer tokens, JWT-подобные секреты, PEM private keys и содержимое `<private>...</private>`. Незакрытый `<private>` redacts всё до конца строки/документа. Это best-effort фильтр, а не DLP и не гарантия обнаружения всех секретов. Не помещайте пароли, ключи и персональные секреты в историю.

```json
"privacy": {
  "redactCredentials": true,
  "redactPrivateTags": true
}
```

## Семантическая дедупликация и управление записями

`memory_write` использует `writeMemoryDeduplicated`: сначала проверяет нормализованное точное совпадение, затем (если vector search доступен) семантическое сходство только с записями того же `kind`. Порог по умолчанию 0.92. FTS/Graph совпадение без реального vector similarity не подавляет новую запись. При дубликате добавляется evidence и связь с новой сессией/задачей; исходная запись сохраняется неизменной.

```json
"deduplication": {
  "enabled": true,
  "similarityThreshold": 0.92
}
```

`memory_forget` / `/memory-forget <memory-id>` — мягко исключает запись из recall и удаляет её FTS/vector index rows, сохраняя исходный текст и версии в SQLite для восстановления. Это не криптографическое стирание. `memory_restore` / `/memory-restore <memory-id>` возвращает запись в active и восстанавливает FTS; вектор можно восстановить командой `/memory-reindex`.

Новые slash-команды: `/memory-list [query]`, `/memory-forget <memory-id>`, `/memory-restore <memory-id>`.
