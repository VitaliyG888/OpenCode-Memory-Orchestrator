import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMemoryConfig } from "./config";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "./privacy";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const json = (v: unknown) => JSON.stringify(v ?? null);
const normalizeTaskTitle = (value: unknown) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 300);

export class MemoryStore {
  db: Database;
  root: string;
  projectId: string | null = null;
  ftsAvailable = false;
  vectorAvailable = false;
  vectorError: string | null = null;
  embeddingProvider: "openrouter" | "openai-compatible" | "ollama" = "openrouter";
  embeddingBaseUrl = "https://openrouter.ai/api/v1";
  embeddingModel = "qwen/qwen3-embedding-8b";
  embeddingApiKeyEnv = "OPENROUTER_API_KEY";
  private embeddingApiKey = "";
  embeddingApiKeyConfigured = false;
  embeddingApiKeySource: "section_config" | "provider_config" | "environment" | "missing" = "missing";
  embeddingPromptProfile = "plain";
  embeddingTimeoutMs = 120000;
  embeddingBatchSize = 24;
  embeddingDimensions: number | undefined;
  embeddingInputTypeQuery: string | undefined;
  embeddingInputTypeDocument: string | undefined;
  deduplicationEnabled = true;
  deduplicationSimilarityThreshold = 0.92;
  privacyOptions = { redactCredentials: true, redactPrivateTags: true };

