import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type JsonObject = Record<string, any>;

function deepMerge(base: JsonObject, override: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] && typeof result[key] === "object" ? result[key] : {}, value as JsonObject);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Canonical Memory Intelligence config with backwards-compatible legacy fallback. */
export function readMemoryConfig(projectRoot: string): JsonObject {
  const configDir = join(projectRoot, ".opencode");
  const legacyPath = join(configDir, "orchestrator.config.json");
  const canonicalPath = join(configDir, "memory.config.json");
  const read = (path: string): JsonObject => {
    if (!existsSync(path)) return {};
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      console.warn(`[memory-intelligence] could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  };
  return deepMerge(read(legacyPath), read(canonicalPath));
}

export interface MemoryAutoSaveConfig {
  enabled: boolean;
  tokenThreshold: number;
  checkOnSessionIdle: boolean;
  saveRawTranscript: boolean;
  extractNewObjects: boolean;
  estimateFallback: boolean;
  maxTranscriptCharsPerChunk: number;
}

/**
 * Session auto-save settings are deliberately read from orchestrator.config.json,
 * as requested, while provider/model credentials remain in memory.config.json.
 */
export function readMemoryAutoSaveConfig(projectRoot: string): MemoryAutoSaveConfig {
  const configPath = join(projectRoot, ".opencode", "orchestrator.config.json");
  let raw: JsonObject = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
    } catch (error) {
      console.warn(`[memory-intelligence] could not parse auto-save config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const cfg = raw?.memory?.autoSave || {};
  const threshold = Number(cfg.tokenThreshold ?? 50000);
  const maxChars = Number(cfg.maxTranscriptCharsPerChunk ?? 38000);
  return {
    enabled: String(cfg.enabled ?? true) !== "false",
    tokenThreshold: Math.min(Math.max(Number.isFinite(threshold) ? Math.floor(threshold) : 50000, 1000), 2_000_000),
    checkOnSessionIdle: String(cfg.checkOnSessionIdle ?? true) !== "false",
    saveRawTranscript: String(cfg.saveRawTranscript ?? true) !== "false",
    extractNewObjects: String(cfg.extractNewObjects ?? true) !== "false",
    estimateFallback: String(cfg.estimateFallback ?? true) !== "false",
    maxTranscriptCharsPerChunk: Math.min(Math.max(Number.isFinite(maxChars) ? Math.floor(maxChars) : 38000, 3000), 43000),
  };
}


export interface MemoryRecallConfig {
  enabled: boolean;
  mode: "relevant" | "recent" | "both";
  maxMemories: number;
  maxContextChars: number;
  cacheMs: number;
  includeRecentFallback: boolean;
}

export function readMemoryRecallConfig(projectRoot: string): MemoryRecallConfig {
  const cfg = readMemoryConfig(projectRoot).recall || {};
  const mode = new Set(["relevant", "recent", "both"]).has(String(cfg.mode)) ? String(cfg.mode) as MemoryRecallConfig["mode"] : "relevant";
  const number = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(value ?? fallback);
    return Math.min(Math.max(Number.isFinite(parsed) ? Math.floor(parsed) : fallback, min), max);
  };
  return {
    enabled: String(cfg.enabled ?? true) !== "false",
    mode,
    maxMemories: number(cfg.maxMemories, 6, 0, 20),
    maxContextChars: number(cfg.maxContextChars, 10000, 1000, 30000),
    cacheMs: number(cfg.cacheMs, 15000, 0, 120000),
    includeRecentFallback: String(cfg.includeRecentFallback ?? true) !== "false",
  };
}
