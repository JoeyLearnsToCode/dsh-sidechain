/**
 * Embedded side-conversation transcript model (browser half).
 *
 * The panel renders a child's conversation from `session.history`, which reads
 * the durable log WITHOUT activating the child or changing the current session.
 *
 * A sidechain child's log starts with the ENTIRE inherited parent history as
 * its fork seed (reference context). The mapping therefore cuts everything
 * before the first "Side conversation boundary" prompt and its preceding
 * seed marker, so continuation-turn seed markers do not hide older turns.
 *
 * Live streaming: the durable log no longer carries token-level chunk events
 * (an `assistant/message` carries its own stream records), so a running child
 * is followed by tail polls — each poll reads a small page from the log's
 * current end and merges it into a per-child event cache, so old rounds stay
 * visible without re-reading the inherited seed.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress, SubagentPromptRequest } from '@deepseek-ai/dsh-subagent/client'
import type { SessionAttachmentRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { lastActivity } from './sidechain-activity.ts'

/**
 * Tail-page size for one transcript fetch (messages per page). Small on
 * purpose: a side child inherits the ENTIRE parent history as its fork seed,
 * and the seed is dense with chunk/reasoning events — a large window would
 * drag megabytes of inherited seed across the wire for every poll.
 */
export const TRANSCRIPT_PAGE_MESSAGES = 8
/** Activity fetch: even smaller pages, fewer pages (only needs the tail). */
export const ACTIVITY_PAGE_MESSAGES = 6
export const ACTIVITY_PAGE_CAP = 4

/**
 * Detail attached to one tool row: the raw call arguments, the paired
 * result's visible text, and the failure. The 0.1.5 session journal serves
 * durable events only — host-computed tool cards are contributed by each
 * tool's own `tool.call.toolview` registration, so a foreign transcript
 * reads the log itself.
 */
export interface ToolDetail {
  arguments?: string | undefined
  /** Visible text of the paired result's content blocks. */
  output?: string | undefined
  error?: { name: string; code: string } | undefined
}

/**
 * One durable event as the session journal serves it. The wire envelope IS
 * the durable event, so the reader narrows it at the boundary.
 */
export interface HistoryRecord {
  readonly event: unknown
}

/** One message-aligned backwards history page. */
export interface HistoryPage {
  readonly records: readonly HistoryRecord[]
  readonly hasMore: boolean
}

/**
 * One message-aligned backwards-history request. The address is the durable
 * parent/child pair: a child's log has `origin: 'subagent'`, and the host
 * rejects a bare session address for it (`session/agent-busy`).
 */
export interface HistoryPageRequest {
  readonly address: SubagentAddress & { readonly kind: 'subagent' }
  /** Inclusive log cut; `-1` reads from the log's current end. */
  readonly throughSeq: number
  readonly beforeSeq?: number
  readonly maxMessages?: number
}

/** The `RemoteResult<HistoryPage>` shape a history read resolves to. */
export type HistoryResult = { readonly ok: true; readonly value: HistoryPage } | { readonly ok: false }

/**
 * One backwards-history read against the durable parent/child address.
 *
 * `page` needs the exact log seq it reads through; `-1` is the empty cursor,
 * not "the end", so the tail window (and the cursor it reports) comes from
 * `follow`'s opening snapshot.
 */
export interface HistoryFollowRequest {
  readonly address: SubagentAddress & { readonly kind: 'subagent' }
  readonly maxMessages?: number
}

/** The opening snapshot of one follow stream: the log's tail and its cursor. */
export type HistoryFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly cursor: number
    readonly records: readonly HistoryRecord[]
    readonly hasMore: boolean
  }
  | { readonly type: 'event' | 'assistant-stream' }

/** The `ctx.remote.session` slice the panel consumes. */
export interface SessionHistory {
  page(request: HistoryPageRequest, signal?: AbortSignal): Promise<HistoryResult>
  follow(request: HistoryFollowRequest, signal?: AbortSignal): AsyncIterable<HistoryFollowFrame>
}

