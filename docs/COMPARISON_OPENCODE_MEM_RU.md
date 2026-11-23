# Сравнение Memory Intelligence и opencode-mem

Дата анализа: 20 ноября 2026 г. Сравниваемая версия npm: `opencode-mem@2.43.0` (`latest` на дату проверки).

Репозиторий: https://github.com/tickernelz/opencode-mem  
Пакет: https://www.npmjs.com/package/opencode-mem

## Краткий вывод

`opencode-mem` — полезный ориентир для практического поведения памяти в агенте: автоматическое сохранение результата инструментов, relevance recall на каждом запросе, межпроектный пользовательский профиль, защита секретов, семантическая дедупликация, переносимость данных и веб-панель.

Наш Memory Intelligence решает более широкую задачу проектной памяти и координации разработки: отдельный reusable plugin + core package, локальная SQLite, vector/FTS hybrid RAG, Knowledge Graph, source evidence, временные claims/decisions, конфликты, `asOf`/`knownAt`, полная история сессии, token-threshold auto-save и проектный task/session orchestrator.

Поэтому цель — не копировать `opencode-mem`, а перенести сильные паттерны, сохранив собственную модель данных и совместимость с ранее созданной SQLite-базой.

## Функциональное сравнение

| Возможность | Memory Intelligence до этой доработки | `opencode-mem@2.43.0` | Изменение в этой сборке |
|---|---|---|---|
| Автосохранение | Полная транскрипция и контрольные точки по token threshold, checkpoint перед compaction | Idle/prompt-driven capture и анализ результата сессии | Сохранён token threshold; добавлен relevance recall при каждом V2 context hook |
| Recall в контексте | Ограниченный пакет недавних записей | Поиск относящихся к текущему запросу воспоминаний | Добавлен запрос-зависимый semantic/hybrid recall, лимит, короткий cache и recent fallback |
| Защита секретов | Redaction преимущественно в transcript extraction | Фильтрация на границах памяти и удалённой передачи | Добавлен общий sanitizer для event payloads, checkpoints, memory writes, model output и context injection |
| Дедупликация | Точное совпадение части объектов | Семантическое сопоставление и update/dedup потоки | Добавлена нормализация exact и консервативная vector dedup по одинаковому `kind`, с provenance |
| Забывание и восстановление | Не было удобного интерфейса для пользовательской памяти | Управление жизненным циклом записей | Добавлены `memory_list`, `memory_forget`, `memory_restore` и slash-команды; forget является soft-delete |
| Межпроектный профиль пользователя | Основной фокус — проектная БД | Отдельная memory-поверхность профиля пользователя между проектами | Отложено: требуется отдельное user-level хранилище и явные правила изоляции проектов |
| Export/import | Markdown export | JSON export/import/migrate и Markdown vault | Сохранён текущий export; полноценный round-trip JSON import/export оставлен следующим этапом |
| Web UI | Нет | Локальная панель управления/просмотра памяти | Отложено, чтобы не добавлять локальный HTTP сервер и поверхность атаки в core plugin |
| Dreaming / фоновая консолидация | Ручная и событийная консолидация | Фоновая консолидация и update-on-capture | Не включено автоматически: для проектных решений важнее сохранять исходные claims и историю, а не молча переписывать память |

## Реализованные улучшения

### 1. Relevant recall

V2 `context` hook извлекает последний пользовательский prompt из `event.messages`, пропускает prompt через redaction, затем выполняет hybrid search. В context pack включаются релевантные записи, активные решения, claims и открытые конфликты. Повтор одинакового prompt в tool loop кэшируется на короткий интервал.

Параметры в `.opencode/memory.config.json`:

```json
{
  "recall": {
    "enabled": true,
    "mode": "relevant",
    "maxMemories": 6,
    "maxContextChars": 10000,
    "cacheMs": 15000,
    "includeRecentFallback": true
  }
}
```

`mode` принимает `relevant`, `recent` или `both`. При недоступности embedding API Memory Intelligence сначала использует свои FTS5/Graph retrieval каналы; при ошибке всего retrieval-пайплайна включается recent-memory fallback, чтобы недоступность памяти не блокировала запрос модели.

