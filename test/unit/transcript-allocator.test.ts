import { describe, expect, it } from 'vitest'
import { allocateTranscriptEditors, idleCandidate, type AllocationRow } from '../../src/renderer/transcriptAllocator'

function rows(count: number, height: number, overrides: Partial<Record<number, Partial<AllocationRow>>> = {}): AllocationRow[] {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index}`, pinned: false, top: index * height, bottom: index * height + height, editor: false, lastVisible: -Infinity, ...overrides[index] }))
}

describe('transcript editor allocation', () => {
  it('keeps mandatory pins first, then visible rows nearest the reading edge, then rows ahead', () => {
    const plan = allocateTranscriptEditors({ rows: rows(40, 300, { 30: { pinned: true }, 2: { pinned: true } }), viewportTop: 3000, viewportHeight: 900, direction: 1, limit: 11 })
    expect(plan.keep.slice(0, 2)).toEqual(['m2', 'm30'])
    expect(plan.keep.slice(2, 5)).toEqual(['m10', 'm11', 'm12'])
    expect(plan.keep.slice(5)).toEqual(['m13', 'm14', 'm15', 'm16'])
    expect(plan.prepare).toEqual(plan.keep)
    expect(plan.release).toEqual([])
    expect(plan.overflow).toBe(false)
  })

  it('prefers rows behind the reader when travelling up and retains recently visited editors within three viewports', () => {
    const input = rows(40, 300, { 20: { editor: true, lastVisible: 10 }, 22: { editor: true, lastVisible: 12 }, 39: { editor: true, lastVisible: 1 } })
    const plan = allocateTranscriptEditors({ rows: input, viewportTop: 3000, viewportHeight: 900, direction: -1, limit: 11 })
    expect(plan.keep.slice(0, 3)).toEqual(['m10', 'm11', 'm12'])
    expect(plan.keep.slice(3, 7)).toEqual(['m9', 'm8', 'm7', 'm6'])
    expect(plan.keep.slice(7)).toEqual(['m22', 'm20'])
    expect(plan.release).toEqual(['m39'])
  })

  it('never releases a visible or pinned editor and reports overflow when pins alone exceed the limit', () => {
    const many = rows(20, 100, Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index, { pinned: true, editor: true }])))
    const plan = allocateTranscriptEditors({ rows: many, viewportTop: 1500, viewportHeight: 300, direction: 0, limit: 11 })
    expect(plan.overflow).toBe(true)
    expect(plan.keep).toHaveLength(13)
    expect(plan.prepare).toEqual([])
    expect(plan.release).toEqual([])
    const full = rows(30, 60, { 5: { editor: true } })
    const crowded = allocateTranscriptEditors({ rows: full, viewportTop: 0, viewportHeight: 900, direction: 1, limit: 11 })
    expect(crowded.keep).toHaveLength(11)
    expect(crowded.keep[0]).toBe('m5')
    expect(crowded.release).toEqual([])
  })

  it('names one nearest unmeasured row for idle work only while a slot is spare', () => {
    const input = rows(10, 500, { 3: { editor: true } })
    const unmeasured = new Set(['m0', 'm6', 'm8'])
    expect(idleCandidate({ rows: input, viewportTop: 1600, viewportHeight: 500, direction: 0, limit: 11, unmeasured, keepCount: 3 })).toBe('m6')
    expect(idleCandidate({ rows: input, viewportTop: 1500, viewportHeight: 500, direction: 0, limit: 11, unmeasured, keepCount: 11 })).toBeNull()
    expect(idleCandidate({ rows: input, viewportTop: 1500, viewportHeight: 500, direction: 0, limit: 11, unmeasured: new Set(['m3']), keepCount: 1 })).toBeNull()
  })
})