/** The `ctx.remote.subagents.prompt` slice the panel consumes. */
export interface SubagentPrompter {
  prompt(request: SubagentPromptRequest, signal?: AbortSignal): Promise<{ readonly ok: boolean }>
}

/** One durable image read. */
export type AttachmentResult = { readonly ok: true; readonly value: { readonly data: string } } | { readonly ok: false }

/** The `ctx.remote.session.attachment` slice the panel consumes. */
export interface SessionAttachments {
  attachment(request: SessionAttachmentRequest): Promise<AttachmentResult>
}

/**
 * Project a durable message source to the row's producer role and label.
 * A local projection: the 0.1.5 platform keeps this inside the Chat and
 * Trajectory packages, and a foreign bundle cannot import their values.
 * @param source - Logged `user/message` source.
 * @returns role and label rendered by the panel.
 */
export function contextProvenance(source: unknown): { role: 'inject' | 'recall'; label: string | null } {
  const record = typeof source === 'object' && source !== null && !Array.isArray(source)
    ? source as Record<string, unknown>
    : null
  const kind = record === null ? null : readString(record, 'kind')
  if (record === null || kind === null) return { role: 'inject', label: null }
  switch (kind) {
    case 'session-reference':
      return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind }
    case 'agent-instructions':
      return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind }
    case 'plugin':
      return { role: 'inject', label: readString(record, 'plugin') ?? kind }
    case 'skill-invocation':
      return { role: 'inject', label: readString(record, 'name') ?? kind }
    default:
      return { role: 'inject', label: kind }
  }
}

/** Read a non-empty string member off a durable source record. */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Collect one string field across an array member, in first-seen order. */
function collect(source: Record<string, unknown>, member: string, field: string): string[] {
  const list = source[member]
  if (!Array.isArray(list)) return []
  const seen: string[] = []
  for (const entry of list) {
    const record = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : null
    const value = record === null ? null : readString(record, field)
    if (value !== null && !seen.includes(value)) seen.push(value)
  }
  return seen
}

/** Render a label list, or null when the source cited none. */
function joined(names: string[]): string | null {
  return names.length > 0 ? names.join(', ') : null
}

type ImageAttachmentRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** An image reference plus its browser-ready data URL when the host can serve it. */
export interface TranscriptImage {
  attachment: ImageAttachmentRef
  url?: string | undefined
}

export type TranscriptRow =
  | { kind: 'user'; seq: number; text: string; images?: readonly TranscriptImage[] }
  | { kind: 'assistant'; seq: number; text: string; images?: readonly TranscriptImage[] }
  | { kind: 'reasoning'; seq: number; text: string }
  | {
    kind: 'context'
    seq: number
    text: string
    source: string | null
    recall: boolean
    images?: readonly TranscriptImage[]
  }
  | { kind: 'error'; seq: number; text: string }
  | { kind: 'tool'; seq: number; name: string; failed: boolean; detail?: ToolDetail | undefined }

/** The fork boundary prompt's first line (marker for the side boundary message). */
const BOUNDARY_PREFIX = 'Side conversation boundary'

/**
 * Strip the internal side-conversation boundary envelope off an opening user
 * message, returning just the user's own question. The boundary message is
 * built by {@link sidePrompt} as: boundary prompt + mode line + question.
 * When the message is not a boundary (no `Mode:` line present) it is treated
 * as a pure internal envelope and dropped (`null`).
 */
function stripSideBoundary(text: string): string | null {
  if (!text.startsWith(BOUNDARY_PREFIX)) return text
  const modeIndex = text.indexOf('\nMode:')
  if (modeIndex < 0) return null
  const afterMode = text.indexOf('\n', modeIndex + 1)
  if (afterMode < 0) return null
  const rest = text.slice(afterMode + 1).trim()
  return rest === '' ? null : rest
}

/**
 * Extract the visible text of a content block list: `text` blocks verbatim,
 * joined by blank lines; everything else (reasoning, tool blocks) contributes
 * nothing. An empty result reads `…` so rows never render blank.
 * @param blocks - model-facing content blocks.
 * @returns the joined visible text.
 */