  constructor(projectRoot: string) {
    const fileConfig = readMemoryConfig(projectRoot);
    const embedding = fileConfig.embedding || {};
    const providers = fileConfig.providers || {};
    const deduplication = fileConfig.deduplication || {};
    const privacy = fileConfig.privacy || {};
    this.deduplicationEnabled = String(deduplication.enabled ?? true) !== "false";
    this.deduplicationSimilarityThreshold = Math.min(Math.max(Number(deduplication.similarityThreshold ?? 0.92), 0.70), 0.999);
    this.privacyOptions = {
      redactCredentials: String(privacy.redactCredentials ?? true) !== "false",
      redactPrivateTags: String(privacy.redactPrivateTags ?? true) !== "false",
    };
    this.embeddingProvider = (process.env.ORCH_EMBEDDING_PROVIDER || embedding.provider || "openrouter") as any;
    this.embeddingModel = process.env.ORCH_EMBEDDING_MODEL || embedding.model ||
      (this.embeddingProvider === "ollama" ? "embeddinggemma" : "qwen/qwen3-embedding-8b");
    this.embeddingBaseUrl = process.env.ORCH_EMBEDDING_BASE_URL ||
      process.env.ORCH_OLLAMA_URL || embedding.baseUrl ||
      (this.embeddingProvider === "ollama" ? "http://127.0.0.1:11434" : "https://openrouter.ai/api/v1");
    this.embeddingApiKeyEnv = process.env.ORCH_EMBEDDING_API_KEY_ENV || embedding.apiKeyEnv ||
      (this.embeddingProvider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY");
    const sectionApiKey = typeof embedding.apiKey === "string" ? embedding.apiKey.trim() : "";
    const providerApiKey = typeof providers?.[this.embeddingProvider]?.apiKey === "string"
      ? providers[this.embeddingProvider].apiKey.trim() : "";
    const environmentApiKey = (process.env.ORCH_EMBEDDING_API_KEY || process.env[this.embeddingApiKeyEnv] || "").trim();
    this.embeddingApiKey = sectionApiKey || providerApiKey || environmentApiKey;
    this.embeddingApiKeyConfigured = Boolean(this.embeddingApiKey);
    this.embeddingApiKeySource = sectionApiKey ? "section_config" : providerApiKey ? "provider_config" :
      environmentApiKey ? "environment" : "missing";
    this.embeddingPromptProfile = process.env.ORCH_EMBEDDING_PROMPT_PROFILE || embedding.promptProfile || "plain";
    this.embeddingTimeoutMs = Number(process.env.ORCH_EMBEDDING_TIMEOUT_MS || embedding.timeoutMs || 120000);
    this.embeddingBatchSize = Math.min(Math.max(Number(embedding.batchSize || 24), 1), 128);
    this.embeddingDimensions = Number(process.env.ORCH_EMBEDDING_DIMENSIONS || embedding.dimensions) || undefined;
    this.embeddingInputTypeQuery = embedding.inputTypeQuery;
    this.embeddingInputTypeDocument = embedding.inputTypeDocument;
    if (!["openrouter", "openai-compatible", "ollama"].includes(this.embeddingProvider)) {
      throw new Error(`Unsupported embedding provider: ${this.embeddingProvider}`);
    }
    this.root = join(projectRoot, ".orchestrator");
    mkdirSync(join(this.root, "backups"), { recursive: true });
    mkdirSync(join(this.root, "exports"), { recursive: true });
    this.db = new Database(join(this.root, "orchestrator.sqlite"), { create: true });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    try {
      sqliteVec.load(this.db);
      this.db.query("SELECT vec_version() AS version").get();
      this.vectorAvailable = true;
    } catch (error) {
      this.vectorError = error instanceof Error ? error.message : String(error);
      console.warn("[memory-intelligence] sqlite-vec unavailable; semantic vector search is disabled", this.vectorError);
    }
    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
    this.db.exec(schema);
    // Backfill one historical snapshot for records created before Memory Intelligence existed.
    const legacyProjects = this.db.query(`SELECT p.* FROM projects p LEFT JOIN project_versions v ON v.project_id=p.id WHERE v.id IS NULL`).all() as any[];
    for (const project of legacyProjects) {
      this.db.query(`INSERT OR IGNORE INTO project_versions(id,project_id,version,snapshot_json,valid_from,recorded_at,reason)
        VALUES(?,?,?,?,?,?,?)`).run(`pver_legacy_${project.id}`, project.id, 1, JSON.stringify(project), project.created_at, project.created_at, "legacy_backfill");
    }
    const legacyTasks = this.db.query(`SELECT t.* FROM tasks t LEFT JOIN task_versions v ON v.task_id=t.id WHERE v.id IS NULL`).all() as any[];
    for (const task of legacyTasks) {
      this.db.query(`INSERT OR IGNORE INTO task_versions(id,project_id,task_id,version,snapshot_json,valid_from,recorded_at,reason)
        VALUES(?,?,?,?,?,?,?,?)`).run(`tver_legacy_${task.id}`, task.project_id, task.id, 1, JSON.stringify(task), task.created_at, task.created_at, "legacy_backfill");
    }
    const legacySessions = this.db.query(`SELECT s.* FROM sessions s LEFT JOIN session_versions v ON v.session_id=s.id WHERE v.id IS NULL`).all() as any[];
    for (const session of legacySessions) {
      this.db.query(`INSERT OR IGNORE INTO session_versions(id,project_id,session_id,version,snapshot_json,valid_from,recorded_at,reason)
        VALUES(?,?,?,?,?,?,?,?)`).run(`sver_legacy_${session.id}`, session.project_id, session.id, 1, JSON.stringify(session), session.created_at, session.created_at, "legacy_backfill");
    }
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, title, content, tags, tokenize='unicode61');");
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(chunk_id UNINDEXED, memory_id UNINDEXED, content, tokenize='unicode61');");
      this.ftsAvailable = true;
    } catch { this.ftsAvailable = false; }
    this.backfillLegacyChunks();
  }

  private backfillLegacyChunks() {
    const missing = this.db.query(`SELECT m.* FROM memory_entries m
      LEFT JOIN memory_chunks c ON c.memory_id=m.id
      WHERE c.id IS NULL`).all() as any[];
    if (!missing.length) return;
    const tx = this.db.transaction((rows: any[]) => {
      for (const memory of rows) {
        const chunks = String(memory.content || "").match(/[\s\S]{1,1400}/g) || [String(memory.content || "")];
        chunks.forEach((content: string, index: number) => {
          const chunkId = id("chk");
          this.db.query(`INSERT INTO memory_chunks(id,memory_id,chunk_index,content,token_estimate,created_at)
            VALUES(?,?,?,?,?,?)`).run(chunkId, memory.id, index, content, Math.ceil(content.length / 4), now());
          if (this.ftsAvailable) this.db.query("INSERT INTO chunk_fts(chunk_id,memory_id,content) VALUES(?,?,?)").run(chunkId, memory.id, content);
          this.addNode(memory.project_id, "chunk", chunkId, `${memory.title} · chunk ${index + 1}`);
          this.edge(memory.project_id, "memory", memory.id, "chunk", chunkId, "contains_chunk");
        });
        if (this.ftsAvailable) {
          const exists = this.db.query("SELECT 1 AS ok FROM memory_fts WHERE memory_id=? LIMIT 1").get(memory.id);
          if (!exists) this.db.query("INSERT INTO memory_fts(memory_id,title,content,tags) VALUES(?,?,?,?)")
            .run(memory.id, memory.title, memory.content, memory.tags || "[]");
        }
      }
    });
    tx(missing);
    console.log(`[memory-intelligence] migrated ${missing.length} legacy memories into chunks`);
  }

  event(projectId: string | null, type: string, payload: unknown = {}, sessionId?: string, taskId?: string, key?: string) {
    payload = sanitizeSensitiveValue(payload, this.privacyOptions);
    this.db.query(`INSERT OR IGNORE INTO events(id,project_id,session_id,task_id,event_type,payload,idempotency_key,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id("evt"), projectId, sessionId ?? null, taskId ?? null, type, json(payload), key ?? null, now());
  }

  registerProject(input: { name: string; goal: string; rootPath: string }) {
    const existing = this.db.query("SELECT id FROM projects WHERE root_path=? ORDER BY created_at DESC LIMIT 1").get(input.rootPath) as any;
    const projectId = existing?.id ?? id("prj");
    const t = now();
    this.db.query(`INSERT INTO projects(id,name,root_path,goal,status,created_at,updated_at)
      VALUES(?,?,?,?, 'active',?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,goal=excluded.goal,updated_at=excluded.updated_at`)
      .run(projectId, input.name, input.rootPath, input.goal, t, t);
    this.projectId = projectId;
    const projectRow = this.db.query("SELECT * FROM projects WHERE id=?").get(projectId) as any;
    const lastVersion = this.db.query("SELECT version,snapshot_json FROM project_versions WHERE project_id=? ORDER BY version DESC LIMIT 1").get(projectId) as any;
    const lastSnapshot = lastVersion ? JSON.parse(lastVersion.snapshot_json) : null;
    const projectChanged = !lastSnapshot || ["name", "root_path", "goal", "status"].some(key => lastSnapshot[key] !== projectRow[key]);
    if (projectChanged) {
      const version = Number(lastVersion?.version || 0) + 1;
      this.db.query(`INSERT INTO project_versions(id,project_id,version,snapshot_json,valid_from,recorded_at,reason)
        VALUES(?,?,?,?,?,?,?)`).run(id("pver"), projectId, version, json(projectRow), t, t, lastVersion ? "project_updated" : "project_created");
    }
    this.event(projectId, "PROJECT_REGISTERED", input);
    return { projectId };
  }

  createTask(input: { projectId: string; parentTaskId?: string; title: string; description: string; acceptanceCriteria?: string[]; priority?: number; dependencies?: string[] }) {
    const taskId = id("tsk"), t = now();
    this.db.query(`INSERT INTO tasks(id,project_id,parent_task_id,title,description,acceptance_criteria,status,priority,dependencies,created_at,updated_at)
      VALUES(?,?,?,?,?,'[]','planned',?,?,?,?)`).run(taskId, input.projectId, input.parentTaskId ?? null, input.title, input.description,
        input.priority ?? 3, json(input.dependencies ?? []), t, t);
    this.db.query("UPDATE tasks SET acceptance_criteria=? WHERE id=?").run(json(input.acceptanceCriteria ?? []), taskId);
    this.addNode(input.projectId, "task", taskId, input.title);
    if (input.parentTaskId) this.edge(input.projectId, "task", input.parentTaskId, "task", taskId, "parent_of");
    const taskRow = this.db.query("SELECT * FROM tasks WHERE id=?").get(taskId) as any;
    this.db.query(`INSERT INTO task_versions(id,project_id,task_id,version,snapshot_json,valid_from,recorded_at,reason)
      VALUES(?,?,?,?,?,?,?,?)`).run(id("tver"), input.projectId, taskId, 1, json(taskRow), t, t, "task_created");
    this.event(input.projectId, "TASK_CREATED", input, undefined, taskId);
    return { taskId };
  }

  updateTask(input: { projectId: string; taskId: string; status?: string; result?: string; priority?: number; title?: string; description?: string; validFrom?: string; reason?: string }) {
    const existing = this.db.query("SELECT * FROM tasks WHERE id=? AND project_id=?").get(input.taskId, input.projectId) as any;
    if (!existing) throw new Error(`Task not found: ${input.taskId}`);
    const allowedStatuses = new Set(["planned", "ready", "in_progress", "blocked", "completed", "cancelled", "failed"]);
    if (input.status && !allowedStatuses.has(input.status)) throw new Error(`Unsupported task status: ${input.status}`);
    const updated = { ...existing,
      status: input.status ?? existing.status,
      result: input.result ?? existing.result,
      priority: input.priority ?? existing.priority,
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      updated_at: now()
    };
    this.db.query(`UPDATE tasks SET status=?,result=?,priority=?,title=?,description=?,updated_at=? WHERE id=? AND project_id=?`)
      .run(updated.status, updated.result, updated.priority, updated.title, updated.description, updated.updated_at, input.taskId, input.projectId);
    const lastVersion = this.db.query("SELECT version FROM task_versions WHERE task_id=? ORDER BY version DESC LIMIT 1").get(input.taskId) as any;
    const version = Number(lastVersion?.version || 0) + 1;
    const recordedAt = now();
    const validFrom = input.validFrom && Number.isFinite(Date.parse(input.validFrom)) ? new Date(input.validFrom).toISOString() : recordedAt;
    this.db.query(`INSERT INTO task_versions(id,project_id,task_id,version,snapshot_json,valid_from,recorded_at,reason)
      VALUES(?,?,?,?,?,?,?,?)`).run(id("tver"), input.projectId, input.taskId, version, json(updated), validFrom, recordedAt, input.reason || "task_updated");
    this.event(input.projectId, "TASK_UPDATED", { taskId: input.taskId, previousStatus: existing.status, status: updated.status, validFrom, reason: input.reason });
    return { taskId: input.taskId, version, task: updated, validFrom, recordedAt };
  }

  createSessionRecord(input: { projectId: string; opencodeSessionId: string; parentSessionId?: string; taskId?: string; title: string }) {
    const sessionId = id("ses"), t = now();
    this.db.query(`INSERT INTO sessions(id,project_id,opencode_session_id,parent_session_id,task_id,title,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'created',?,?)`).run(sessionId, input.projectId, input.opencodeSessionId, input.parentSessionId ?? null, input.taskId ?? null, input.title, t, t);
    this.addNode(input.projectId, "session", sessionId, input.title);
    if (input.taskId) this.edge(input.projectId, "task", input.taskId, "session", sessionId, "assigned_to");
    if (input.parentSessionId) this.edge(input.projectId, "session", input.parentSessionId, "session", sessionId, "parent_of");
    const sessionRow = this.db.query("SELECT * FROM sessions WHERE id=?").get(sessionId) as any;
    this.db.query(`INSERT INTO session_versions(id,project_id,session_id,version,snapshot_json,valid_from,recorded_at,reason)
      VALUES(?,?,?,?,?,?,?,?)`).run(id("sver"), input.projectId, sessionId, 1, json(sessionRow), t, t, "session_created");
    this.event(input.projectId, "SESSION_CREATED", input, sessionId, input.taskId);
    return { orchestratorSessionId: sessionId, opencodeSessionId: input.opencodeSessionId };
  }

  updateSession(input: { projectId: string; sessionId: string; status: string; summary?: string; validFrom?: string; reason?: string }) {
    const allowed = new Set(["created", "in_progress", "completed", "partial", "blocked", "failed", "cancelled"]);
    if (!allowed.has(input.status)) throw new Error(`Unsupported session status: ${input.status}`);
    const existing = this.db.query("SELECT * FROM sessions WHERE project_id=? AND (id=? OR opencode_session_id=?)").get(input.projectId, input.sessionId, input.sessionId) as any;
    if (!existing) throw new Error(`Session not found: ${input.sessionId}`);
    const recordedAt = now();
    const validFrom = input.validFrom && Number.isFinite(Date.parse(input.validFrom)) ? new Date(input.validFrom).toISOString() : recordedAt;
    const terminal = new Set(["completed", "partial", "blocked", "failed", "cancelled"]);
    const updated = { ...existing, status: input.status,
      started_at: existing.started_at || (input.status === "in_progress" ? validFrom : null),
      ended_at: terminal.has(input.status) ? (existing.ended_at || validFrom) : existing.ended_at,
      updated_at: recordedAt };
    this.db.query("UPDATE sessions SET status=?,started_at=?,ended_at=?,updated_at=? WHERE id=?")
      .run(updated.status, updated.started_at, updated.ended_at, updated.updated_at, existing.id);
    const last = this.db.query("SELECT version FROM session_versions WHERE session_id=? ORDER BY version DESC LIMIT 1").get(existing.id) as any;
    const version = Number(last?.version || 0) + 1;
    this.db.query(`INSERT INTO session_versions(id,project_id,session_id,version,snapshot_json,valid_from,recorded_at,reason)
      VALUES(?,?,?,?,?,?,?,?)`).run(id("sver"), input.projectId, existing.id, version, json(updated), validFrom, recordedAt, input.reason || "session_updated");
    this.event(input.projectId, "SESSION_UPDATED", { sessionId: existing.id, status: input.status, summary: input.summary, validFrom, reason: input.reason }, existing.id, existing.task_id);
    return { sessionId: existing.id, version, status: input.status, validFrom, recordedAt };
  }

  addNode(projectId: string, type: string, entityId: string, label: string) {
    const nodeId = `${type}:${entityId}`;
    this.db.query(`INSERT OR IGNORE INTO graph_nodes(id,project_id,node_type,entity_id,label,created_at) VALUES(?,?,?,?,?,?)`)
      .run(nodeId, projectId, type, entityId, label, now());
    return nodeId;
  }

  edge(projectId: string, sourceType: string, sourceId: string, targetType: string, targetId: string, relation: string, weight = 1) {
    const s = this.addNode(projectId, sourceType, sourceId, sourceId);
    const t = this.addNode(projectId, targetType, targetId, targetId);
    this.db.query(`INSERT OR IGNORE INTO graph_edges(id,project_id,source_node_id,target_node_id,relation,weight,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(id("edge"), projectId, s, t, relation, weight, now());
  }

  async writeMemory(input: { projectId: string; sessionId?: string; taskId?: string; kind: string; title: string; content: string; source?: string; sourceRef?: string; importance?: number; confidence?: number; status?: string; tags?: string[]; concepts?: string[] }) {
    input = {
      ...input,
      kind: sanitizeSensitiveText(input.kind, this.privacyOptions).slice(0, 80),
      title: sanitizeSensitiveText(input.title, this.privacyOptions).slice(0, 300),
      content: sanitizeSensitiveText(input.content, this.privacyOptions),
      source: input.source ? sanitizeSensitiveText(input.source, this.privacyOptions).slice(0, 100) : input.source,
      sourceRef: input.sourceRef ? sanitizeSensitiveText(input.sourceRef, this.privacyOptions).slice(0, 500) : input.sourceRef,
      tags: (input.tags || []).map((tag) => sanitizeSensitiveText(tag, this.privacyOptions).slice(0, 100)).filter(Boolean),
      concepts: (input.concepts || []).map((concept) => sanitizeSensitiveText(concept, this.privacyOptions).slice(0, 200)).filter(Boolean),
    };
    const memoryId = id("mem"), t = now();
    const entry = {
      id: memoryId, project_id: input.projectId, session_id: input.sessionId ?? null, task_id: input.taskId ?? null,
      kind: input.kind, title: input.title, content: input.content, source: input.source ?? "agent",
      source_ref: input.sourceRef ?? null, importance: input.importance ?? 3, confidence: input.confidence ?? 1,
      status: input.status ?? "active", tags: json(input.tags ?? []), created_at: t, updated_at: t,
      supersedes_id: null, embedding_ref: null
    };
    this.db.query(`INSERT INTO memory_entries(id,project_id,session_id,task_id,kind,title,content,source,source_ref,importance,confidence,status,tags,created_at,updated_at)
      VALUES($id,$project_id,$session_id,$task_id,$kind,$title,$content,$source,$source_ref,$importance,$confidence,$status,$tags,$created_at,$updated_at)`).run(entry);
    this.db.query("INSERT INTO memory_versions(id,memory_id,version,snapshot_json,reason,created_at) VALUES(?,?,?,?,?,?)")
      .run(id("ver"), memoryId, 1, json(entry), "initial", t);
    this.addNode(input.projectId, "memory", memoryId, input.title);
    if (input.sessionId) this.edge(input.projectId, "session", input.sessionId, "memory", memoryId, "produced");
    if (input.taskId) this.edge(input.projectId, "task", input.taskId, "memory", memoryId, "produced");
    if (this.ftsAvailable) this.db.query("INSERT INTO memory_fts(memory_id,title,content,tags) VALUES(?,?,?,?)").run(memoryId, input.title, input.content, (input.tags ?? []).join(" "));
    const chunks = input.content.match(/[\s\S]{1,1400}/g) || [input.content];
    chunks.forEach((chunk, index) => {
      const chunkId = id("chk");
      this.db.query("INSERT INTO memory_chunks(id,memory_id,chunk_index,content,token_estimate,created_at) VALUES(?,?,?,?,?,?)")
        .run(chunkId, memoryId, index, chunk, Math.ceil(chunk.length / 4), t);
      if (this.ftsAvailable) this.db.query("INSERT INTO chunk_fts(chunk_id,memory_id,content) VALUES(?,?,?)").run(chunkId, memoryId, chunk);
      this.addNode(input.projectId, "chunk", chunkId, `${input.title} · chunk ${index + 1}`);
      this.edge(input.projectId, "memory", memoryId, "chunk", chunkId, "contains_chunk");
    });
    for (const raw of input.concepts ?? []) {
      const name = raw.trim();
      if (!name) continue;
      const conceptId = id("con");
      this.db.query(`INSERT OR IGNORE INTO concepts(id,project_id,name,normalized_name,created_at) VALUES(?,?,?,?,?)`)
        .run(conceptId, input.projectId, name, name.toLowerCase(), t);
      const concept = this.db.query("SELECT id FROM concepts WHERE project_id=? AND normalized_name=?").get(input.projectId, name.toLowerCase()) as any;
      this.db.query("INSERT OR IGNORE INTO memory_concepts(memory_id,concept_id,weight) VALUES(?,?,1)").run(memoryId, concept.id);
      const conceptNode = this.addNode(input.projectId, "concept", concept.id, name);
      this.db.query(`INSERT OR IGNORE INTO graph_edges(id,project_id,source_node_id,target_node_id,relation,weight,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(id("edge"), input.projectId, `memory:${memoryId}`, conceptNode, "mentions_concept", 1, t);
    }
    let vectorIndex: any = { indexed: 0, enabled: false };
    if (this.vectorAvailable) {
      try {
        vectorIndex = await this.indexMemory(memoryId);
      } catch (error) {
        vectorIndex = { indexed: 0, enabled: true, error: error instanceof Error ? error.message : String(error) };
        this.event(input.projectId, "EMBEDDING_INDEX_FAILED", { memoryId, error: vectorIndex.error }, input.sessionId, input.taskId);
      }
    }
    this.event(input.projectId, "MEMORY_CREATED", { memoryId, kind: input.kind, vectorIndex }, input.sessionId, input.taskId);
    return { memoryId, vectorIndex };
  }

  private modelKey(model = this.embeddingModel) {
    return model.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "embedding";
  }

  private vectorTable(model: string, dimensions: number) {
    if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 8192) throw new Error(`Unsupported embedding dimension: ${dimensions}`);
    const table = `vec_${this.modelKey(model)}_${dimensions}`;
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
      project_id TEXT PARTITION KEY,
      session_key TEXT,
      task_key TEXT,
      embedding float[${dimensions}] distance_metric=cosine
    )`);
    return table;
  }

  private async embedTexts(texts: string[], purpose: "query" | "document"): Promise<number[][]> {
    if (!texts.length) return [];
    const formatted = this.embeddingPromptProfile === "embeddinggemma"
      ? purpose === "query"
        ? texts.map(text => `task: search result | query: ${text}`)
        : texts.map(text => {
            const split = text.indexOf("\n");
            const title = split >= 0 ? text.slice(0, split).trim() : "none";
            const content = split >= 0 ? text.slice(split + 1) : text;
            return `title: ${title || "none"} | text: ${content}`;
          })
      : texts;

    const isOllama = this.embeddingProvider === "ollama";
    const endpoint = isOllama ? "/api/embed" : "/embeddings";
    const apiKey = this.embeddingApiKey;
    if (!isOllama && !apiKey) throw new Error(`Missing API key: set embedding.apiKey, providers.${this.embeddingProvider}.apiKey, or ${this.embeddingApiKeyEnv}`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!isOllama) headers.authorization = `Bearer ${apiKey}`;
    const body: Record<string, unknown> = isOllama
      ? { model: this.embeddingModel, input: formatted, truncate: true }
      : { model: this.embeddingModel, input: formatted, encoding_format: "float" };
    if (!isOllama && this.embeddingDimensions) body.dimensions = this.embeddingDimensions;
    const inputType = purpose === "query" ? this.embeddingInputTypeQuery : this.embeddingInputTypeDocument;
    if (!isOllama && inputType) body.input_type = inputType;

    const response = await fetch(`${this.embeddingBaseUrl.replace(/\/$/, "")}${endpoint}`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.embeddingTimeoutMs)
    });
    if (!response.ok) throw new Error(`${this.embeddingProvider} embedding API returned HTTP ${response.status}: ${(await response.text()).slice(0, 700)}`);
    const data = await response.json() as any;
    let rawVectors: any[];
    if (isOllama) rawVectors = data.embeddings;
    else if (Array.isArray(data.data)) rawVectors = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item: any) => item.embedding);
    else rawVectors = [];
    if (!Array.isArray(rawVectors) || rawVectors.length !== texts.length) {
      throw new Error(`${this.embeddingProvider} returned an unexpected embeddings payload (expected ${texts.length} vectors)`);
    }
    const vectors = rawVectors.map((v: any) => Array.from(v, Number));
    const dimension = vectors[0]?.length;
    if (!dimension || vectors.some((v: number[]) => v.length !== dimension || v.some(x => !Number.isFinite(x)))) {
      throw new Error("Embedding vectors have inconsistent dimensions or non-finite values");
    }
    if (this.embeddingDimensions && dimension !== this.embeddingDimensions) {
      throw new Error(`Embedding model returned ${dimension} dimensions, but config requires ${this.embeddingDimensions}`);
    }
    return vectors;
  }

  async checkEmbeddingConnection() {
    try {
      const [vector] = await this.embedTexts(["OpenCode orchestrator embedding connection test"], "query");
      return { available: true, provider: this.embeddingProvider, model: this.embeddingModel, dimensions: vector.length };
    } catch (error) {
      return { available: false, provider: this.embeddingProvider, model: this.embeddingModel,
        error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async indexChunks(chunkRows: any[]) {
    if (!this.vectorAvailable || !chunkRows.length) return { enabled: this.vectorAvailable, indexed: 0 };
    const BATCH_SIZE = this.embeddingBatchSize;
    let indexed = 0;
    for (let offset = 0; offset < chunkRows.length; offset += BATCH_SIZE) {
      const batch = chunkRows.slice(offset, offset + BATCH_SIZE);
      const vectors = await this.embedTexts(batch.map(x => `${x.title || "none"}\n${x.content}`), "document");
      const dimensions = vectors[0].length;
      const table = this.vectorTable(this.embeddingModel, dimensions);
      const insertVector = this.db.query(`INSERT INTO ${table}(rowid, project_id, session_key, task_key, embedding)
        VALUES(?,?,?,?,vec_f32(?))`);
      const tx = this.db.transaction((items: any[]) => {
        for (let i = 0; i < items.length; i++) {
          const chunk = items[i], vector = vectors[i];
          const contentHash = createHash("sha256").update(JSON.stringify([
            chunk.title || "none", chunk.content, chunk.project_id, chunk.session_id || null,
            chunk.task_id || null, this.embeddingModel, this.embeddingPromptProfile
          ])).digest("hex");
          const old = this.db.query("SELECT vector_rowid,table_name,content_hash FROM vector_index WHERE chunk_id=?").get(chunk.id) as any;
          if (old?.content_hash === contentHash && old?.table_name === table) continue;
          if (old) {
            if (!/^vec_[a-z0-9_]+_\d+$/.test(old.table_name)) throw new Error("Invalid vector table name in vector_index");
            this.db.query(`DELETE FROM ${old.table_name} WHERE rowid=?`).run(old.vector_rowid);
            this.db.query("DELETE FROM vector_index WHERE vector_rowid=?").run(old.vector_rowid);
          }
          const mapping = this.db.query(`INSERT INTO vector_index(chunk_id,table_name,model_name,dimensions,content_hash,created_at)
            VALUES(?,?,?,?,?,?) RETURNING vector_rowid`).get(chunk.id, table, this.embeddingModel, dimensions, contentHash, now()) as any;
          insertVector.run(mapping.vector_rowid, chunk.project_id, chunk.session_id || "__none__", chunk.task_id || "__none__", new Float32Array(vector));
          indexed++;
        }
      });
      tx(batch);
    }
    return { enabled: true, indexed, model: this.embeddingModel };
  }

  async indexMemory(memoryId: string) {
    const chunks = this.db.query(`SELECT c.id,c.content,m.title,m.project_id,m.session_id,m.task_id
      FROM memory_chunks c JOIN memory_entries m ON m.id=c.memory_id
      WHERE c.memory_id=? ORDER BY c.chunk_index`).all(memoryId) as any[];
    return this.indexChunks(chunks);
  }

  async reindexPending(input: { projectId: string; limit?: number }) {
    if (!this.vectorAvailable) return { enabled: false, error: this.vectorError || "sqlite-vec is unavailable" };
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const candidates = this.db.query(`SELECT c.id,c.content,m.title,m.project_id,m.session_id,m.task_id,
        vi.content_hash,vi.model_name
      FROM memory_chunks c
      JOIN memory_entries m ON m.id=c.memory_id
      LEFT JOIN vector_index vi ON vi.chunk_id=c.id
      WHERE m.project_id=? AND m.status IN ('active','confirmed')
      ORDER BY c.created_at`).all(input.projectId) as any[];
    const chunks = candidates.filter(chunk => {
      const expected = createHash("sha256").update(JSON.stringify([
        chunk.title || "none", chunk.content, chunk.project_id, chunk.session_id || null,
        chunk.task_id || null, this.embeddingModel, this.embeddingPromptProfile
      ])).digest("hex");
      return chunk.model_name !== this.embeddingModel || chunk.content_hash !== expected;
    }).slice(0, limit);
    const result = await this.indexChunks(chunks);
    this.event(input.projectId, "EMBEDDING_REINDEX_BATCH", { count: chunks.length, ...result });
    return { pendingSelected: chunks.length, ...result };
  }

  private graphExpandMemoryIds(projectId: string, seedMemoryIds: string[], depth = 2, limit = 50) {
    const seen = new Set(seedMemoryIds.map(id => `memory:${id}`));
    let frontier = [...seen];
    const discoveredMemoryIds = new Set<string>();
    const edges: any[] = [];
    for (let level = 0; level < Math.min(depth, 3) && frontier.length; level++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const rows = this.db.query(`SELECT e.*,s.node_type AS source_type,s.entity_id AS source_entity,
            t.node_type AS target_type,t.entity_id AS target_entity,
            s.label AS source_label,t.label AS target_label
          FROM graph_edges e
          JOIN graph_nodes s ON s.id=e.source_node_id
          JOIN graph_nodes t ON t.id=e.target_node_id
          WHERE e.project_id=? AND (e.source_node_id=? OR e.target_node_id=?) ORDER BY e.weight DESC LIMIT ?`)
          .all(projectId, nodeId, nodeId, limit) as any[];
        for (const edge of rows) {
          edges.push(edge);
          for (const [type, entityId, node] of [
            [edge.source_type, edge.source_entity, edge.source_node_id],
            [edge.target_type, edge.target_entity, edge.target_node_id]
          ] as any[]) {
            if (type === "memory") discoveredMemoryIds.add(entityId);
            if (!seen.has(node)) { seen.add(node); next.push(node); }
          }
        }
      }
      frontier = next;
    }
    return { memoryIds: [...discoveredMemoryIds].filter(id => !seedMemoryIds.includes(id)), edges: edges.slice(0, limit * 3) };
  }

  async semanticSearch(input: { projectId: string; query: string; sessionId?: string; taskId?: string; limit?: number; vectorCandidates?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const lexical = this.searchMemory({ ...input, limit: Math.max(limit * 3, 20) });
    let vectorRows: any[] = [];
    let embeddingWarning: string | null = null;
    if (this.vectorAvailable) {
      try {
        const [queryVector] = await this.embedTexts([input.query], "query");
        const table = this.vectorTable(this.embeddingModel, queryVector.length);
        const candidates = Math.floor(Math.min(Math.max(input.vectorCandidates ?? limit * 8, limit), 200));
        const sessionFilter = input.sessionId ? "AND session_key=?" : "";
        const taskFilter = input.taskId ? "AND task_key=?" : "";
        vectorRows = this.db.query(`WITH knn AS (
            SELECT rowid,distance FROM ${table}
            WHERE embedding MATCH ? AND project_id=? AND k=${candidates}
              ${sessionFilter} ${taskFilter}
          )
          SELECT vi.chunk_id,vi.vector_rowid,c.memory_id,c.content,knn.distance
          FROM knn
          JOIN vector_index vi ON vi.vector_rowid=knn.rowid
          JOIN memory_chunks c ON c.id=vi.chunk_id
          JOIN memory_entries m ON m.id=c.memory_id
          WHERE m.project_id=? AND m.status IN ('active','confirmed')
            AND vi.model_name=? AND vi.dimensions=?
          ORDER BY knn.distance`)
          .all(new Float32Array(queryVector), input.projectId,
            ...(input.sessionId ? [input.sessionId] : []), ...(input.taskId ? [input.taskId] : []),
            input.projectId, this.embeddingModel, queryVector.length) as any[];
      } catch (error) {
        embeddingWarning = error instanceof Error ? error.message : String(error);
      }
    } else embeddingWarning = this.vectorError || "sqlite-vec is unavailable";

    const ranked = new Map<string, any>();
    const add = (memoryId: string, channel: string, rank: number, extra: any = {}) => {
      if (!ranked.has(memoryId)) ranked.set(memoryId, { memoryId, rrfScore: 0, channels: [] });
      const item = ranked.get(memoryId);
      item.rrfScore += 1 / (60 + rank);
      if (!item.channels.includes(channel)) item.channels.push(channel);
      Object.assign(item, extra);
    };
    const bestVectorByMemory = new Map<string, any>();
    for (const row of vectorRows) {
      const prior = bestVectorByMemory.get(row.memory_id);
      if (!prior) bestVectorByMemory.set(row.memory_id, { ...row, matchedChunks: [String(row.content).slice(0, 900)] });
      else if (prior.matchedChunks.length < 3) prior.matchedChunks.push(String(row.content).slice(0, 900));
    }
    [...bestVectorByMemory.values()].forEach((r, i) => add(r.memory_id, "vector", i + 1, {
      cosineDistance: r.distance, semanticSimilarity: Math.max(0, 1 - Number(r.distance)),
      matchedChunks: r.matchedChunks
    }));
    lexical.forEach((r: any, i: number) => add(r.id, "fts5", i + 1, {
      lexicalScore: r.score, lexicalMatchedChunks: r.matched_chunks || r.content.slice(0, 900)
    }));
    try {
      // Pattern 1: lexical/concept query seeds the graph.
      const graph = this.graphQuery({ projectId: input.projectId, query: input.query, depth: 2, limit: 40 });
      const lexicalGraphIds = graph.nodes.filter((n: any) => n.node_type === "memory").map((n: any) => n.entity_id);
      lexicalGraphIds.forEach((memoryId: string, i: number) => add(memoryId, "graph_seed", i + 1));
      // Pattern 2: semantic/lexical result IDs become graph seeds, so related decisions,
      // tasks, sessions and files can be retrieved even when their wording differs.
      const expanded = this.graphExpandMemoryIds(input.projectId, [...ranked.keys()], 2, 50);
      expanded.memoryIds.forEach((memoryId: string, i: number) => add(memoryId, "graph_neighbor", i + 1));
    } catch {}

    const ids = [...ranked.keys()];
    const records = ids.length ? this.db.query(`SELECT * FROM memory_entries WHERE project_id=? AND status IN ('active','confirmed') AND id IN (${ids.map(() => "?").join(",")})`).all(input.projectId, ...ids) as any[] : [];
    const byId = new Map(records.map((r: any) => [r.id, r]));
    const results = [...ranked.values()].map(item => {
      const record: any = byId.get(item.memoryId);
      if (!record) return null;
      const freshness = Math.exp(-Math.max(0, Date.now() - Date.parse(record.updated_at)) / (1000 * 60 * 60 * 24 * 45));
      const importance = Math.max(1, Math.min(5, Number(record.importance || 3))) / 5;
      return { ...record, tags: JSON.parse(record.tags || "[]"), ...item,
        finalScore: item.rrfScore + 0.002 * importance + 0.001 * freshness };
    }).filter(Boolean).sort((a: any, b: any) => b.finalScore - a.finalScore).slice(0, limit);
    return { query: input.query, mode: this.vectorAvailable && !embeddingWarning ? "hybrid_vector_fts_graph" : "hybrid_fts_graph_fallback",
      embeddingModel: this.embeddingModel, vectorEnabled: this.vectorAvailable, embeddingWarning,
      resultCount: results.length, results };
  }

  searchMemory(input: { projectId: string; query: string; sessionId?: string; taskId?: string; limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    let rows: any[] = [];
    if (this.ftsAvailable && input.query.trim()) {
      try {
        const chunkRows = this.db.query(`SELECT m.*, bm25(chunk_fts) AS score, c.content AS matched_chunk
          FROM chunk_fts
          JOIN memory_chunks c ON c.id=chunk_fts.chunk_id
          JOIN memory_entries m ON m.id=c.memory_id
          WHERE chunk_fts MATCH ? AND m.project_id=? AND m.status IN ('active','confirmed')
          ${input.sessionId ? "AND m.session_id=?" : ""}
          ${input.taskId ? "AND m.task_id=?" : ""}
          ORDER BY score LIMIT ?`).all(input.query, input.projectId,
            ...(input.sessionId ? [input.sessionId] : []), ...(input.taskId ? [input.taskId] : []),
            Math.min(limit * 4, 200)) as any[];
        const grouped = new Map<string, any>();
        for (const row of chunkRows) {
          if (!grouped.has(row.id)) grouped.set(row.id, {
            ...row, matched_chunks: String(row.matched_chunk || "").slice(0, 600), matched_chunk: undefined
          });
          else {
            const existing = grouped.get(row.id);
            const next = String(row.matched_chunk || "").slice(0, 600);
            if (next && existing.matched_chunks.split("\n---\n").length < 3) {
              existing.matched_chunks += `\n---\n${next}`;
            }
          }
        }
        rows = [...grouped.values()].slice(0, limit);
      } catch { rows = []; }
    }
    if (!rows.length) {
      const like = `%${input.query}%`;
      rows = this.db.query(`SELECT *, 0.0 AS score FROM memory_entries
        WHERE project_id=? AND status IN ('active','confirmed')
        AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
        ${input.sessionId ? "AND session_id=?" : ""}
        ${input.taskId ? "AND task_id=?" : ""}
        ORDER BY importance DESC, updated_at DESC LIMIT ?`).all(input.projectId, like, like, like,
          ...(input.sessionId ? [input.sessionId] : []), ...(input.taskId ? [input.taskId] : []), limit) as any[];
    }
    return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") }));
  }

  graphQuery(input: { projectId: string; query: string; depth?: number; limit?: number }) {
    const depth = Math.min(Math.max(input.depth ?? 2, 1), 4);
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const seeds = this.db.query(`SELECT id,node_type,entity_id,label FROM graph_nodes
      WHERE project_id=? AND (label LIKE ? OR entity_id LIKE ?) LIMIT ?`)
      .all(input.projectId, `%${input.query}%`, `%${input.query}%`, limit) as any[];
    const seen = new Set<string>(seeds.map(x => x.id));
    let frontier = seeds.map(x => x.id);
    const edges: any[] = [];
    for (let d=0; d<depth && frontier.length; d++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const found = this.db.query(`SELECT e.*, s.label AS source_label, t.label AS target_label
          FROM graph_edges e JOIN graph_nodes s ON s.id=e.source_node_id
          JOIN graph_nodes t ON t.id=e.target_node_id
          WHERE e.project_id=? AND (e.source_node_id=? OR e.target_node_id=?) ORDER BY e.weight DESC LIMIT ?`)
          .all(input.projectId, nodeId, nodeId, limit) as any[];
        for (const e of found) {
          edges.push(e);
          for (const candidate of [e.source_node_id, e.target_node_id]) {
            if (!seen.has(candidate)) { seen.add(candidate); next.push(candidate); }
          }
        }
      }
      frontier = next;
    }
    const nodes = [...seen].map(nodeId => this.db.query("SELECT * FROM graph_nodes WHERE id=?").get(nodeId)).filter(Boolean);
    return { seeds, nodes, edges: edges.slice(0, limit * 3), depth };
  }

  findSessionIngestion(projectId: string, opencodeSessionId: string, transcriptHash: string) {
    return this.db.query(`SELECT * FROM session_ingestions WHERE project_id=? AND opencode_session_id=? AND transcript_hash=?`)
      .get(projectId, opencodeSessionId, transcriptHash) as any;
  }

  beginSessionIngestion(input: { projectId: string; opencodeSessionId: string; orchestratorSessionId?: string; transcriptHash: string;
    checkpointId: string; historySource: string; historyComplete: boolean; messageCount: number }) {
    const existing = this.findSessionIngestion(input.projectId, input.opencodeSessionId, input.transcriptHash);
    if (existing?.status === "completed") return { ingestionId: existing.id, alreadyCompleted: true, existing };
    const ingestionId = existing?.id || id("ing");
    const t = now();
    this.db.query(`INSERT INTO session_ingestions(id,project_id,opencode_session_id,orchestrator_session_id,transcript_hash,checkpoint_id,
      history_source,history_complete,message_count,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'processing',?)
      ON CONFLICT(project_id,opencode_session_id,transcript_hash) DO UPDATE SET
      orchestrator_session_id=excluded.orchestrator_session_id,checkpoint_id=excluded.checkpoint_id,
      history_source=excluded.history_source,history_complete=excluded.history_complete,message_count=excluded.message_count,
      status='processing',error=NULL,completed_at=NULL`)
      .run(ingestionId, input.projectId, input.opencodeSessionId, input.orchestratorSessionId ?? null, input.transcriptHash,
        input.checkpointId, input.historySource, input.historyComplete ? 1 : 0, input.messageCount, t);
    this.event(input.projectId, "SESSION_INGESTION_STARTED", { ingestionId, messageCount: input.messageCount,
      historySource: input.historySource, historyComplete: input.historyComplete }, input.orchestratorSessionId, undefined, `ingest-start:${ingestionId}`);
    return { ingestionId, alreadyCompleted: false };
  }

  completeSessionIngestion(input: { ingestionId: string; projectId: string; mainTaskId: string; taskIds: string[];
    extractionIds: string[]; report: unknown }) {
    const t = now();
    this.db.query(`UPDATE session_ingestions SET status='completed',main_task_id=?,task_ids_json=?,extraction_ids_json=?,report_json=?,completed_at=?,error=NULL
      WHERE id=? AND project_id=?`).run(input.mainTaskId, json(input.taskIds), json(input.extractionIds), json(input.report), t, input.ingestionId, input.projectId);
    this.event(input.projectId, "SESSION_INGESTION_COMPLETED", { ingestionId: input.ingestionId, mainTaskId: input.mainTaskId,
      taskCount: input.taskIds.length, extractionCount: input.extractionIds.length }, undefined, input.mainTaskId, `ingest-complete:${input.ingestionId}`);
    return { ingestionId: input.ingestionId, completedAt: t };
  }

  failSessionIngestion(ingestionId: string, projectId: string, error: string) {
    const t = now();
    this.db.query(`UPDATE session_ingestions SET status='failed',error=?,completed_at=? WHERE id=? AND project_id=?`)
      .run(String(error).slice(0, 3000), t, ingestionId, projectId);
    this.event(projectId, "SESSION_INGESTION_FAILED", { ingestionId, error: String(error).slice(0, 1000) }, undefined, undefined, `ingest-failed:${ingestionId}`);
    return { ingestionId, status: "failed", error: String(error).slice(0, 1000) };
  }

  createIngestTaskPlan(input: { projectId: string; opencodeSessionId: string; ingestionId: string;
    plan: { main_task: any; subtasks: any[] } }) {
    const session = this.db.query(`SELECT * FROM sessions WHERE project_id=? AND opencode_session_id=?`)
      .get(input.projectId, input.opencodeSessionId) as any;
    if (!session) throw new Error(`Orchestrator session record not found for ${input.opencodeSessionId}`);

    const main = input.plan?.main_task || {};
    const subtasks = Array.isArray(input.plan?.subtasks) ? input.plan.subtasks.slice(0, 25) : [];
    const normalized = subtasks.map((task: any, index: number) => ({
      ...task,
      key: String(task.key || `S${index + 1}`).trim(),
      title: String(task.title || `Subtask ${index + 1}`).trim().slice(0, 300),
      description: String(task.description || "Extracted from the current OpenCode session.").trim().slice(0, 8000),
      acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria.map((x: any) => String(x).slice(0, 1000)).slice(0, 20) : [],
      priority: Math.min(5, Math.max(1, Math.round(Number(task.priority) || 3))),
      status: new Set(["planned", "ready", "in_progress", "blocked", "completed"]).has(String(task.status)) ? String(task.status) : "planned",
      depends_on: Array.isArray(task.depends_on) ? task.depends_on.map((x: any) => String(x)) : []
    })).filter((task: any) => task.title);
    const keys = new Set(normalized.map((task: any) => task.key));
    const dependencyMap = new Map<string, string[]>();
    for (const task of normalized) {
      const dependencies: string[] = [...new Set<string>(task.depends_on as string[])];
      dependencyMap.set(task.key, dependencies.filter((key: string) => key !== task.key && keys.has(key)));
    }
    // Reject cycles defensively; the planner is instructed to emit a DAG, but the DB must enforce it.
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (key: string) => {
      if (visiting.has(key)) throw new Error(`Cyclic task dependency detected at ${key}`);
      if (visited.has(key)) return;
      visiting.add(key);
      for (const dependency of dependencyMap.get(key) || []) visit(dependency);
      visiting.delete(key); visited.add(key);
    };
    for (const key of keys) visit(key);

    const transaction = this.db.transaction(() => {
      const recordedAt = now();
      const upsertTask = (role: "main" | "subtask", title: string, description: string, acceptance: string[], priority: number,
        status: string, parentTaskId: string | null, taskKey: string): string => {
        const normalizedTitle = normalizeTaskTitle(title);
        let link: any;
        if (role === "main") {
          link = this.db.query(`SELECT l.*,t.* FROM session_task_links l JOIN tasks t ON t.id=l.task_id
            WHERE l.project_id=? AND l.opencode_session_id=? AND l.role='main' LIMIT 1`)
            .get(input.projectId, input.opencodeSessionId);
        } else {
          link = this.db.query(`SELECT l.*,t.* FROM session_task_links l JOIN tasks t ON t.id=l.task_id
            WHERE l.project_id=? AND l.opencode_session_id=? AND l.role='subtask' AND (l.task_key=? OR l.normalized_title=?)
            ORDER BY CASE WHEN l.task_key=? THEN 0 ELSE 1 END LIMIT 1`)
            .get(input.projectId, input.opencodeSessionId, taskKey, normalizedTitle, taskKey);
        }
        const taskId = link?.task_id || id("tsk");
        const statusSet = new Set(["planned", "ready", "in_progress", "blocked", "completed", "cancelled", "failed"]);
        const safeStatus = statusSet.has(status) ? status : "planned";
        const current = link ? this.db.query("SELECT * FROM tasks WHERE id=?").get(taskId) as any : null;
        const values = { title: title.slice(0, 300), description: description.slice(0, 8000), acceptance: json(acceptance),
          priority: Math.min(5, Math.max(1, Math.round(priority || 3))), status: safeStatus };
        if (!current) {
          this.db.query(`INSERT INTO tasks(id,project_id,parent_task_id,title,description,acceptance_criteria,status,priority,dependencies,assigned_session_id,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,'[]',?,?,?)`).run(taskId, input.projectId, parentTaskId, values.title, values.description,
              values.acceptance, values.status, values.priority, session.id, recordedAt, recordedAt);
        } else {
          this.db.query(`UPDATE tasks SET parent_task_id=?,title=?,description=?,acceptance_criteria=?,status=?,priority=?,assigned_session_id=?,updated_at=? WHERE id=?`)
            .run(parentTaskId, values.title, values.description, values.acceptance, values.status, values.priority, session.id, recordedAt, taskId);
        }
        const refreshed = this.db.query("SELECT * FROM tasks WHERE id=?").get(taskId) as any;
        if (!current || ["title", "description", "acceptance_criteria", "status", "priority", "parent_task_id"].some((key) =>
          String(current?.[key] ?? "") !== String(refreshed?.[key] ?? ""))) {
          const last = this.db.query("SELECT version FROM task_versions WHERE task_id=? ORDER BY version DESC LIMIT 1").get(taskId) as any;
          const version = Number(last?.version || 0) + 1;
          this.db.query(`INSERT INTO task_versions(id,project_id,task_id,version,snapshot_json,valid_from,recorded_at,reason)
            VALUES(?,?,?,?,?,?,?,?)`).run(id("tver"), input.projectId, taskId, version, json(refreshed), recordedAt, recordedAt,
              current ? "session_ingest_plan_updated" : "session_ingest_plan_created");
        }
        this.addNode(input.projectId, "task", taskId, values.title);
        if (parentTaskId) this.edge(input.projectId, "task", parentTaskId, "task", taskId, "parent_of");
        if (role === "main") this.db.query(`DELETE FROM session_task_links WHERE project_id=? AND opencode_session_id=? AND role='main'`)
          .run(input.projectId, input.opencodeSessionId);
        else if (link && link.normalized_title !== normalizedTitle) {
          this.db.query(`DELETE FROM session_task_links WHERE project_id=? AND opencode_session_id=? AND role='subtask' AND normalized_title=?`)
            .run(input.projectId, input.opencodeSessionId, link.normalized_title);
        }
        this.db.query(`INSERT INTO session_task_links(project_id,opencode_session_id,task_id,role,normalized_title,task_key,first_seen_at,last_seen_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,opencode_session_id,role,normalized_title)
          DO UPDATE SET task_id=excluded.task_id,task_key=excluded.task_key,last_seen_at=excluded.last_seen_at`)
          .run(input.projectId, input.opencodeSessionId, taskId, role, normalizedTitle, taskKey, recordedAt, recordedAt);
        return taskId;
      };

      const rootTitle = String(main.title || "Session work plan").trim().slice(0, 300);
      if (!rootTitle) throw new Error("Task planner did not return main_task.title");
      const rootId = upsertTask("main", rootTitle, String(main.description || "Main task identified from the OpenCode session."),
        Array.isArray(main.acceptance_criteria) ? main.acceptance_criteria.map(String).slice(0, 20) : [],
        Math.min(5, Math.max(1, Math.round(Number(main.priority) || 2))),
        String(main.status || "in_progress"), null, "MAIN");

      const taskIds = new Map<string, string>();
      const createdSubtasks: Array<{ key: string; taskId: string; title: string; priority: number; status: string; dependsOn: string[] }> = [];
      for (const task of normalized) {
        const taskId = upsertTask("subtask", task.title, task.description, task.acceptance_criteria,
          task.priority, task.status, rootId, task.key);
        taskIds.set(task.key, taskId);
        createdSubtasks.push({ key: task.key, taskId, title: task.title, priority: task.priority, status: task.status, dependsOn: [] });
      }
      for (const task of normalized) {
        const taskId = taskIds.get(task.key)!;
        const dependencyIds = (dependencyMap.get(task.key) || []).map((key) => taskIds.get(key)).filter((value): value is string => Boolean(value));
        this.db.query("UPDATE tasks SET dependencies=?,updated_at=? WHERE id=?").run(json(dependencyIds), recordedAt, taskId);
        this.db.query(`DELETE FROM graph_edges WHERE project_id=? AND source_node_id=? AND relation='depends_on'`).run(input.projectId, `task:${taskId}`);
        for (const dependencyId of dependencyIds) this.edge(input.projectId, "task", taskId, "task", dependencyId, "depends_on");
        const refreshedTask = this.db.query("SELECT * FROM tasks WHERE id=?").get(taskId) as any;
        const lastTaskVersion = this.db.query("SELECT version,snapshot_json FROM task_versions WHERE task_id=? ORDER BY version DESC LIMIT 1").get(taskId) as any;
        const lastTaskSnapshot = lastTaskVersion ? JSON.parse(lastTaskVersion.snapshot_json) : null;
        let lastDependencies: string[] = [];
        if (Array.isArray(lastTaskSnapshot?.dependencies)) lastDependencies = lastTaskSnapshot.dependencies;
        else if (typeof lastTaskSnapshot?.dependencies === "string") {
          try { const parsed = JSON.parse(lastTaskSnapshot.dependencies); if (Array.isArray(parsed)) lastDependencies = parsed; } catch { /* Treat malformed legacy snapshots as empty. */ }
        }
        if (!lastTaskSnapshot || JSON.stringify(lastDependencies) !== JSON.stringify(dependencyIds)) {
          const version = Number(lastTaskVersion?.version || 0) + 1;
          this.db.query(`INSERT INTO task_versions(id,project_id,task_id,version,snapshot_json,valid_from,recorded_at,reason)
            VALUES(?,?,?,?,?,?,?,?)`).run(id("tver"), input.projectId, taskId, version, json(refreshedTask), recordedAt, recordedAt, "session_ingest_dependencies_configured");
        }
        const item = createdSubtasks.find((x) => x.taskId === taskId);
        if (item) item.dependsOn = dependencyIds;
      }

      const currentSession = this.db.query("SELECT * FROM sessions WHERE id=?").get(session.id) as any;
      if (currentSession.task_id !== rootId || currentSession.status === "created") {
        const updatedSession = { ...currentSession, task_id: rootId, status: currentSession.status === "created" ? "in_progress" : currentSession.status,
          started_at: currentSession.started_at || recordedAt, updated_at: recordedAt };
        this.db.query("UPDATE sessions SET task_id=?,status=?,started_at=?,updated_at=? WHERE id=?")
          .run(updatedSession.task_id, updatedSession.status, updatedSession.started_at, updatedSession.updated_at, session.id);
        const lastVersion = this.db.query("SELECT version FROM session_versions WHERE session_id=? ORDER BY version DESC LIMIT 1").get(session.id) as any;
        const version = Number(lastVersion?.version || 0) + 1;
        this.db.query(`INSERT INTO session_versions(id,project_id,session_id,version,snapshot_json,valid_from,recorded_at,reason)
          VALUES(?,?,?,?,?,?,?,?)`).run(id("sver"), input.projectId, session.id, version, json(updatedSession), recordedAt, recordedAt, "session_ingested_and_linked_to_main_task");
      }
      this.edge(input.projectId, "session", session.id, "task", rootId, "ingested_as_main_task");

      // Attach extracted memories and their downstream decisions/claims to the main task.
      this.db.query(`UPDATE memory_entries SET task_id=? WHERE project_id=? AND session_id=? AND task_id IS NULL`)
        .run(rootId, input.projectId, session.id);
      this.db.query(`UPDATE intelligence_extractions SET source_task_id=? WHERE project_id=? AND source_session_id IN (?,?) AND source_task_id IS NULL`)
        .run(rootId, input.projectId, session.id, input.opencodeSessionId);
      const memories = this.db.query("SELECT id FROM memory_entries WHERE project_id=? AND session_id=?").all(input.projectId, session.id) as any[];
      for (const memory of memories) {
        this.edge(input.projectId, "memory", memory.id, "task", rootId, "supports_task");
        const decisions = this.db.query("SELECT id FROM knowledge_decisions WHERE project_id=? AND source_memory_id=?").all(input.projectId, memory.id) as any[];
        for (const decision of decisions) this.edge(input.projectId, "knowledge_decision", decision.id, "task", rootId, "informs_task");
      }
      this.event(input.projectId, "SESSION_TASK_PLAN_CREATED", { ingestionId: input.ingestionId, rootTaskId: rootId,
        subtaskIds: createdSubtasks.map((task) => task.taskId) }, session.id, rootId, `session-task-plan:${input.ingestionId}`);
      return { mainTaskId: rootId, mainTaskTitle: rootTitle, subtasks: createdSubtasks,
        taskIds: [rootId, ...createdSubtasks.map((task) => task.taskId)], sessionId: session.id };
    });
    return transaction();
  }

  findSession(projectId: string, opencodeSessionId: string) {
    return this.db.query(`SELECT * FROM sessions WHERE project_id=? AND opencode_session_id=? LIMIT 1`)
      .get(projectId, opencodeSessionId) as any;
  }

  listTasksForSession(projectId: string, opencodeSessionId: string) {
    return this.db.query(`SELECT t.id,t.title,t.description,t.status,t.priority,l.role
      FROM session_task_links l JOIN tasks t ON t.id=l.task_id
      WHERE l.project_id=? AND l.opencode_session_id=? ORDER BY l.role,t.priority,t.created_at`)
      .all(projectId, opencodeSessionId) as any[];
  }

  getTask(projectId: string, taskId: string) {
    return this.db.query("SELECT * FROM tasks WHERE project_id=? AND id=?").get(projectId, taskId) as any;
  }

  countTasks(projectId: string) {
    return Number((this.db.query("SELECT COUNT(*) AS count FROM tasks WHERE project_id=?").get(projectId) as any)?.count || 0);
  }

  countGraphEdges(projectId: string, relation?: string) {
    const row = relation
      ? this.db.query("SELECT COUNT(*) AS count FROM graph_edges WHERE project_id=? AND relation=?").get(projectId, relation)
      : this.db.query("SELECT COUNT(*) AS count FROM graph_edges WHERE project_id=?").get(projectId);
    return Number((row as any)?.count || 0);
  }

  listSessionCheckpoints(opencodeSessionId: string) {
    return this.db.query(`SELECT transcript_json,created_at FROM checkpoints
      WHERE session_id=? AND transcript_json IS NOT NULL ORDER BY created_at ASC`)
      .all(opencodeSessionId) as any[];
  }

  embeddingStatus(projectId: string) {
    const counts = this.db.query(`SELECT
      (SELECT COUNT(*) FROM memory_chunks c JOIN memory_entries m ON m.id=c.memory_id WHERE m.project_id=?) AS chunks,
      (SELECT COUNT(*) FROM vector_index vi JOIN memory_chunks c ON c.id=vi.chunk_id JOIN memory_entries m ON m.id=c.memory_id WHERE m.project_id=? AND vi.model_name=?) AS indexed`)
      .get(projectId, projectId, this.embeddingModel) as any;
    return this.checkEmbeddingConnection().then((connection) => ({ provider: this.embeddingProvider, model: this.embeddingModel,
      promptProfile: this.embeddingPromptProfile, baseUrl: this.embeddingBaseUrl,
      apiKeyEnv: this.embeddingProvider === "ollama" ? null : this.embeddingApiKeyEnv,
      apiKeyAvailable: this.embeddingProvider === "ollama" || this.embeddingApiKeyConfigured,
      apiKeySource: this.embeddingProvider === "ollama" ? "not_required" : this.embeddingApiKeySource,
      connection, sqliteVecAvailable: this.vectorAvailable, sqliteVecError: this.vectorError, deduplication: { enabled: this.deduplicationEnabled, similarityThreshold: this.deduplicationSimilarityThreshold }, privacy: this.privacyOptions, ...counts }));
  }

  buildContextPack(projectId: string, opencodeSessionId: string) {
    const session = this.findSession(projectId, opencodeSessionId);
    const latest = this.db.query(`SELECT kind,title,content,id FROM memory_entries
      WHERE project_id=? AND status IN ('active','confirmed')
      AND (session_id=? OR task_id=? OR (session_id IS NULL AND task_id IS NULL))
      ORDER BY CASE WHEN session_id=? THEN 0 WHEN task_id=? THEN 1 ELSE 2 END,
               importance DESC, updated_at DESC LIMIT 8`)
      .all(projectId, session?.id ?? "__none__", session?.task_id ?? "__none__", session?.id ?? "__none__", session?.task_id ?? "__none__") as any[];
    const decisions = this.db.query(`SELECT id,title,decision,confidence,decided_at FROM knowledge_decisions
      WHERE project_id=? AND status='active' ORDER BY decided_at DESC LIMIT 4`).all(projectId) as any[];
    const claims = this.db.query(`SELECT c.id,e.canonical_name AS subject,c.predicate,c.object_value,c.confidence,c.evidence
      FROM knowledge_claims c JOIN intelligence_entities e ON e.id=c.subject_entity_id
      WHERE c.project_id=? AND c.status='active' AND c.valid_to IS NULL ORDER BY c.confidence DESC,c.created_at DESC LIMIT 5`).all(projectId) as any[];
    return { session, latest, decisions, claims };
  }

  checkpoint(input: { projectId: string; sessionId?: string; taskId?: string; transcript?: unknown; summary?: string; type?: string }) {
    input = { ...input, transcript: sanitizeSensitiveValue(input.transcript, this.privacyOptions), summary: input.summary ? sanitizeSensitiveText(input.summary, this.privacyOptions) : input.summary };
    const checkpointId = id("chk"), t = now();
    this.db.query(`INSERT INTO checkpoints(id,project_id,session_id,task_id,checkpoint_type,transcript_json,summary,created_at,verified)
      VALUES(?,?,?,?,?,?,?,?,0)`).run(checkpointId, input.projectId, input.sessionId ?? null, input.taskId ?? null,
        input.type ?? "pre_compaction", json(input.transcript), input.summary ?? null, t);
    this.event(input.projectId, "MEMORY_CHECKPOINT_CREATED", { checkpointId, type: input.type }, input.sessionId, input.taskId);
    return { checkpointId, saved: true };
  }

  getSessionAutoSaveState(projectId: string, opencodeSessionId: string) {
    return this.db.query(`SELECT * FROM session_auto_save_state WHERE project_id=? AND opencode_session_id=?`)
      .get(projectId, opencodeSessionId) as any || null;
  }

  beginSessionAutoSaveRun(input: { projectId: string; opencodeSessionId: string; transcriptHash: string; totalTokens: number; tokenSource: string; messageCount: number; lastMessageId?: string | null }) {
    const runId = id("asrun"), t = now();
    this.db.query(`INSERT OR IGNORE INTO session_auto_save_runs(id,project_id,opencode_session_id,transcript_hash,total_tokens,token_source,message_count,last_message_id,status,created_at)
      VALUES(?,?,?,?,?,?,?,?, 'pending',?)`).run(runId, input.projectId, input.opencodeSessionId, input.transcriptHash,
        Math.max(0, Math.floor(input.totalTokens)), input.tokenSource, Math.max(0, Math.floor(input.messageCount)), input.lastMessageId || null, t);
    const run = this.db.query(`SELECT * FROM session_auto_save_runs WHERE project_id=? AND opencode_session_id=? AND transcript_hash=?`)
      .get(input.projectId, input.opencodeSessionId, input.transcriptHash) as any;
    return { run, alreadyCompleted: run?.status === "completed" };
  }

  setSessionAutoSaveCheckpoint(runId: string, checkpointId: string) {
    this.db.query(`UPDATE session_auto_save_runs SET checkpoint_id=COALESCE(checkpoint_id,?) WHERE id=?`).run(checkpointId, runId);
    return this.db.query(`SELECT checkpoint_id FROM session_auto_save_runs WHERE id=?`).get(runId) as any;
  }

  completeSessionAutoSaveRun(input: { runId: string; projectId: string; opencodeSessionId: string; transcriptHash: string; totalTokens: number; tokenSource: string; messageCount: number; lastMessageId?: string | null; checkpointId: string; result: unknown }) {
    const t = now();
    const tx = this.db.transaction(() => {
      this.db.query(`UPDATE session_auto_save_runs SET status='completed',checkpoint_id=?,result_json=?,error=NULL,completed_at=? WHERE id=?`)
        .run(input.checkpointId, json(input.result), t, input.runId);
      this.db.query(`INSERT INTO session_auto_save_state(project_id,opencode_session_id,last_saved_tokens,token_source,last_message_id,last_message_count,last_transcript_hash,last_checkpoint_id,last_saved_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id,opencode_session_id) DO UPDATE SET
          last_saved_tokens=excluded.last_saved_tokens,token_source=excluded.token_source,last_message_id=excluded.last_message_id,
          last_message_count=excluded.last_message_count,last_transcript_hash=excluded.last_transcript_hash,
          last_checkpoint_id=excluded.last_checkpoint_id,last_saved_at=excluded.last_saved_at,updated_at=excluded.updated_at`)
        .run(input.projectId, input.opencodeSessionId, Math.max(0, Math.floor(input.totalTokens)), input.tokenSource,
          input.lastMessageId || null, Math.max(0, Math.floor(input.messageCount)), input.transcriptHash, input.checkpointId, t, t);
    });
    tx();
    return { completed: true, savedAt: t, totalTokens: Math.floor(input.totalTokens), checkpointId: input.checkpointId };
  }

  failSessionAutoSaveRun(runId: string, error: string) {
    this.db.query(`UPDATE session_auto_save_runs SET status='failed',error=?,completed_at=? WHERE id=? AND status!='completed'`)
      .run(String(error).slice(0, 2000), now(), runId);
    return { failed: true, runId, error: String(error).slice(0, 1000) };
  }

  sessionAutoSaveStatus(projectId: string) {
    const state = this.db.query(`SELECT opencode_session_id,last_saved_tokens,token_source,last_message_count,last_saved_at,last_checkpoint_id
      FROM session_auto_save_state WHERE project_id=? ORDER BY updated_at DESC LIMIT 20`).all(projectId) as any[];
    const totals = this.db.query(`SELECT COUNT(*) AS total,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM session_auto_save_runs WHERE project_id=?`).get(projectId) as any;
    return { sessions: state, runs: { total: Number(totals?.total || 0), completed: Number(totals?.completed || 0), failed: Number(totals?.failed || 0) } };
  }

  async writeMemoryDeduplicated(input: { projectId: string; sessionId?: string; taskId?: string; kind: string; title: string; content: string; source?: string; sourceRef?: string; importance?: number; confidence?: number; status?: string; tags?: string[]; concepts?: string[] }) {
    const safe = {
      ...input,
      kind: sanitizeSensitiveText(input.kind, this.privacyOptions).slice(0, 80),
      title: sanitizeSensitiveText(input.title, this.privacyOptions).slice(0, 300),
      content: sanitizeSensitiveText(input.content, this.privacyOptions),
      tags: (input.tags || []).map((tag) => sanitizeSensitiveText(tag, this.privacyOptions).slice(0, 100)).filter(Boolean),
      concepts: (input.concepts || []).map((concept) => sanitizeSensitiveText(concept, this.privacyOptions).slice(0, 200)).filter(Boolean),
    };
    const recordEvidence = (memoryId: string) => {
      const evidenceKey = createHash("sha256").update(JSON.stringify([
        safe.projectId, memoryId, safe.sessionId || null, safe.taskId || null,
        safe.source || "memory_intelligence", safe.sourceRef || "",
      ])).digest("hex");
      this.db.query(`INSERT OR IGNORE INTO memory_entry_evidence(
        id,memory_id,project_id,session_id,task_id,source,source_ref,evidence_key,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(id("mev"), memoryId, safe.projectId, safe.sessionId || null,
        safe.taskId || null, safe.source || "memory_intelligence", safe.sourceRef || null, evidenceKey, now());
      if (safe.sessionId) this.edge(safe.projectId, "session", safe.sessionId, "memory", memoryId, "reaffirmed");
      if (safe.taskId) this.edge(safe.projectId, "task", safe.taskId, "memory", memoryId, "reaffirmed");
    };

    const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
    const normalizedTitle = normalize(safe.title);
    const normalizedContent = normalize(safe.content);
    const exactCandidates = this.db.query(`SELECT id,title,content,kind FROM memory_entries
      WHERE project_id=? AND kind=? AND status IN ('active','confirmed') ORDER BY updated_at DESC LIMIT 250`)
      .all(safe.projectId, safe.kind) as any[];
    const exact = exactCandidates.find((row: any) => normalize(String(row.title)) === normalizedTitle && normalize(String(row.content)) === normalizedContent);
    if (exact) {
      recordEvidence(exact.id);
      this.event(safe.projectId, "MEMORY_DUPLICATE_REUSED", { memoryId: exact.id, kind: safe.kind, match: "normalized_exact" }, safe.sessionId, safe.taskId,
        `memory-dedup:${safe.projectId}:${exact.id}:${safe.sourceRef || ""}`);
      return { memoryId: exact.id, duplicate: true, duplicateMatch: "normalized_exact", vectorIndex: { indexed: 0, enabled: this.vectorAvailable } };
    }

    // Semantic dedup is conservative: compare only records of the same kind and require
    // an actual vector similarity score. FTS/graph matches alone never suppress a write.
    if (this.deduplicationEnabled && this.vectorAvailable && normalizedContent.length >= 80) {
      try {
        const candidates = await this.semanticSearch({ projectId: safe.projectId, query: `${safe.title}\n${safe.content}`.slice(0, 8000), limit: 12, vectorCandidates: 36 });
        const near = candidates.results.find((row: any) => row.kind === safe.kind &&
          Number.isFinite(Number(row.semanticSimilarity)) && Number(row.semanticSimilarity) >= this.deduplicationSimilarityThreshold);
        if (near) {
          recordEvidence(near.id);
          this.db.query(`UPDATE memory_entries SET importance=MAX(importance,?),confidence=MAX(confidence,?),updated_at=? WHERE id=? AND project_id=?`)
            .run(safe.importance ?? 3, safe.confidence ?? 1, now(), near.id, safe.projectId);
          this.event(safe.projectId, "MEMORY_DUPLICATE_REUSED", {
            memoryId: near.id, kind: safe.kind, match: "semantic", similarity: Number(near.semanticSimilarity),
            threshold: this.deduplicationSimilarityThreshold,
          }, safe.sessionId, safe.taskId, `memory-dedup:${safe.projectId}:${near.id}:${safe.sourceRef || ""}`);
          return { memoryId: near.id, duplicate: true, duplicateMatch: "semantic", similarity: Number(near.semanticSimilarity),
            vectorIndex: { indexed: 0, enabled: this.vectorAvailable } };
        }
      } catch (error) {
        this.event(safe.projectId, "MEMORY_SEMANTIC_DEDUP_FALLBACK", { error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }, safe.sessionId, safe.taskId);
      }
    }

    const result = await this.writeMemory(safe);
    recordEvidence(result.memoryId);
    return { ...result, duplicate: false, duplicateMatch: null };
  }

  listMemories(projectId: string, options: { kind?: string; status?: string; query?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 20), 1), 100);
    const status = options.status || "active";
    const query = options.query?.trim();
    const rows = this.db.query(`SELECT id,kind,title,content,importance,confidence,status,tags,source,session_id,task_id,created_at,updated_at
      FROM memory_entries WHERE project_id=? AND status=?
      AND (? IS NULL OR kind=?)
      AND (? IS NULL OR title LIKE ? OR content LIKE ? OR tags LIKE ?)
      ORDER BY importance DESC,updated_at DESC LIMIT ?`)
      .all(projectId, status, options.kind || null, options.kind || null, query || null,
        query ? `%${query}%` : null, query ? `%${query}%` : null, query ? `%${query}%` : null, limit) as any[];
    return rows.map((row) => ({ ...row, content: String(row.content).slice(0, 1800), tags: JSON.parse(row.tags || "[]") }));
  }

  forgetMemory(projectId: string, memoryId: string, reason = "forgotten_by_user") {
    const row = this.db.query("SELECT * FROM memory_entries WHERE project_id=? AND id=?").get(projectId, memoryId) as any;
    if (!row) return { forgotten: false, reason: "not_found", memoryId };
    if (row.status === "forgotten") return { forgotten: true, alreadyForgotten: true, memoryId };
    const t = now();
    const tx = this.db.transaction(() => {
      const snapshot = { ...row, status: "forgotten", updated_at: t };
      const nextVersion = Number((this.db.query("SELECT MAX(version) AS version FROM memory_versions WHERE memory_id=?").get(memoryId) as any)?.version || 0) + 1;
      this.db.query("UPDATE memory_entries SET status='forgotten',updated_at=? WHERE id=? AND project_id=?").run(t, memoryId, projectId);
      this.db.query("INSERT INTO memory_versions(id,memory_id,version,snapshot_json,reason,created_at) VALUES(?,?,?,?,?,?)")
        .run(id("ver"), memoryId, nextVersion, json(snapshot), reason.slice(0, 300), t);
      if (this.ftsAvailable) {
        this.db.query("DELETE FROM memory_fts WHERE memory_id=?").run(memoryId);
        this.db.query("DELETE FROM chunk_fts WHERE memory_id=?").run(memoryId);
      }
      const vectors = this.db.query(`SELECT vi.table_name,vi.vector_rowid FROM vector_index vi JOIN memory_chunks c ON c.id=vi.chunk_id WHERE c.memory_id=?`).all(memoryId) as any[];
      for (const vector of vectors) {
        if (/^vec_[a-z0-9_]+$/i.test(String(vector.table_name))) {
          try { this.db.query(`DELETE FROM ${vector.table_name} WHERE rowid=?`).run(vector.vector_rowid); } catch {}
        }
      }
      this.db.query("DELETE FROM vector_index WHERE chunk_id IN (SELECT id FROM memory_chunks WHERE memory_id=?)").run(memoryId);
    });
    tx();
    this.event(projectId, "MEMORY_FORGOTTEN", { memoryId, reason: sanitizeSensitiveText(reason, this.privacyOptions).slice(0, 300) });
    return { forgotten: true, memoryId, mode: "soft_delete", note: "Content remains in SQLite for recovery/audit; embeddings and search entries are removed." };
  }

  restoreMemory(projectId: string, memoryId: string) {
    const row = this.db.query("SELECT * FROM memory_entries WHERE project_id=? AND id=?").get(projectId, memoryId) as any;
    if (!row) return { restored: false, reason: "not_found", memoryId };
    if (row.status !== "forgotten") return { restored: false, reason: "not_forgotten", memoryId, status: row.status };
    const t = now();
    const tx = this.db.transaction(() => {
      const snapshot = { ...row, status: "active", updated_at: t };
      const nextVersion = Number((this.db.query("SELECT MAX(version) AS version FROM memory_versions WHERE memory_id=?").get(memoryId) as any)?.version || 0) + 1;
      this.db.query("UPDATE memory_entries SET status='active',updated_at=? WHERE id=? AND project_id=?").run(t, memoryId, projectId);
      this.db.query("INSERT INTO memory_versions(id,memory_id,version,snapshot_json,reason,created_at) VALUES(?,?,?,?,?,?)")
        .run(id("ver"), memoryId, nextVersion, json(snapshot), "restored_by_user", t);
      if (this.ftsAvailable) {
        this.db.query("INSERT INTO memory_fts(memory_id,title,content,tags) VALUES(?,?,?,?)")
          .run(memoryId, row.title, row.content, (() => { try { return JSON.parse(String(row.tags || "[]")).join(" "); } catch { return ""; } })());
        const chunks = this.db.query("SELECT id,content FROM memory_chunks WHERE memory_id=? ORDER BY chunk_index").all(memoryId) as any[];
        for (const chunk of chunks) this.db.query("INSERT INTO chunk_fts(chunk_id,memory_id,content) VALUES(?,?,?)")
          .run(chunk.id, memoryId, chunk.content);
      }
    });
    tx();
    this.event(projectId, "MEMORY_RESTORED", { memoryId });
    return { restored: true, memoryId, note: "Search text restored. Run memory_vector_reindex to regenerate vector embeddings." };
  }

  report(projectId: string) {
    const project = this.db.query("SELECT * FROM projects WHERE id=?").get(projectId);
    const tasks = this.db.query("SELECT status,COUNT(*) AS count FROM tasks WHERE project_id=? GROUP BY status").all(projectId);
    const sessions = this.db.query("SELECT status,COUNT(*) AS count FROM sessions WHERE project_id=? GROUP BY status").all(projectId);
    const memoryCount = this.db.query("SELECT COUNT(*) AS count FROM memory_entries WHERE project_id=?").get(projectId) as any;
    const recent = this.db.query("SELECT id,event_type,payload,created_at FROM events WHERE project_id=? ORDER BY created_at DESC LIMIT 20").all(projectId);
    const intelligence = this.db.query(`SELECT
      (SELECT COUNT(*) FROM intelligence_entities WHERE project_id=?) AS entities,
      (SELECT COUNT(*) FROM knowledge_claims WHERE project_id=?) AS claims,
      (SELECT COUNT(*) FROM knowledge_decisions WHERE project_id=?) AS decisions,
      (SELECT COUNT(*) FROM knowledge_conflicts WHERE project_id=? AND status='open') AS open_conflicts,
      (SELECT COUNT(*) FROM intelligence_extractions WHERE project_id=? AND status='completed') AS completed_extractions`)
      .get(projectId, projectId, projectId, projectId, projectId) as any;
    return { project, tasks, sessions, memoryCount: memoryCount?.count ?? 0, intelligence, recent };
  }

  consolidate(projectId: string) {
    // Non-destructive: mark old active duplicates as review candidates; never delete source rows.
    const duplicates = this.db.query(`SELECT lower(trim(title)) AS key, COUNT(*) AS n
      FROM memory_entries WHERE project_id=? AND status='active'
      GROUP BY lower(trim(title)) HAVING COUNT(*)>1`).all(projectId);
    const snapshot = this.report(projectId);
    this.event(projectId, "MEMORY_CONSOLIDATION_COMPLETED", { duplicateTitleGroups: duplicates.length });
    return { duplicateTitleGroups: duplicates.length, report: snapshot, policy: "non_destructive" };
  }

  lockFile(projectId: string, filePath: string, ownerSessionId: string, purpose?: string, ttlMinutes = 60) {
    const expires = new Date(Date.now() + Math.max(1, ttlMinutes) * 60_000).toISOString();
    const t = now();
    try {
      this.db.query(`INSERT INTO file_locks(id,project_id,file_path,owner_session_id,purpose,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(id("lock"), projectId, filePath, ownerSessionId, purpose ?? null, expires, t);
      return { locked: true, filePath, ownerSessionId, expiresAt: expires };
    } catch {
      const current = this.db.query("SELECT * FROM file_locks WHERE project_id=? AND file_path=?").get(projectId, filePath) as any;
      if (current?.expires_at && current.expires_at < t) {
        this.db.query("DELETE FROM file_locks WHERE id=?").run(current.id);
        return this.lockFile(projectId, filePath, ownerSessionId, purpose, ttlMinutes);
      }
      return { locked: false, currentOwner: current?.owner_session_id, expiresAt: current?.expires_at };
    }
  }


  createBackup(projectId: string) {
    const file = join(this.root, "backups", `orchestrator-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
    // VACUUM INTO requires a SQL string literal; escape single quotes in the generated path.
    const escaped = file.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    this.event(projectId, "DATABASE_BACKUP_CREATED", { file });
    return { backupPath: file, created: true };
  }

  exportMemory(projectId: string) {
    const project = this.db.query("SELECT * FROM projects WHERE id=?").get(projectId) as any;
    const tasks = this.db.query("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at").all(projectId) as any[];
    const sessions = this.db.query("SELECT * FROM sessions WHERE project_id=? ORDER BY created_at").all(projectId) as any[];
    const memories = this.db.query("SELECT * FROM memory_entries WHERE project_id=? ORDER BY created_at").all(projectId) as any[];
    const decisions = this.db.query("SELECT * FROM knowledge_decisions WHERE project_id=? ORDER BY decided_at").all(projectId) as any[];
    const entities = this.db.query("SELECT * FROM intelligence_entities WHERE project_id=? ORDER BY canonical_name").all(projectId) as any[];
    const claims = this.db.query(`SELECT c.*,e.canonical_name AS subject FROM knowledge_claims c
      JOIN intelligence_entities e ON e.id=c.subject_entity_id WHERE c.project_id=? ORDER BY c.valid_from`).all(projectId) as any[];
    const conflicts = this.db.query("SELECT * FROM knowledge_conflicts WHERE project_id=? ORDER BY detected_at").all(projectId) as any[];
    const legacyDecisions = memories.filter(m => ["decision", "architecture"].includes(m.kind));
    const lines = [
      `# ${project?.name || "Project"} — consolidated memory`,
      "",
      `Generated: ${now()}`,
      "",
      "## Project goal",
      project?.goal || "Not specified",
      "",
      "## Tasks",
      ...tasks.map(t => `- [${t.status}] ${t.title} (${t.id})\n  ${t.description}`),
      "",
      "## Sessions",
      ...sessions.map(x => `- [${x.status}] ${x.title} — OpenCode: ${x.opencode_session_id || "not linked"}; task: ${x.task_id || "none"}`),
      "",
      "## Decisions and architecture",
      ...legacyDecisions.map(m => `### ${m.title}\n\n${m.content}\n\nSource: ${m.id}; session: ${m.session_id || "n/a"}; task: ${m.task_id || "n/a"}`),
      "",
      "## Intelligence decisions",
      ...decisions.map(d => `### ${d.title}\n\n${d.decision}\n\n- ID: ${d.id}; status: ${d.status}; confidence: ${d.confidence}; valid from: ${d.decided_at}; evidence: ${d.evidence || "n/a"}`),
      "",
      "## Entities",
      ...entities.map(e => `- ${e.canonical_name} (${e.entity_type}; confidence ${e.confidence})${e.description ? ` — ${e.description}` : ""}; aliases: ${e.aliases_json}`),
      "",
      "## Time-aware claims",
      ...claims.map(c => `- ${c.subject} — ${c.predicate}: ${c.object_value} [${c.status}; confidence ${c.confidence}; valid ${c.valid_from} .. ${c.valid_to || "open"}; source memory ${c.source_memory_id || "n/a"}; evidence: ${c.evidence || "n/a"}]`),
      "",
      "## Contradictions",
      ...conflicts.map(c => `- ${c.id}: ${c.left_claim_id} <> ${c.right_claim_id}; ${c.conflict_type}; ${c.severity}; ${c.status}; resolution: ${c.resolution || "unresolved"}`),
      "",
      "## Full memory register",
      ...memories.map(m => `### [${m.kind}] ${m.title}\n\n${m.content}\n\n- ID: ${m.id}\n- Status: ${m.status}\n- Importance: ${m.importance}\n- Source: ${m.source || "n/a"}`),
      ""
    ].join("\n");
    const file = join(this.root, "exports", "FINAL_PROJECT_MEMORY.md");
    Bun.write(file, lines);
    this.event(projectId, "PROJECT_MEMORY_EXPORTED", { file, memoryCount: memories.length, entities: entities.length, claims: claims.length, decisions: decisions.length, conflicts: conflicts.length });
    return { exportPath: file, memoryCount: memories.length, entities: entities.length, claims: claims.length, decisions: decisions.length, conflicts: conflicts.length };
  }

  close() { this.db.close(); }
}

export { MemoryStore as OrchestratorStore };
