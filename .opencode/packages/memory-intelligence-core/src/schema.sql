PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
  goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  parent_task_id TEXT REFERENCES tasks(id), title TEXT NOT NULL, description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'planned',
  priority INTEGER NOT NULL DEFAULT 3, dependencies TEXT NOT NULL DEFAULT '[]',
  assigned_session_id TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  opencode_session_id TEXT UNIQUE, parent_session_id TEXT REFERENCES sessions(id),
  task_id TEXT REFERENCES tasks(id), title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
  worktree_path TEXT, started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id), task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  source TEXT, source_ref TEXT, importance INTEGER NOT NULL DEFAULT 3,
  confidence REAL NOT NULL DEFAULT 1.0, status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  supersedes_id TEXT REFERENCES memory_entries(id), embedding_ref TEXT
);

CREATE TABLE IF NOT EXISTS memory_entry_evidence (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_entries(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT,
  task_id TEXT,
  source TEXT,
  source_ref TEXT,
  evidence_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_entry_evidence_memory ON memory_entry_evidence(memory_id,created_at DESC);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memory_entries(id),
  chunk_index INTEGER NOT NULL, content TEXT NOT NULL, token_estimate INTEGER NOT NULL DEFAULT 0,
  embedding_ref TEXT, created_at TEXT NOT NULL, UNIQUE(memory_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memory_entries(id),
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, reason TEXT,
  created_at TEXT NOT NULL, UNIQUE(memory_id, version)
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  node_type TEXT NOT NULL, entity_id TEXT NOT NULL, label TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  UNIQUE(project_id, node_type, entity_id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  source_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
  target_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
  relation TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0,
  provenance TEXT, created_at TEXT NOT NULL,
  UNIQUE(source_node_id, target_node_id, relation)
);

CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, normalized_name TEXT NOT NULL, description TEXT,
  embedding_ref TEXT, created_at TEXT NOT NULL,
  UNIQUE(project_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS memory_concepts (
  memory_id TEXT NOT NULL REFERENCES memory_entries(id),
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY(memory_id, concept_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
  session_id TEXT, task_id TEXT, event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT, task_id TEXT, checkpoint_type TEXT NOT NULL,
  transcript_json TEXT, summary TEXT, git_commit TEXT, file_manifest TEXT,
  created_at TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_locks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  file_path TEXT NOT NULL, owner_session_id TEXT NOT NULL,
  purpose TEXT, expires_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(project_id, file_path)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT, session_id TEXT, path TEXT NOT NULL, artifact_type TEXT,
  checksum TEXT, description TEXT, created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_project_kind ON memory_entries(project_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_entries(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_node_id, relation);
CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_node_id, relation);
CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);


-- Vector index registry. Actual float vectors live in sqlite-vec vec0 virtual
-- tables, one table per embedding model + dimension.
CREATE TABLE IF NOT EXISTS vector_index (
  vector_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE REFERENCES memory_chunks(id),
  table_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vector_index_model ON vector_index(model_name, dimensions);
CREATE INDEX IF NOT EXISTS idx_vector_index_table ON vector_index(table_name, vector_rowid);



-- Memory Intelligence Layer: normalized entities, time-aware claims, decisions,
-- contradiction records and idempotent extraction jobs. Original memory/events stay immutable.
CREATE TABLE IF NOT EXISTS intelligence_entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'unknown',
  description TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(project_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS knowledge_entity_evidence (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES intelligence_entities(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  extraction_id TEXT NOT NULL REFERENCES intelligence_extractions(id),
  source_session_id TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(entity_id, extraction_id)
);

CREATE TABLE IF NOT EXISTS knowledge_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_entity_id TEXT NOT NULL REFERENCES intelligence_entities(id),
  predicate TEXT NOT NULL,
  object_value TEXT NOT NULL,
  normalized_object TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'fact',
  confidence REAL NOT NULL DEFAULT 0.5,
  confidence_method TEXT NOT NULL DEFAULT 'llm_estimate',
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  asserted_at TEXT NOT NULL,
  source_memory_id TEXT REFERENCES memory_entries(id),
  source_session_id TEXT,
  source_extraction_id TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_project_subject ON knowledge_claims(project_id, subject_entity_id, predicate, valid_from);
CREATE INDEX IF NOT EXISTS idx_claims_validity ON knowledge_claims(project_id, valid_from, valid_to, status);

CREATE TABLE IF NOT EXISTS knowledge_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  decided_at TEXT NOT NULL,
  valid_to TEXT,
  source_memory_id TEXT REFERENCES memory_entries(id),
  source_session_id TEXT,
  source_extraction_id TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_project_time ON knowledge_decisions(project_id, decided_at, valid_to, status);

CREATE TABLE IF NOT EXISTS knowledge_conflicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  left_claim_id TEXT NOT NULL REFERENCES knowledge_claims(id),
  right_claim_id TEXT NOT NULL REFERENCES knowledge_claims(id),
  conflict_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  accepted_claim_id TEXT REFERENCES knowledge_claims(id),
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(left_claim_id, right_claim_id)
);
CREATE INDEX IF NOT EXISTS idx_conflicts_project_status ON knowledge_conflicts(project_id, status, detected_at);

CREATE TABLE IF NOT EXISTS intelligence_extractions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_hash TEXT NOT NULL,
  source_session_id TEXT,
  source_task_id TEXT,
  model_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_extractions_project_time ON intelligence_extractions(project_id, created_at DESC);

-- Bitemporal state snapshots for mutable project/task metadata.
CREATE TABLE IF NOT EXISTS project_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reason TEXT,
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_project_versions_time ON project_versions(project_id, valid_from, recorded_at);

CREATE TABLE IF NOT EXISTS task_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reason TEXT,
  UNIQUE(task_id, version)
);
CREATE INDEX IF NOT EXISTS idx_task_versions_time ON task_versions(project_id, task_id, valid_from, recorded_at);

CREATE TABLE IF NOT EXISTS intelligence_consolidation_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  candidate_type TEXT NOT NULL,
  signature TEXT NOT NULL,
  canonical_record_id TEXT NOT NULL,
  duplicate_record_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE(project_id, candidate_type, signature)
);
CREATE INDEX IF NOT EXISTS idx_consolidation_project_status ON intelligence_consolidation_candidates(project_id, status, created_at);

CREATE TABLE IF NOT EXISTS session_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reason TEXT,
  UNIQUE(session_id, version)
);
CREATE INDEX IF NOT EXISTS idx_session_versions_time ON session_versions(project_id, session_id, valid_from, recorded_at);

CREATE TABLE IF NOT EXISTS claim_status_history (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES knowledge_claims(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reason TEXT,
  UNIQUE(claim_id, status, recorded_at)
);
CREATE INDEX IF NOT EXISTS idx_claim_status_history_time ON claim_status_history(claim_id, recorded_at);

-- Idempotent ingestion runs for an already-open OpenCode session.
CREATE TABLE IF NOT EXISTS session_ingestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  opencode_session_id TEXT NOT NULL,
  orchestrator_session_id TEXT REFERENCES sessions(id),
  transcript_hash TEXT NOT NULL,
  checkpoint_id TEXT REFERENCES checkpoints(id),
  history_source TEXT NOT NULL,
  history_complete INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  main_task_id TEXT REFERENCES tasks(id),
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  extraction_ids_json TEXT NOT NULL DEFAULT '[]',
  report_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, opencode_session_id, transcript_hash)
);
CREATE INDEX IF NOT EXISTS idx_session_ingestions_session ON session_ingestions(project_id, opencode_session_id, created_at DESC);

-- Stable mapping prevents duplicate tasks when a long-running session is ingested again
-- after receiving additional messages. Tasks are matched by normalized title within a session.
CREATE TABLE IF NOT EXISTS session_task_links (
  project_id TEXT NOT NULL REFERENCES projects(id),
  opencode_session_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL DEFAULT 'subtask',
  normalized_title TEXT NOT NULL,
  task_key TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(project_id, opencode_session_id, role, normalized_title)
);
CREATE INDEX IF NOT EXISTS idx_session_task_links_task ON session_task_links(task_id);

-- Token-threshold session auto-save. A run is unique per full transcript hash;
-- successful runs advance one session cursor, while failed runs remain retryable.
CREATE TABLE IF NOT EXISTS session_auto_save_state (
  project_id TEXT NOT NULL REFERENCES projects(id),
  opencode_session_id TEXT NOT NULL,
  last_saved_tokens INTEGER NOT NULL DEFAULT 0,
  token_source TEXT NOT NULL DEFAULT 'unknown',
  last_message_id TEXT,
  last_message_count INTEGER NOT NULL DEFAULT 0,
  last_transcript_hash TEXT,
  last_checkpoint_id TEXT,
  last_saved_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, opencode_session_id)
);
CREATE TABLE IF NOT EXISTS session_auto_save_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  opencode_session_id TEXT NOT NULL,
  transcript_hash TEXT NOT NULL,
  total_tokens INTEGER NOT NULL,
  token_source TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  last_message_id TEXT,
  checkpoint_id TEXT REFERENCES checkpoints(id),
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, opencode_session_id, transcript_hash)
);
CREATE INDEX IF NOT EXISTS idx_session_auto_save_runs ON session_auto_save_runs(project_id,opencode_session_id,created_at DESC);

-- Additional source provenance when an extracted knowledge object is found again.
CREATE TABLE IF NOT EXISTS knowledge_claim_evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES knowledge_claims(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  memory_id TEXT REFERENCES memory_entries(id),
  extraction_id TEXT REFERENCES intelligence_extractions(id),
  source_session_id TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(claim_id, memory_id, extraction_id)
);
CREATE TABLE IF NOT EXISTS knowledge_decision_evidence (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES knowledge_decisions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  memory_id TEXT REFERENCES memory_entries(id),
  extraction_id TEXT REFERENCES intelligence_extractions(id),
  source_session_id TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(decision_id, memory_id, extraction_id)
);
