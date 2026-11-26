import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type JsonObject = Record<string, any>;

/**
 * Locate the nearest directory that owns an .opencode config folder.
 * Stores opened on a throwaway data root (tests, temp projects) still need the
 * real provider configuration, so walk upward instead of failing silently.
 */
function findConfigRoot(start: string): string | null {
  let dir = resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    const configDir = join(dir, ".opencode");
    if (existsSync(join(configDir, "memory.config.json")) || existsSync(join(configDir, "orchestrator.config.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Roots to consult: the data root first, then the discovered project root. */
function configRoots(projectRoot: string): string[] {
  const roots = [projectRoot];
  const discovered = findConfigRoot(projectRoot) || findConfigRoot(process.cwd());
  if (discovered && resolve(discovered) !== resolve(projectRoot)) roots.push(discovered);
  return roots;
}

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

/**
 * Load project-root .env into process.env without overwriting existing values.
 * The plugin host may not load .env itself, so this keeps credentials in one
 * git-ignored file and never in committed config. Values are never logged.
 */
export function loadProjectEnv(projectRoot: string): void {
  for (const root of configRoots(projectRoot)) {
  for (const name of [".env", join(".opencode", ".env")]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value) continue;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  }
}

/** Canonical Memory Intelligence config with backwards-compatible legacy fallback. */
export function readMemoryConfig(projectRoot: string): JsonObject {
  const roots = configRoots(projectRoot);
  const baseRoot = roots[roots.length - 1];
  const configDir = join(baseRoot, ".opencode");
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
