import { resolve, join } from "node:path";
import { MemoryStore } from "./store";
import { MemoryIntelligence } from "./intelligence";
import { sanitizeSensitiveText } from "./privacy";

export class MemoryIntelligenceClient {
  readonly projectRoot: string;
  private readonly store: MemoryStore;
  private readonly intelligence: MemoryIntelligence;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.store = new MemoryStore(this.projectRoot);
    this.intelligence = new MemoryIntelligence(this.projectRoot, this.store);
  }

  get databaseDirectory() { return this.store.root; }
  get databasePath() { return join(this.store.root, "orchestrator.sqlite"); }
  get embeddingModel() { return this.store.embeddingModel; }
  get embeddingProvider() { return this.store.embeddingProvider; }
  get embeddingPromptProfile() { return this.store.embeddingPromptProfile; }
  get embeddingBaseUrl() { return this.store.embeddingBaseUrl; }
  get embeddingApiKeyEnv() { return this.store.embeddingApiKeyEnv; }
  get embeddingApiKeyConfigured() { return this.store.embeddingApiKeyConfigured; }
  get embeddingApiKeySource() { return this.store.embeddingApiKeySource; }
  get vectorAvailable() { return this.store.vectorAvailable; }
  get vectorError() { return this.store.vectorError; }
  get maxTranscriptChars() { return this.intelligence.maxTranscriptChars; }
  get intelligenceEnabled() { return this.intelligence.enabled; }
  get autoExtractOnCompaction() { return this.intelligence.autoExtractOnCompaction; }
  get allowRemoteProcessing() { return this.intelligence.allowRemoteProcessing; }
  get deduplicationEnabled() { return this.store.deduplicationEnabled; }
  get deduplicationSimilarityThreshold() { return this.store.deduplicationSimilarityThreshold; }
  get privacyOptions() { return { ...this.store.privacyOptions }; }

  ensureProject(name: string, rootPath = this.projectRoot, goal = "Project knowledge base initialized") {
    return this.store.registerProject({ name, rootPath, goal }).projectId;
  }
  registerProject(input: Parameters<MemoryStore["registerProject"]>[0]) { return this.store.registerProject(input); }
  createTask(input: Parameters<MemoryStore["createTask"]>[0]) { return this.store.createTask(input); }
  updateTask(input: Parameters<MemoryStore["updateTask"]>[0]) { return this.store.updateTask(input); }
  createSessionRecord(input: Parameters<MemoryStore["createSessionRecord"]>[0]) { return this.store.createSessionRecord(input); }
  updateSession(input: Parameters<MemoryStore["updateSession"]>[0]) { return this.store.updateSession(input); }
  event(...args: Parameters<MemoryStore["event"]>) { return this.store.event(...args); }
  findSession(projectId: string, opencodeSessionId: string) { return this.store.findSession(projectId, opencodeSessionId); }
  listSessionCheckpoints(opencodeSessionId: string) { return this.store.listSessionCheckpoints(opencodeSessionId); }
  listTasksForSession(projectId: string, opencodeSessionId: string) { return this.store.listTasksForSession(projectId, opencodeSessionId); }
  getTask(projectId: string, taskId: string) { return this.store.getTask(projectId, taskId); }
  countTasks(projectId: string) { return this.store.countTasks(projectId); }
  countGraphEdges(projectId: string, relation?: string) { return this.store.countGraphEdges(projectId, relation); }
  embeddingStatus(projectId: string) { return this.store.embeddingStatus(projectId); }

  writeMemory(input: Parameters<MemoryStore["writeMemory"]>[0]) { return this.store.writeMemory(input); }
  listMemories(projectId: string, options?: Parameters<MemoryStore["listMemories"]>[1]) { return this.store.listMemories(projectId, options); }
  forgetMemory(projectId: string, memoryId: string, reason?: string) { return this.store.forgetMemory(projectId, memoryId, reason); }
  restoreMemory(projectId: string, memoryId: string) { return this.store.restoreMemory(projectId, memoryId); }
  searchMemory(input: Parameters<MemoryStore["searchMemory"]>[0]) { return this.store.searchMemory(input); }
  semanticSearch(input: Parameters<MemoryStore["semanticSearch"]>[0]) { return this.store.semanticSearch(input); }
  reindexPending(input: Parameters<MemoryStore["reindexPending"]>[0]) { return this.store.reindexPending(input); }
  graphQuery(input: Parameters<MemoryStore["graphQuery"]>[0]) { return this.store.graphQuery(input); }
  checkpoint(input: Parameters<MemoryStore["checkpoint"]>[0]) { return this.store.checkpoint(input); }
  writeMemoryDeduplicated(input: Parameters<MemoryStore["writeMemoryDeduplicated"]>[0]) { return this.store.writeMemoryDeduplicated(input); }
  getSessionAutoSaveState(projectId: string, sessionId: string) { return this.store.getSessionAutoSaveState(projectId, sessionId); }
  beginSessionAutoSaveRun(input: Parameters<MemoryStore["beginSessionAutoSaveRun"]>[0]) { return this.store.beginSessionAutoSaveRun(input); }
  setSessionAutoSaveCheckpoint(runId: string, checkpointId: string) { return this.store.setSessionAutoSaveCheckpoint(runId, checkpointId); }
  completeSessionAutoSaveRun(input: Parameters<MemoryStore["completeSessionAutoSaveRun"]>[0]) { return this.store.completeSessionAutoSaveRun(input); }
  failSessionAutoSaveRun(runId: string, error: string) { return this.store.failSessionAutoSaveRun(runId, error); }
  sessionAutoSaveStatus(projectId: string) { return this.store.sessionAutoSaveStatus(projectId); }
  report(projectId: string) { return this.store.report(projectId); }
  consolidate(projectId: string) { return this.store.consolidate(projectId); }
  createBackup(projectId: string) { return this.store.createBackup(projectId); }
  exportMemory(projectId: string) { return this.store.exportMemory(projectId); }
  lockFile(projectId: string, filePath: string, ownerSessionId: string, purpose?: string, ttlMinutes?: number) {
    return this.store.lockFile(projectId, filePath, ownerSessionId, purpose, ttlMinutes);
  }

  extract(input: Parameters<MemoryIntelligence["extract"]>[0]) { return this.intelligence.extract(input); }
  planTasks(input: Parameters<MemoryIntelligence["planTasks"]>[0]) { return this.intelligence.planTasks(input); }
  intelligenceStatus() { return this.intelligence.status(); }
  intelligenceConsolidate(projectId: string) { return this.intelligence.consolidate(projectId); }
  intelligenceReport(projectId: string) { return this.intelligence.report(projectId); }
  conflicts(projectId: string, status = "open", limit = 50) { return this.intelligence.conflicts(projectId, status, limit); }
  resolveConflict(input: Parameters<MemoryIntelligence["resolveConflict"]>[0]) { return this.intelligence.resolveConflict(input); }
  projectStateAt(input: Parameters<MemoryIntelligence["projectStateAt"]>[0]) { return this.intelligence.projectStateAt(input); }

  findSessionIngestion(projectId: string, opencodeSessionId: string, transcriptHash: string) {
    return this.store.findSessionIngestion(projectId, opencodeSessionId, transcriptHash);
  }
  beginSessionIngestion(input: Parameters<MemoryStore["beginSessionIngestion"]>[0]) { return this.store.beginSessionIngestion(input); }
  completeSessionIngestion(input: Parameters<MemoryStore["completeSessionIngestion"]>[0]) { return this.store.completeSessionIngestion(input); }
  failSessionIngestion(ingestionId: string, projectId: string, error: string) { return this.store.failSessionIngestion(ingestionId, projectId, error); }
  createIngestTaskPlan(input: Parameters<MemoryStore["createIngestTaskPlan"]>[0]) { return this.store.createIngestTaskPlan(input); }

  buildContextPack(projectId: string, opencodeSessionId: string) {
    // The deterministic fallback includes recent memories if semantic recall is unavailable.
    return this.formatContextPack(projectId, opencodeSessionId, [], 10000, { mode: "both", includeRecentFallback: true });
  }

  async buildRelevantContextPack(projectId: string, opencodeSessionId: string, query: string, options: { maxMemories?: number; maxChars?: number; mode?: "relevant" | "recent" | "both"; includeRecentFallback?: boolean } = {}) {
    const useSemantic = options.mode !== "recent" && query.trim().length > 0 && (options.maxMemories ?? 6) > 0;
    const relevant = useSemantic ? await this.store.semanticSearch({
      projectId, query: sanitizeSensitiveText(query).slice(0, 8000), limit: options.maxMemories ?? 6,
    }).then((result) => result.results).catch((error) => {
      this.store.event(projectId, "MEMORY_RECALL_FAILED", { error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }, opencodeSessionId);
      return [];
    }) : [];
    return this.formatContextPack(projectId, opencodeSessionId, relevant, options.maxChars ?? 10000, options);
  }

  private formatContextPack(projectId: string, opencodeSessionId: string, relevant: any[], maxChars: number,
    options: { mode?: "relevant" | "recent" | "both"; includeRecentFallback?: boolean } = {}) {
    const context = this.store.buildContextPack(projectId, opencodeSessionId);
    const unresolved = this.intelligence.conflicts(projectId, "open", 4).conflicts as any[];
    const mode = options.mode || "relevant";
    const recent = mode === "recent" || mode === "both" || (options.includeRecentFallback && !relevant.length) ? context.latest : [];
    const byId = new Map<string, any>();
    for (const item of [...relevant, ...recent]) if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
    const memoryLines = [...byId.values()].slice(0, 12).map((m: any) => {
      const score = Number.isFinite(Number(m.semanticSimilarity)) ? `, similarity ${Number(m.semanticSimilarity).toFixed(2)}` : "";
      return `- [${sanitizeSensitiveText(m.kind)}] ${sanitizeSensitiveText(m.title)} (memory:${m.id}${score})\n${sanitizeSensitiveText(m.content).slice(0, 1400)}`;
    });
    const sections = [
      memoryLines.length ? `${mode === "recent" ? "Recent project memory" : "Relevant project memory"}:\n${memoryLines.join("\n")}` : "",
      context.decisions.length ? `Active decisions:\n${context.decisions.map((d: any) => `- ${sanitizeSensitiveText(d.title)}: ${sanitizeSensitiveText(d.decision)} (confidence ${Number(d.confidence).toFixed(2)}, decision:${d.id})`).join("\n")}` : "",
      context.claims.length ? `Current recorded claims (verify provenance when material):\n${context.claims.map((c: any) => `- ${sanitizeSensitiveText(c.subject)} — ${sanitizeSensitiveText(c.predicate)}: ${sanitizeSensitiveText(c.object_value)} (confidence ${Number(c.confidence).toFixed(2)}, claim:${c.id})`).join("\n")}` : "",
      unresolved.length ? `UNRESOLVED CONTRADICTIONS — do not choose a side without evidence:\n${unresolved.map((c: any) => `- ${sanitizeSensitiveText(c.subject)} / ${sanitizeSensitiveText(c.predicate)}: “${sanitizeSensitiveText(c.left_value)}” vs “${sanitizeSensitiveText(c.right_value)}” (conflict:${c.id})`).join("\n")}` : ""
    ].filter(Boolean);
    const text = sections.length ? `${sections.join("\n\n")}\nUse memory tools to retrieve full source records and resolve uncertainty.` : "";
    return text.slice(0, Math.min(Math.max(maxChars, 1000), 30000));
  }

  close() { this.store.close(); }
}