### 2. Privacy boundary

Добавлен `privacy.ts`, единый best-effort слой очистки перед сохранением event payload, checkpoint, долговременных memory entries, данных extraction и перед injection в prompt.

Он обнаруживает ряд распространённых форматов: OpenRouter/OpenAI/Anthropic, GitHub, Slack, Google, AWS access-key ID, Bearer/JWT и PEM private keys. Содержимое `<private>...</private>` заменяется заглушкой. Это не DLP и не гарантия распознавания всех секретов. Уже имеющиеся в старой БД записи автоматически не переписываются.

Настройки:

```json
{
  "privacy": {
    "redactCredentials": true,
    "redactPrivateTags": true
  }
}
```

### 3. Conservative semantic dedup

`memory_write` проходит:

1. Unicode NFKC + case/punctuation/whitespace normalized exact match внутри того же проекта и `kind`.
2. Для достаточно длинного текста — vector similarity сопоставление только с тем же `kind`.
3. Семантическое совпадение принимается только при реальном vector similarity score выше `deduplication.similarityThreshold` (default `0.92`). FTS или graph match не являются основанием подавить новую запись.
4. При совпадении сохраняется evidence от нового источника, а исходная запись остаётся неизменной.
5. Если векторный сервис недоступен, происходит fallback к созданию отдельной записи.

Разные/противоречащие значения не объединяются как дубликаты — temporal claims/conflict engine продолжает рассматривать их отдельно.

### 4. Memory lifecycle controls

Добавлены:

- `memory_list` / `/memory-list [query]`;
- `memory_forget` / `/memory-forget <memory-id>`;
- `memory_restore` / `/memory-restore <memory-id>`.

`forget` — recoverable soft delete, не secure erase: поисковые FTS/vector индексы удаляются, а исходная запись и provenance сохраняются в SQLite. `restore` возвращает FTS-запись; embeddings пересоздаются через `/memory-reindex`.

## Что сознательно не перенесено

1. **Cross-project user profile.** Нельзя автоматически смешивать личные предпочтения и приватные факты разных проектов. Нужны отдельный user-scope database, opt-in политика и ACL.
2. **Web dashboard.** Потребуется локальный HTTP сервер, а значит отдельная модель безопасности, аутентификация, CSRF/localhost ограничения и управление жизненным циклом.
3. **Автоматическое supersede/update и dreaming.** Система разработки должна сохранять историю прежних решений и противоречий. Автоматический update может уничтожить значимый исторический факт. Можно добавить review queue с подтверждением, но не silently rewrite.
4. **Полноценный JSON import/export round-trip.** Потребуется manifest версии схемы, валидация, remap IDs, проверка collisions и транзакционный rollback. Markdown export не заменяет этот контракт.
5. **Turso/cloud sync и мульти-пользовательская серверная БД.** Текущая версия намеренно локальная SQLite с `sqlite-vec`, чтобы сохранить локальность и обратную совместимость с существующей базой `.orchestrator/orchestrator.sqlite`.

## Конфигурация и проверка

Порог сессионного автосохранения по-прежнему настраивается в `.opencode/orchestrator.config.json` в `memory.autoSave.tokenThreshold`. Новые `recall`, `privacy`, `deduplication` настройки находятся в `.opencode/memory.config.json`.

Локальные тесты:

```powershell
cd .opencode\packages\memory-intelligence-core
bun run test:privacy
bun run test:auto-save
bun run test:intelligence
bun run test:vector
bun run test:shared-client
```

Полный runtime-тест с OpenCode V2, Bun и действующим OpenRouter API key необходим в целевом окружении. Статические проверки TypeScript и локальные unit/smoke тесты не заменяют проверку установленного плагина в реальном OpenCode.

## Источники

- GitHub repository and README: https://github.com/tickernelz/opencode-mem
- npm package/version: https://www.npmjs.com/package/opencode-mem
- OpenCode plugin API: https://opencode.ai/docs/plugins/
- OpenCode plugin hooks: https://opencode.ai/docs/plugins/#hooks
