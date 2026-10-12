/**
 * Unit tests for the embedded side-conversation transcript model: event →
 * row mapping, tool call/result pairing, and the history/prompt RPC helpers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress, SubagentPromptRequest } from '@deepseek-ai/dsh-subagent/client'
import {
  blockText, fetchTranscript, resetSeedBoundaryCache, sendPrompt, transcriptRows,
} from '../src/client/sidechain-view'
import type { TranscriptEntry } from '../src/client/sidechain-view'

const CHILD = '54c34e5e-1c29-4a6c-a2f7-4b19a3d92914' as SessionId
const ADDRESS: SubagentAddress = { parentSessionId: 'parent-1' as SessionId, childSessionId: CHILD, mode: 'continuable' }
const REQUEST_ID = 'req-1' as SubagentPromptRequest['requestId']

function event(type: SessionEvent['type'], seq: number, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

/** Wrap events into history rows. */
function ent(...events: SessionEvent[]): TranscriptEntry[] {
  return events.map(event => ({ event }))
}

/** One successful backwards-history page carrying `events`. */
function okPage(hasMore: boolean, ...events: SessionEvent[]) {
  return { ok: true, value: { records: events.map(entry => ({ event: entry })), hasMore } }
}

/**
 * Build a session journal stub: the first window arrives as the follow
 * snapshot (with `cursor`), every later window comes from `page`.
 */
function journal(
  tail: { events: SessionEvent[]; hasMore: boolean; cursor?: number },
  ...older: { events: SessionEvent[]; hasMore: boolean }[]
) {
  const follow = vi.fn(() => (async function* () {
    yield {
      type: 'snapshot',
      cursor: tail.cursor ?? 999,
      records: tail.events.map(entry => ({ event: entry })),
      hasMore: tail.hasMore,
    }
  })())
  const page = vi.fn()
  for (const window of older) page.mockResolvedValueOnce(okPage(window.hasMore, ...window.events))
  return { follow, page }
}

/** The page request the reader sends for one older window. */
function pageRequest(cursor: number, maxMessages: number, beforeSeq: number) {
  return {
    address: { kind: 'subagent', ...ADDRESS },
    throughSeq: cursor,
    maxMessages,
    beforeSeq,
  }
}

describe('blockText', () => {
  it('joins text blocks with blank lines and skips non-text blocks', () => {
    expect(blockText([
      { type: 'text', text: '第一行' },
      { type: 'reasoning', text: '思考过程' },
      { type: 'text', text: '第二行' },
    ])).toBe('第一行\n\n第二行')
  })

  it('renders … for content without visible text', () => {
    expect(blockText([{ type: 'reasoning', text: 'hidden' }])).toBe('…')
    expect(blockText([])).toBe('…')
  })
})