export function blockText(blocks: readonly ContentBlock[]): string {
  const text = blocks
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(part => part !== '')
    .join('\n\n')
  return text === '' ? '…' : text
}

function imageRefs(blocks: readonly ContentBlock[]): ImageAttachmentRef[] {
  return blocks.flatMap(block => block.type === 'image' ? [block.attachment] : [])
}

function transcriptImages(refs: readonly ImageAttachmentRef[]): TranscriptImage[] {
  return refs.map(attachment => ({ attachment }))
}

function rowText(blocks: readonly ContentBlock[], images: readonly ImageAttachmentRef[]): string {
  const text = blockText(blocks)
  return images.length > 0 && text === '…' ? '' : text
}

/** Index of the last `session/end-seed` event (fork seed marker), or -1. */
function lastSeedEnd(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'session/end-seed') return i
  }
  return -1
}

function isSideBoundaryEvent(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text.startsWith(BOUNDARY_PREFIX))
}

/** Seed marker immediately before the child's first boundary prompt, or the
 * latest marker for legacy logs without a boundary. */
function transcriptSeedEnd(events: readonly SessionEvent[]): number {
  const boundary = events.findIndex(isSideBoundaryEvent)
  if (boundary >= 0) {
    for (let i = boundary - 1; i >= 0; i--) {
      if (events[i]?.type === 'session/end-seed') return i
    }
    return -1
  }
  return lastSeedEnd(events)
}

/**
 * Map a session log's history rows onto compact transcript rows: the
 * inherited fork seed is cut at the first boundary's preceding
 * `session/end-seed`, the boundary prompt is dropped, an `assistant/message`
 * contributes its reasoning and text blocks in order, and tool invocations
 * render one expandable line each — the raw call arguments and the paired
 * result's visible text (matched by the result's `toolCallId`) ride the row
 * as detail; a failing `tool/result` marks it.
 * @param entries - history rows in seq order.
 * @returns display rows in log order.
 */
export function transcriptRows(entries: readonly TranscriptEntry[]): TranscriptRow[] {
  const events = entries.map(entry => entry.event)
  const seedEnd = transcriptSeedEnd(events)
  const rows: TranscriptRow[] = []
  /** tool callId → index of its tool row in `rows` (result pairing). */
  const callRows = new Map<string, number>()
  for (let i = 0; i < events.length; i++) {
    if (i <= seedEnd) continue
    const event = events[i] as SessionEvent
    switch (event.type) {
      case 'user/message': {
        const refs = imageRefs(event.data.content)
        const text = rowText(event.data.content, refs)
        const images = refs.length === 0 ? {} : { images: transcriptImages(refs) }
        const stripped = stripSideBoundary(text)
        if (stripped === null) break
        const displayText = stripped === text ? text : stripped
        const source = event.data.source as unknown
        const sourceKind = typeof source === 'object' && source !== null
          ? (source as Record<string, unknown>)['kind']
          : undefined
        if (sourceKind === undefined || sourceKind === 'user') {
          rows.push({ kind: 'user', seq: event.seq, text: displayText, ...images })
        } else {
          const provenance = contextProvenance(source)
          rows.push({
            kind: 'context', seq: event.seq, text: displayText,
            source: provenance.label,
            recall: provenance.role === 'recall',
            ...images,
          })
        }
        break
      }
      case 'assistant/message': {
        const settled = event.data.message.content.flatMap((block): TranscriptRow[] => {
          if (block.type === 'reasoning' && block.text !== '') {
            return [{ kind: 'reasoning', seq: event.seq, text: block.text }]
          }
          if (block.type === 'text' && block.text !== '') {
            return [{ kind: 'assistant', seq: event.seq, text: block.text }]
          }
          return []
        })
        const refs = imageRefs(event.data.message.content)
        if (refs.length > 0) {
          const images = transcriptImages(refs)
          const assistant = settled.findIndex(row => row.kind === 'assistant')
          if (assistant >= 0) {
            const row = settled[assistant]
            if (row !== undefined && row.kind === 'assistant') settled[assistant] = { ...row, images }
          } else {
            settled.push({ kind: 'assistant', seq: event.seq, text: '', images })
          }
        }
        if (settled.length === 0 && event.data.message.content.length === 0) {
          settled.push({ kind: 'assistant', seq: event.seq, text: '…' })
        }
        rows.push(...settled)
        break
      }
      case 'tool/call': {
        const data = event.data
        callRows.set(data.callId, rows.length)
        rows.push({
          kind: 'tool',
          seq: event.seq,
          name: data.name,
          failed: false,
          detail: { arguments: data.arguments },
        })
        break
      }
      case 'tool/result': {
        const data = event.data
        // 0.2.0 made the tool result a first-class `role: 'tool'` message: the
        // call identity and the failure flag moved off the content blocks and
        // onto the message itself.
        const message = data.message
        const index = callRows.get(message.toolCallId)
        const error = data.error
        // A result is failed on the explicit event error OR the message's own
        // isError flag (tools report hard failures either way).
        const failed = error !== undefined || message.isError === true
        const output = resultText(message.content)
        if (index !== undefined) {
          const row = rows[index]
          if (row !== undefined && row.kind === 'tool') {
            rows[index] = {
              ...row,
              failed,
              detail: {
                ...row.detail,
                ...(output === undefined ? {} : { output }),
                ...(error === undefined ? {} : { error }),
              },
            }
          }
        } else if (failed) {
          // Orphan result (no call row in the window): surface the failure
          // with its error so the row stays informative and expandable.
          rows.push({
            kind: 'tool', seq: event.seq, name: 'tool', failed: true,
            ...(error === undefined ? {} : { detail: { error } }),
          })
        }
        break
      }
      case 'turn/end': {
        if (event.data.reason.kind !== 'error') break
        rows.push({ kind: 'error', seq: event.seq, text: event.data.reason.error.message })
        break
      }
      default: {
        break
      }
    }
  }
  return rows
}

