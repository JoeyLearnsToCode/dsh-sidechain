/**
 * Unit tests for the sidechain panel's row derivation helpers.
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { runningCount, sidechainRows, type SidechainCatalog } from '../src/client/SidechainPanel'

const PARENT = 'parent-1' as SessionId
const CHILD_A = '11111111-1111-4111-8111-111111111111' as SessionId
const CHILD_B = '22222222-2222-4222-8222-222222222222' as SessionId

/** One catalog entry of the projection (`createdAt` is the projection's own). */
function entry(input: Omit<SubagentCatalogEntry, 'createdAt'>): SubagentCatalogEntry {
  return { createdAt: 0, ...input } as SubagentCatalogEntry
}

/** One session-list row with only the fields these helpers read spelled out. */
function summary(id: SessionId, input: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, displayTitle: String(id), running: false, retainedBy: {}, blank: false, updatedAt: 0,
    ...input,
  }
}

function snapshot(entries: readonly SubagentCatalogEntry[]): SidechainCatalog {
  return { state: 'ready', entries }
}

describe('sidechainRows', () => {
  it('returns [] for an absent catalog', () => {
    expect(sidechainRows(undefined, {})).toEqual([])
  })

  it('resolves child labels: entry label, then summary title, then id', () => {
    const rows = sidechainRows(snapshot([
      entry({ id: CHILD_A, mode: 'continuable', label: '调研 X' }),
      entry({ id: CHILD_B, mode: 'one-shot' }),
    ]), {
      // The projection carries no activity: a row's activity is the child's
      // own session-summary running bit.
      [CHILD_A]: summary(CHILD_A, { title: '调研 X', displayTitle: '调研 X', running: true }),
      [CHILD_B]: summary(CHILD_B, { title: '问答标题', displayTitle: '问答标题' }),
    })
    expect(rows).toEqual([
      { kind: 'child', id: CHILD_A, mode: 'continuable', activity: 'running', label: '调研 X' },
      { kind: 'child', id: CHILD_B, mode: 'one-shot', activity: 'inactive', label: '问答标题' },
    ])
  })

  it('reports a child with no summary row as inactive, never running', () => {
    const rows = sidechainRows(snapshot([
      entry({ id: CHILD_A, mode: 'one-shot' }),
    ]), {})
    expect(rows[0]).toMatchObject({ kind: 'child', activity: 'inactive' })
  })

  it('falls back to the session id without any title source', () => {
    const rows = sidechainRows(snapshot([
      entry({ id: CHILD_A, mode: 'one-shot' }),
    ]), {})
    expect(rows[0]).toEqual({ kind: 'child', id: CHILD_A, mode: 'one-shot', activity: 'inactive', label: CHILD_A })
  })

  it('renders an unclassifiable entry as an unsupported diagnostic', () => {
    // `mode: 'unknown'` is the projection's "the host could not resolve this
    // child's mode" arm; the platform's own descendant listing reports it as
    // an `unsupported` diagnostic, so the panel does the same instead of
    // offering a child it cannot address correctly.
    const rows = sidechainRows(snapshot([
      entry({ id: CHILD_A, mode: 'unknown', label: '不明' }),
    ]), {})
    expect(rows).toEqual([{ kind: 'diagnostic', id: CHILD_A, reason: 'unsupported' }])
  })
})

describe('runningCount', () => {
  it('counts only running child rows', () => {
    const rows = sidechainRows(snapshot([
      entry({ id: CHILD_A, mode: 'continuable', label: 'a' }),
      entry({ id: CHILD_B, mode: 'one-shot' }),
      entry({ id: PARENT, mode: 'unknown' }),
    ]), {
      [CHILD_A]: summary(CHILD_A, { running: true }),
    })
    expect(runningCount(rows)).toBe(1)
  })
})