type RegistryEntry = { client: MemoryIntelligenceClient; references: number };
type Registry = Map<string, RegistryEntry>;
const registrySymbol = Symbol.for("opencode.memory-intelligence.registry.v1");
const registryHost = globalThis as typeof globalThis & { [key: symbol]: Registry | undefined };
const registry: Registry = registryHost[registrySymbol] ?? (registryHost[registrySymbol] = new Map());

function registryKey(projectRoot: string): string {
  const resolved = resolve(projectRoot).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Acquire the single in-process Memory Intelligence service for this OpenCode project.
 * Multiple plugins receive the same client and cannot close the database while another
 * plugin still holds a lease.
 */
export interface MemoryClientLease {
  readonly client: MemoryIntelligenceClient;
  release(): void;
}

export function acquireMemoryIntelligence(projectRoot: string): MemoryClientLease {
  const key = registryKey(projectRoot);
  let entry = registry.get(key);
  if (!entry) {
    entry = { client: new MemoryIntelligenceClient(resolve(projectRoot)), references: 0 };
    registry.set(key, entry);
  }
  entry.references += 1;
  let released = false;
  return {
    client: entry.client,
    release: () => {
      if (released) return;
      released = true;
      const current = registry.get(key);
      if (!current) return;
      current.references -= 1;
      if (current.references <= 0) {
        registry.delete(key);
        current.client.close();
      }
    }
  };
}