/** One history row: the durable event the journal served. */
export interface TranscriptEntry {
  event: SessionEvent
}

/**
 * Read the visible text of one tool result's content blocks, or undefined when
 * it carries none (terminal results stay collapsed behind their own row).
 * @param blocks - the tool-role message's content blocks.
 * @returns the blocks' text, or undefined.
 */
function resultText(blocks: readonly ContentBlock[]): string | undefined {
  const text = blockText(blocks)
  return text === '…' ? undefined : text
}

/**
 * Fetch a child's transcript.
 *
 * Reads through `ctx.remote.session.page`, which resolves the child's durable
 * log through its address (no activation, no navigation).
 *
 * The child's log STARTS with the entire inherited parent history (fork
 * seed), which can be tens of thousands of events. A single large tail
 * window would ship the inherited seed on every poll, so the reader pages
 * backwards in small windows until a window contains the seed boundary,
 * then cuts there. Later reads fetch one tail page and merge those events into
 * the cached child transcript, retaining earlier rounds.
 * @param history - the session journal's page read.
 * @param address - durable parent/child address (only the child id is used).
 * @param attachments - optional session-authorized image loader.
 * @returns display rows, or null on transport/business failure.
 */
export async function fetchTranscript(
  history: SessionHistory,
  address: SubagentAddress,
  attachments?: SessionAttachments,
): Promise<{ rows: readonly TranscriptRow[] } | null> {
  const entries = await fetchSeedCutEntries(
    history, address, TRANSCRIPT_PAGE_MESSAGES,
  )
  if (entries === null) return null
  const previous = transcriptEntryCache.get(address.childSessionId) ?? []
  const bySeq = new Map(previous.map(entry => [entry.event.seq, entry]))
  for (const entry of entries) bySeq.set(entry.event.seq, entry)
  const transcript = [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq)
  transcriptEntryCache.set(address.childSessionId, transcript)
  const rows = transcriptRows(transcript)
  return {
    rows: attachments === undefined
      ? rows
      : await hydrateTranscriptImages(attachments, address.childSessionId, rows),
  }
}

