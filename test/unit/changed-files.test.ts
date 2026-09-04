import { describe, expect, it } from 'vitest'
import { changedFilesLabel, describeChangedFile, formatDelta, relativeChangedPath, summarizeChangedFiles } from '../../src/core/changed-files'

// PRD §6.9: a turn's changed files show as a count, a delta, top-level folders,
// a short preview, and the full list on request, never as a wall of absolute paths.
const file = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions, markdown: /\.md$/.test(path) })

describe('changed files', () => {
  it('formats deltas the way T3 does', () => {
    expect(formatDelta(0)).toBe('0')
    expect(formatDelta(999)).toBe('999')
    expect(formatDelta(1_000)).toBe('1k')
    expect(formatDelta(4_412)).toBe('4.4k')
    expect(formatDelta(3_250)).toBe('3.3k')
    expect(formatDelta(12_400)).toBe('12k')
  })

  it('reads paths relative to the workspace root and keeps outsiders absolute', () => {
    expect(relativeChangedPath('/home/o/Mesa/packages/api/a.ts', '/home/o/Mesa')).toBe('packages/api/a.ts')
    expect(relativeChangedPath('/home/o/Mesa/packages/api/a.ts', '/home/o/Mesa/')).toBe('packages/api/a.ts')
    expect(relativeChangedPath('/home/o/Mesabis/a.ts', '/home/o/Mesa')).toBe('/home/o/Mesabis/a.ts')
    expect(relativeChangedPath('/tmp/x.md', null)).toBe('/tmp/x.md')
    expect(describeChangedFile(file('/home/o/Mesa/packages/api/routes/a.test.ts'), '/home/o/Mesa')).toMatchObject({ name: 'a.test.ts', directory: 'packages/api/routes', extension: 'ts' })
    expect(describeChangedFile(file('/home/o/Mesa/README'), '/home/o/Mesa')).toMatchObject({ name: 'README', directory: '', extension: '' })
  })

  it('groups by top-level folder, largest first, sums duplicates, and previews three', () => {
    const summary = summarizeChangedFiles([
      file('/r/packages/api/b.ts', 10, 2),
      file('/r/packages/api/a.ts', 5, 1),
      file('/r/docs/plan.md', 3, 0),
      file('/r/packages/web/c.tsx', 2, 2),
      file('/r/packages/api/a.ts', 1, 1),
      file('/r/top.md', 0, 4),
      file('/elsewhere/z.ts', 1, 0),
    ], '/r')
    expect(summary.count).toBe(6)
    expect(summary.additions).toBe(22)
    expect(summary.deletions).toBe(10)
    expect(summary.groups.map((group) => [group.label, group.files.length])).toEqual([['packages', 3], ['.', 1], ['/elsewhere', 1], ['docs', 1]])
    expect(summary.groups[0]!.files.map((entry) => entry.relative)).toEqual(['packages/api/a.ts', 'packages/api/b.ts', 'packages/web/c.tsx'])
    expect(summary.groups[0]!.files[0]).toMatchObject({ additions: 6, deletions: 2 })
    expect(summary.preview.map((entry) => entry.name)).toEqual(['a.ts', 'b.ts', 'c.tsx'])
    expect(changedFilesLabel(1)).toBe('1 changed file')
    expect(changedFilesLabel(90)).toBe('90 changed files')
  })
})