describe('transcriptRows', () => {
  it('maps user prompts, assistant answers, and tool calls in order', () => {
    const rows = transcriptRows(ent(
      event('user/message', 1, { content: [{ type: 'text', text: '查一下' }] }),
      event('tool/call', 2, { name: 'grep', arguments: '{}' }),
      event('tool/result', 3, { message: { toolCallId: 'c1', content: [] } }),
      event('assistant/message', 4, { message: { content: [{ type: 'text', text: '结果如下' }] } }),
    ))
    expect(rows).toEqual([
      { kind: 'user', seq: 1, text: '查一下' },
      { kind: 'tool', seq: 2, name: 'grep', failed: false, detail: { arguments: '{}' } },
      { kind: 'assistant', seq: 4, text: '结果如下' },
    ])
  })

  it('pairs a failing tool/result onto its call row by toolCallId', () => {
    const rows = transcriptRows(ent(
      event('tool/call', 1, { name: 'grep', arguments: '{}', callId: 'c1' }),
      event('tool/result', 2, {
        message: { toolCallId: 'c1', content: [] },
        error: { name: 'E', code: 'C' },
      }),
    ))
    expect(rows).toEqual([{
      kind: 'tool', seq: 1, name: 'grep', failed: true,
      detail: { arguments: '{}', error: { name: 'E', code: 'C' } },
    }])
  })

  it('marks a result failed on the tool-role message isError flag', () => {
    const rows = transcriptRows(ent(
      event('tool/call', 1, { name: 'edit', arguments: '{}', callId: 'c1' }),
      event('tool/result', 2, {
        message: { toolCallId: 'c1', content: [], isError: true },
      }),
    ))
    expect(rows[0]).toMatchObject({ kind: 'tool', failed: true })
  })

  it('keeps the error on orphan failed rows (expandable detail)', () => {
    const rows = transcriptRows(ent(
      event('tool/result', 1, {
        message: { toolCallId: 'c9', content: [] },
        error: { name: 'E', code: 'C' },
      }),
    ))
    expect(rows).toEqual([{
      kind: 'tool', seq: 1, name: 'tool', failed: true,
      detail: { error: { name: 'E', code: 'C' } },
    }])
  })

  it('attaches the result text to the paired row', () => {
    const rows = transcriptRows(ent(
      event('tool/call', 1, { name: 'bash', arguments: '{}', callId: 'c1' }),
      event('tool/result', 2, {
        message: {
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'src\n' }],
        },
      }),
    ))
    expect(rows).toEqual([{
      kind: 'tool', seq: 1, name: 'bash', failed: false,
      detail: { arguments: '{}', output: 'src\n' },
    }])
  })

  it('cuts the inherited fork seed at the last session/end-seed', () => {
    const rows = transcriptRows(ent(
      event('user/message', 1, { content: [{ type: 'text', text: '父会话的历史提问' }] }),
      event('session/end-seed', 2, {}),
      event('user/message', 3, { content: [{ type: 'text', text: '侧链提问' }] }),
      event('assistant/message', 4, { message: { content: [{ type: 'text', text: '侧链回答' }] } }),
    ))
    expect(rows).toEqual([
      { kind: 'user', seq: 3, text: '侧链提问' },
      { kind: 'assistant', seq: 4, text: '侧链回答' },
    ])
  })

  it('strips the boundary envelope and keeps the user question', () => {
    const rows = transcriptRows(ent(
      event('session/end-seed', 1, {}),
      event('user/message', 2, {
        content: [{ type: 'text', text: 'Side conversation boundary.\n\nEverything before this boundary is reference context only.\n\nMode: this is a /btw one-shot side question. Answer once.\n\n这个目录下哪个文件最大？' }],
      }),
      event('assistant/message', 3, { message: { content: [{ type: 'text', text: '好的' }] } }),
    ))
    expect(rows).toEqual([
      { kind: 'user', seq: 2, text: '这个目录下哪个文件最大？' },
      { kind: 'assistant', seq: 3, text: '好的' },
    ])
  })

  it('maps an assembled assistant message into reasoning and text rows', () => {
    const rows = transcriptRows(ent(
      event('session/end-seed', 1, {}),
      event('assistant/message', 2, {
        turn: 1, step: 1,
        message: {
          content: [
            { type: 'reasoning', text: '先想一下' },
            { type: 'text', text: '最终答案' },
          ],
        },
      }),
    ))
    expect(rows).toEqual([
      { kind: 'reasoning', seq: 2, text: '先想一下' },
      { kind: 'assistant', seq: 2, text: '最终答案' },
    ])
  })

  it('skips log detail events (turn brackets, projections)', () => {
    const rows = transcriptRows(ent(
      event('turn/start', 1, { turn: 1 }),
      event('turn/end', 3, { turn: 1, reason: 'stop' }),
      event('session/end-seed', 4, {}),
    ))
    expect(rows).toEqual([])
  })

  it('surfaces a failed turn so one-shot errors are visible', () => {
    const rows = transcriptRows(ent(
      event('session/end-seed', 1, {}),
      event('turn/end', 2, {
        turn: 1,
        reason: { kind: 'error', error: { message: 'model unavailable', code: 'MODEL_NOT_FOUND' } },
      }),
    ))
    expect(rows).toEqual([{ kind: 'error', seq: 2, text: 'model unavailable' }])
  })
})