/**
 * Fetch one running child's live activity line (latest assistant text or
 * last tool call) from a light seed-cut tail page — the list-row preview
 * poll, kept much cheaper than the full transcript page (no produced
 * vocabulary, fewer pages).
 * @param sessions - the api client's sessions surface.
 * @param address - durable parent/child address (only the child id is used).
 * @returns the activity line, or null on transport/business failure or an
 *   empty tail.
 */
export async function fetchActivity(
  history: SessionHistory,
  address: SubagentAddress,
): Promise<string | null> {
  const entries = await fetchSeedCutEntries(
    history, address, ACTIVITY_PAGE_MESSAGES, ACTIVITY_PAGE_CAP,
  )
  if (entries === null) return null
  return lastActivity(transcriptRows(entries)) ?? null
}

/**
 * Per-child seed-boundary cache: the seq of the marker before the child's
 * first boundary. Once the first walk locates it, every later read needs at
 * most ONE page and the dense inherited seed is never re-downloaded.
 */
const seedBoundaryCache = new Map<string, number>()
/** Child-owned history accumulated from cheap tail polls. */
const transcriptEntryCache = new Map<string, readonly TranscriptEntry[]>()
const imageUrlCache = new Map<string, string | null>()

/** Test seam: drop cached seed boundaries and accumulated transcripts. */
export function resetSeedBoundaryCache(): void {
  seedBoundaryCache.clear()
  transcriptEntryCache.clear()
  imageUrlCache.clear()
}

async function hydrateTranscriptImages(
  attachments: SessionAttachments,
  childSessionId: SubagentAddress['childSessionId'],
  rows: readonly TranscriptRow[],
): Promise<TranscriptRow[]> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const row of rows) {
    for (const image of 'images' in row ? row.images ?? [] : []) {
      refs.set(String(image.attachment.attachmentId), image.attachment)
    }
  }
  if (refs.size === 0) return [...rows]

  await Promise.all([...refs].map(async ([id, ref]) => {
    if (imageUrlCache.has(id)) return
    try {
      const response = await attachments.attachment({
        sessionId: childSessionId,
        attachmentId: ref.attachmentId,
      })
      if (!response.ok) {
        imageUrlCache.set(id, null)
        return
      }
      const data = response.value.data
      imageUrlCache.set(id, data.startsWith('data:') ? data : `data:${ref.mediaType};base64,${data}`)
    } catch {
      imageUrlCache.set(id, null)
    }
  }))

  return rows.map(row => {
    if (!('images' in row) || row.images === undefined) return row
    return {
      ...row,
      images: row.images.map(image => {
        const url = imageUrlCache.get(String(image.attachment.attachmentId))
        return { ...image, ...(typeof url === 'string' ? { url } : {}) }
      }),
    }
  })
}

/**
 * Page a child's log backwards from the tail in small windows until a window
 * contains the first boundary prompt, then return everything after the seed
 * marker before that prompt — the child's own conversation only.
 *
 * The host pages strictly backward (`beforeSeq` is an exclusive upper bound),
 * so there is no "start after the boundary" fetch: the first read walks back
 * until a window contains the boundary. Later reads fetch one tail window and
 * cut with the cached seed marker. Overlap between pages is deduped by
 * sequence, so an inclusive `beforeSeq` contract on the host is harmless.
 * @param history - the session journal's page read.
 * @param address - the child's durable parent/child address.
 * @param pageMessages - messages per backward page.
 * @param pageCap - optional backward-page cap for lightweight callers. The
 *   transcript read omits it and continues until the seed boundary.
 * @returns the seed-cut entries, or null on transport/business failure.
 */
/**
 * Read a child's current tail window and the log cursor it was cut at.
 *
 * The follow stream opens on the durable parent/child address and its first
 * frame is the tail snapshot; the stream is aborted right after, so a poll
 * costs one snapshot rather than an open subscription.
 * @param history - the session journal.
 * @param address - the child's durable parent/child address.
 * @param pageMessages - messages in the tail window.
 * @returns the window plus its cursor, or null on transport/business failure.
 */
