import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * sqlite-vec is loaded without a bare module specifier on purpose.
 *
 * OpenCode's plugin loader resolves bare specifiers relative to the plugin
 * entrypoint only, so a deep `import * as sqliteVec from "sqlite-vec"` inside
 * this shared package fails with `Cannot find package 'sqlite-vec'` even when
 * the dependency is installed. Resolving the native extension on disk keeps the
 * plugin loadable from a plain `bun install` and needs no bundling step.
 */

const BASE_PACKAGE_NAME = "sqlite-vec";
const ENTRYPOINT_BASE_NAME = "vec0";

const SUPPORTED: Record<string, string[]> = {
  win32: ["x64"],
  darwin: ["x64", "arm64"],
  linux: ["x64", "arm64"],
};

function extensionSuffix(platform: string): string {
  if (platform === "win32") return "dll";
  if (platform === "darwin") return "dylib";
  return "so";
}

/** e.g. `sqlite-vec-windows-x64` on Windows/x64. */
export function platformPackageName(platform = process.platform, arch = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  return `${BASE_PACKAGE_NAME}-${os}-${arch}`;
}

export function isSupportedPlatform(platform = process.platform, arch = process.arch): boolean {
  return (SUPPORTED[platform] || []).includes(arch);
}

function binaryName(platform = process.platform): string {
  return `${ENTRYPOINT_BASE_NAME}.${extensionSuffix(platform)}`;
}

/** Expand `<root>/node_modules/.bun/<pkg>@<version>/node_modules/<pkg>`. */
function bunStoreCandidates(nodeModules: string, packageName: string): string[] {
  const store = join(nodeModules, ".bun");
  if (!existsSync(store)) return [];
  const prefix = `${packageName.replace("/", "+")}@`;
  let entries: string[];
  try {
    entries = readdirSync(store);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(store, entry, "node_modules", packageName));
}

/**
 * Candidate directories that may hold the platform binary package, ordered from
 * the most specific location to the least.
 */
export function candidateDirectories(anchors: Array<string | undefined>, packageName: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (dir: string) => {
    const normalized = dir.replace(/[\\/]+$/, "");
    if (!seen.has(normalized) && existsSync(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  };

  for (const anchor of anchors) {
    if (!anchor) continue;
    let current = anchor;
    for (let depth = 0; depth < 8; depth += 1) {
      const nodeModules = join(current, "node_modules");
      if (existsSync(nodeModules)) {
        push(join(nodeModules, packageName));
        for (const candidate of bunStoreCandidates(nodeModules, packageName)) push(candidate);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return result;
}

let cachedPath: string | null | undefined;

/**
 * Absolute path to the sqlite-vec native extension, or `null` when the
 * platform package is not installed.
 */
export function resolveVectorExtensionPath(extraAnchors: Array<string | undefined> = []): string | null {
  if (cachedPath !== undefined && extraAnchors.every((anchor) => !anchor)) return cachedPath;

  const platform = process.platform;
  const arch = process.arch;
  if (!isSupportedPlatform(platform, arch)) {
    cachedPath = null;
    return null;
  }

  const packageName = platformPackageName(platform, arch);
  const file = binaryName(platform);
  const anchors = [...extraAnchors, import.meta.dir, process.cwd()];

  for (const dir of candidateDirectories(anchors, packageName)) {
    const candidate = join(dir, file);
    if (existsSync(candidate)) {
      if (extraAnchors.every((anchor) => !anchor)) cachedPath = candidate;
      return candidate;
    }
  }

  if (extraAnchors.every((anchor) => !anchor)) cachedPath = null;
  return null;
}

/**
 * Load the sqlite-vec extension into a Bun `Database`.
 *
 * Throws a descriptive error when the extension is missing so callers can keep
 * running with semantic search disabled.
 */
export function loadVectorExtension(db: { loadExtension(path: string): void }, extraAnchors: Array<string | undefined> = []): string {
  const path = resolveVectorExtensionPath(extraAnchors);
  if (!path) {
    throw new Error(
      `sqlite-vec native extension for ${process.platform}-${process.arch} was not found. ` +
        `Install ${platformPackageName()} (for example: bun add ${BASE_PACKAGE_NAME}).`,
    );
  }
  db.loadExtension(path);
  return path;
}
