/**
 * Resolved activity of one side-conversation child. A tri-state, not a boolean:
 * the host has different UI behaviors for "we have not checked yet" versus
 * "we have checked and the child is no longer running". Treating the unknown
 * state as running would make a catalog load failure (or a missing catalog
 * feed) drive the command card into an infinite transcript poll and the
 * sidechain panel into a permanent "Deep diving…" hint, including for /btw
 * commands that finished before the page was refreshed.
 */
export type ChildActivity = 'unknown' | 'running' | 'inactive'

/**
 * State of the parent session's subagent-catalog projection.
 *
 * 0.2.0 replaced the fetched catalog with a session projection: the host
 * computes `subagentCatalog` and pushes whole values over the connected
 * session's control stream, so there is no client-side fetch lifecycle left to
 * observe. The projection store's own `idle` (no explicit baseline read has run
 * yet) is folded here — `loading` while the key still carries no value, `ready`
 * once it does — which is how the runtime's own catalog reader reads it.
 * `absent` means the controller holds no projection row for the session at all.
 */
export type CatalogState = 'absent' | 'loading' | 'ready' | 'error'

/** Inputs the resolver combines. Each is independently optional. */
export interface ChildActivityInput {
  /** Parent catalog projection state: `absent` means no projection row exists. */
  catalogState: CatalogState
  /** Session summary running bit for the child (most reliable; host-updated). */
  summaryRunning: boolean | undefined
}

/**
 * Resolve a child's live activity without treating missing data as running.
 *
 * Precedence:
 * 1. A session summary running bit is the most reliable signal (the host
 *    pushes it on session frames). When present, it is authoritative.
 * 2. A catalog that finished loading and is missing the child means the
 *    child is no longer in the parent's membership feed: `inactive`.
 * 3. Anything else (catalog not present, loading, or errored) is `unknown`.
 *
 * The catalog projection carries no per-entry activity (`SubagentCatalogEntry`
 * is identity + mode + label only), so the session summary is the only live
 * activity source: the controller keeps a summary row — and its host-set
 * running bit — for every child the catalog lists.
 *
 * The `unknown` state must never drive a poll loop or a waiting hint; both
 * conditions require an explicit `running`.
 *
 * @param input - the available activity signals.
 * @returns the resolved activity.
 */
export function resolveChildActivity(input: ChildActivityInput): ChildActivity {
  if (input.summaryRunning !== undefined) {
    return input.summaryRunning ? 'running' : 'inactive'
  }
  if (input.catalogState === 'ready') {
    return 'inactive'
  }
  return 'unknown'
}
