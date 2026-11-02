// Stale-while-revalidate cache for the workspace home (WorkspaceHome): the last fetched payload of each summary
// card is persisted in localStorage under one entry per workspace, so revisiting a workspace renders the previous
// content immediately while fresh data loads in the background. Cache misses / parse failures / version mismatches
// all behave as "no cache"; writes never throw.

export const OVERVIEW_SKELETON_MIN_MS = 350;

const VERSION = 1;
const PREFIX = `pca.overview.v${VERSION}.`;

/** The payloads the workspace home renders, keyed by source name; stored as one entry so related data can be
 * written atomically by whichever loaders share a fetch. */
export type OverviewCacheData = Record<string, unknown>;

export interface OverviewCacheEntry {
  /** Epoch ms of the most recent successful write. */
  at: number;
  data: OverviewCacheData;
}

function key(id: string): string {
  return `${PREFIX}${id}`;
}

export function readOverviewCache(id: string): OverviewCacheEntry | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key(id));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { v?: unknown; at?: unknown; data?: unknown } | null;
    if (!parsed || parsed.v !== VERSION || typeof parsed.at !== "number" || parsed.data === undefined || parsed.data === null || typeof parsed.data !== "object") return undefined;
    return { at: parsed.at, data: parsed.data as OverviewCacheData };
  } catch {
    return undefined;
  }
}

/** Merge `patch` into the workspace's cache entry; only the given keys change. */
export function writeOverviewCache(id: string, patch: OverviewCacheData): void {
  try {
    const prev = readOverviewCache(id);
    const entry = { v: VERSION, at: Date.now(), data: { ...prev?.data, ...patch } };
    globalThis.localStorage?.setItem(key(id), JSON.stringify(entry));
  } catch {
    // Quota or serialization failure: the page works without the cache.
  }
}