async function readTailWindow(
  history: SessionHistory,
  address: SubagentAddress,
  pageMessages: number,
): Promise<{ entries: TranscriptEntry[]; cursor: number; hasMore: boolean } | null> {
  const controller = new AbortController()
  try {
    for await (const frame of history.follow(
      { address: { kind: 'subagent', ...address }, maxMessages: pageMessages },
      controller.signal,
    )) {
      if (frame.type === 'snapshot') {
        return {
          entries: frame.records.map(record => ({ event: record.event as SessionEvent })),
          cursor: frame.cursor,
          hasMore: frame.hasMore,
        }
      }
    }
    return null
  } catch {
    return null
  } finally {
    controller.abort()
  }
}

async function fetchSeedCutEntries(
  history: SessionHistory,
  address: SubagentAddress,
  pageMessages: number,
  pageCap?: number,
): Promise<readonly TranscriptEntry[] | null> {
  const childSessionId = address.childSessionId
  const cachedBoundary = seedBoundaryCache.get(childSessionId)
  const collected: TranscriptEntry[] = []
  let beforeSeq: number | undefined
  let boundarySeq = cachedBoundary
  try {
    const tail = await readTailWindow(history, address, pageMessages)
    if (tail === null) return null
    let cursor = tail.cursor
    let hasMore = tail.hasMore
    for (let page = 0; page < (pageCap ?? Number.POSITIVE_INFINITY); page++) {
      let events: TranscriptEntry[]
      if (page === 0) {
        events = tail.entries
      } else {
        const response = await history.page({
          address: { kind: 'subagent', ...address },
          throughSeq: cursor,
          maxMessages: pageMessages,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        })
        if (!response.ok) return null
        events = response.value.records.map(
          record => ({ event: record.event as SessionEvent }),
        )
        hasMore = response.value.hasMore
      }
      if (events.length === 0) break
      const olderThan = collected.length > 0 ? collected[0]!.event.seq : undefined
      const fresh = olderThan === undefined
        ? events
        : events.filter(entry => entry.event.seq < olderThan)
      if (boundarySeq !== undefined) {
        // Cached boundary + a window without the marker: the window is
        // entirely the child's own content — the seq filter is a safe no-op.
        const boundary = boundarySeq
        collected.unshift(...fresh.filter(entry => entry.event.seq > boundary))
        break
      }
      const boundaryIndex = fresh.findIndex(entry => isSideBoundaryEvent(entry.event))
      if (boundaryIndex >= 0) {
        for (let i = boundaryIndex - 1; i >= 0; i--) {
          if (fresh[i]?.event.type !== 'session/end-seed') continue
          boundarySeq = fresh[i]!.event.seq
          seedBoundaryCache.set(childSessionId, boundarySeq)
          break
        }
        collected.unshift(...fresh)
        break
      }
      const seedEnd = lastSeedEnd(fresh.map(entry => entry.event))
      if (seedEnd >= 0 && hasMore === false) {
        // Legacy/no-boundary logs have no stronger ownership marker.
        boundarySeq = fresh[seedEnd]!.event.seq
        seedBoundaryCache.set(childSessionId, boundarySeq)
        collected.unshift(...fresh.slice(seedEnd + 1))
        break
      }
      collected.unshift(...fresh)
      if (fresh.length === 0) break
      beforeSeq = fresh[0]!.event.seq
    }
  } catch {
    return null
  }
  return collected
}

/**
 * Deliver one human message to a continuable child through its exact
 * direct-parent address (the same non-activating transport the runtime's
 * catalog navigation uses).
 * @param subagents - the subagent Remote namespace.
 * @param address - continuable parent/child address.
 * @param text - the message body (one text block).
 * @param requestId - caller-minted prompt request id (branded by the host).
 * @returns whether the prompt was accepted.
 */
export async function sendPrompt(
  subagents: SubagentPrompter,
  address: Extract<SubagentAddress, { mode: 'continuable' }>,
  text: string,
  requestId: SubagentPromptRequest['requestId'],
): Promise<boolean> {
  try {
    const response = await subagents.prompt({
      ...address,
      requestId,
      // A side conversation is a human interjection on the nearest step.
      delivery: 'steer',
      content: [{ type: 'text', text }],
    })
    return response.ok
  } catch {
    return false
  }
}