describe('fetchTranscript', () => {
  beforeEach(() => {
    // The seed-boundary cache is module-scoped; each test starts clean.
    resetSeedBoundaryCache()
  })

  it('maps the tail snapshot to rows', async () => {
    const { follow, page } = journal(
      {
        hasMore: false,
        events: [
          event('user/message', 1, { content: [{ type: 'text', text: '嗨' }] }),
          event('assistant/message', 2, { message: { content: [{ type: 'text', text: '你好' }] } }),
        ],
      },
      // The walk only stops on a seed marker or an exhausted older window.
      { hasMore: false, events: [] },
    )
    const result = await fetchTranscript({ follow, page } as never, ADDRESS)
    expect(follow).toHaveBeenCalledWith(
      { address: { kind: 'subagent', ...ADDRESS }, maxMessages: 8 },
      expect.anything(),
    )
    expect(result).toEqual({
      rows: [
        { kind: 'user', seq: 1, text: '嗨' },
        { kind: 'assistant', seq: 2, text: '你好' },
      ],
    })
  })

  it('walks backward to the seed boundary and cuts the inherited fork seed', async () => {
    // Tail: a continuation marker followed by the newest turn.
    const { follow, page } = journal(
      {
        hasMore: true,
        cursor: 111,
        events: [
          event('session/end-seed', 100, {}),
          event('user/message', 110, { content: [{ type: 'text', text: '第二问' }] }),
          event('assistant/message', 111, { message: { content: [{ type: 'text', text: '第二个答案' }] } }),
        ],
      },
      // Older window: the initial seed + boundary + first turn.
      {
        hasMore: false,
        events: [
          event('session/end-seed', 80, {}),
          event('user/message', 81, { content: [{ type: 'text', text: 'Side conversation boundary' }] }),
          event('user/message', 90, { content: [{ type: 'text', text: '第一问' }] }),
          event('assistant/message', 91, { message: { content: [{ type: 'text', text: '第一个答案' }] } }),
        ],
      },
    )
    const result = await fetchTranscript({ follow, page } as never, ADDRESS)
    expect(page).toHaveBeenCalledWith(pageRequest(111, 8, 100))
    // Only the child's own conversation survives the cut.
    expect(result).toEqual({
      rows: [
        { kind: 'user', seq: 90, text: '第一问' },
        { kind: 'assistant', seq: 91, text: '第一个答案' },
        { kind: 'user', seq: 110, text: '第二问' },
        { kind: 'assistant', seq: 111, text: '第二个答案' },
      ],
    })
  })

  it('dedupes overlapping page boundaries when the host page is inclusive', async () => {
    const { follow, page } = journal(
      {
        hasMore: false,
        cursor: 92,
        events: [
          event('user/message', 90, { content: [{ type: 'text', text: '旧问' }] }),
          event('user/message', 92, { content: [{ type: 'text', text: '问' }] }),
        ],
      },
      // Overlapping window: repeats seq 90 before the seed boundary.
      {
        hasMore: false,
        events: [
          event('session/end-seed', 80, {}),
          event('user/message', 90, { content: [{ type: 'text', text: '旧问' }] }),
        ],
      },
    )
    const result = await fetchTranscript({ follow, page } as never, ADDRESS)
    expect(result).toEqual({
      rows: [
        { kind: 'user', seq: 90, text: '旧问' },
        { kind: 'user', seq: 92, text: '问' },
      ],
    })
  })

  it('reuses the cached seed boundary — later reads fetch no older window', async () => {
    // First read: the walk locates the boundary (the older window has it).
    const { follow, page } = journal(
      {
        hasMore: false,
        cursor: 91,
        events: [
          event('user/message', 90, { content: [{ type: 'text', text: '旧问' }] }),
          event('assistant/message', 91, { message: { content: [{ type: 'text', text: '旧答' }] } }),
        ],
      },
      {
        hasMore: false,
        events: [
          event('session/end-seed', 80, {}),
          event('user/message', 81, { content: [{ type: 'text', text: 'Side conversation boundary' }] }),
        ],
      },
    )
    const history = { follow, page } as never
    const first = await fetchTranscript(history, ADDRESS)
    expect(first).toEqual({
      rows: [
        { kind: 'user', seq: 90, text: '旧问' },
        { kind: 'assistant', seq: 91, text: '旧答' },
      ],
    })
    expect(page).toHaveBeenCalledWith(pageRequest(91, 8, 90))
    // Cached: the follow snapshot alone supplies the cut, no backward walk.
    await fetchTranscript(history, ADDRESS)
    expect(page).toHaveBeenCalledTimes(1)
  })

  it('returns null when the follow snapshot never arrives', async () => {
    const follow = () => (async function* () { yield { type: 'event' } })()
    expect(await fetchTranscript({ follow, page: vi.fn() } as never, ADDRESS)).toBeNull()
  })

  it('returns null on business failure', async () => {
    const { follow, page } = journal(
      { hasMore: true, cursor: 5, events: [event('user/message', 1, { content: [] })] },
    )
    page.mockResolvedValue({ ok: false })
    expect(await fetchTranscript({ follow, page } as never, ADDRESS)).toBeNull()
  })

  it('returns null on transport failure', async () => {
    const follow = () => (async function* (): AsyncGenerator<never> {
      throw new Error('network')
    })()
    expect(await fetchTranscript({ follow, page: vi.fn() } as never, ADDRESS)).toBeNull()
  })
})

describe('sendPrompt', () => {
  it('delivers a steering text block through subagent.prompt', async () => {
    const prompt = vi.fn(() => Promise.resolve({ ok: true }))
    const accepted = await sendPrompt({ prompt } as never, ADDRESS, '继续', REQUEST_ID)
    expect(prompt).toHaveBeenCalledWith({
      ...ADDRESS,
      requestId: REQUEST_ID,
      delivery: 'steer',
      content: [{ type: 'text', text: '继续' }],
    })
    expect(accepted).toBe(true)
  })

  it('returns false on rejection', async () => {
    const prompt = vi.fn(() => Promise.resolve({ ok: false }))
    expect(await sendPrompt({ prompt } as never, ADDRESS, '继续', REQUEST_ID)).toBe(false)
  })
})
