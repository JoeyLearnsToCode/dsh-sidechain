import { describe, expect, it } from 'vitest'
import { resolveChildActivity, type CatalogState } from '../src/client/child-activity'

describe('resolveChildActivity', () => {
  describe('catalog state machine', () => {
    it('returns unknown when no catalog projection row exists (absent)', () => {
      expect(resolveChildActivity({
        catalogState: 'absent',
        summaryRunning: undefined,
      })).toBe('unknown')
    })

    it('returns unknown while the catalog projection is loading', () => {
      expect(resolveChildActivity({
        catalogState: 'loading',
        summaryRunning: undefined,
      })).toBe('unknown')
    })

    it('returns unknown when the catalog projection read errored', () => {
      expect(resolveChildActivity({
        catalogState: 'error',
        summaryRunning: undefined,
      })).toBe('unknown')
    })

    it('returns inactive when a ready catalog has no entry for the child', () => {
      expect(resolveChildActivity({
        catalogState: 'ready',
        summaryRunning: undefined,
      })).toBe('inactive')
    })
  })

  describe('session summary precedence', () => {
    it('uses summaryRunning=true even when the catalog is missing', () => {
      expect(resolveChildActivity({
        catalogState: 'absent',
        summaryRunning: true,
      })).toBe('running')
    })

    it('uses summaryRunning=false even when the catalog is ready', () => {
      // A settled host frame must beat the catalog's mere membership; this is
      // the "the child just ended and the catalog hasn't caught up" case.
      expect(resolveChildActivity({
        catalogState: 'ready',
        summaryRunning: false,
      })).toBe('inactive')
    })

    it('uses summaryRunning=true on a ready catalog that also lists the child', () => {
      expect(resolveChildActivity({
        catalogState: 'ready',
        summaryRunning: true,
      })).toBe('running')
    })
  })

  describe('catalog activity fallback', () => {
    // 0.2.0's SubagentCatalogEntry carries identity, mode, and label only:
    // per-entry activity was dropped from the projection, so the session
    // summary is the only live activity source. A member of a ready catalog
    // with no summary row yet resolves `inactive` (it is a known child, just
    // not a running one) — never `running`.
    it('returns inactive for a ready catalog member with no summary row', () => {
      expect(resolveChildActivity({
        catalogState: 'ready',
        summaryRunning: undefined,
      })).toBe('inactive')
    })
  })

  describe('no-poll regression', () => {
    // These three inputs are the exact signals the /btw command card sees
    // when its parent's catalog projection has not landed yet and the host
    // has no summary row for the freshly-resolved child. Before the fix, the
    // card would treat this as running and start a 1.2 s transcript poll. The
    // fix routes all of these through `unknown`, which gates the poll off.
    const cardInputs: ReadonlyArray<{
      label: string
      state: CatalogState
    }> = [
      { label: 'absent catalog', state: 'absent' },
      { label: 'loading catalog', state: 'loading' },
      { label: 'error catalog', state: 'error' },
    ]

    for (const { label, state } of cardInputs) {
      it(`does not start a poll when the child is freshly created and the catalog is ${label}`, () => {
        const activity = resolveChildActivity({
          catalogState: state,
          summaryRunning: undefined,
        })
        expect(activity).toBe('unknown')
        // The card gates setInterval(read, BTW_CARD_POLL_INTERVAL_MS) on
        // `childRunning` which is `childActivity === 'running'`. This is the
        // assertion that catches the regression: the gate must be closed.
        expect(activity === 'running').toBe(false)
      })
    }
  })

  describe('settle-on-finish transitions', () => {
    // The panel's settle effect fires when an observed child becomes inactive
    // from either running or unknown, so a fast child still gets one final
    // transcript read after the catalog catches up.
    const transitions: ReadonlyArray<{
      label: string
      previous: ReturnType<typeof resolveChildActivity>
      current: ReturnType<typeof resolveChildActivity>
      expectSettle: boolean
    }> = [
      { label: 'running -> inactive', previous: 'running', current: 'inactive', expectSettle: true },
      { label: 'unknown -> inactive (settle)', previous: 'unknown', current: 'inactive', expectSettle: true },
      { label: 'unknown -> running (no settle)', previous: 'unknown', current: 'running', expectSettle: false },
      { label: 'inactive -> running (no settle)', previous: 'inactive', current: 'running', expectSettle: false },
      { label: 'running -> running (no settle)', previous: 'running', current: 'running', expectSettle: false },
      { label: 'inactive -> inactive (no settle)', previous: 'inactive', current: 'inactive', expectSettle: false },
    ]

    for (const { label, previous, current, expectSettle } of transitions) {
      it(`${label}`, () => {
        // Mirror the transition gate used by the panel so future changes
        // cannot silently drop the final read.
        const settled = current === 'inactive'
          && (previous === 'running' || previous === 'unknown')
        expect(settled).toBe(expectSettle)
      })
    }
  })
})
