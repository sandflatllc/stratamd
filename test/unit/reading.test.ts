import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_READING_STATE, normalizeReadingState, readReadingState, writeReadingState } from '../../src/main/reading'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stratamd-reading-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('per-document reading state', () => {
  it('defaults missing and disposable malformed or newer state', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'entry', 'reading.json')
    expect(await readReadingState(path)).toEqual(DEFAULT_READING_STATE)
    await writeReadingState(path, DEFAULT_READING_STATE)
    await writeFile(path, '{ broken')
    expect(await readReadingState(path)).toEqual(DEFAULT_READING_STATE)
    await writeFile(path, JSON.stringify({ formatVersion: 99, navigationTab: 'contents' }))
    expect(await readReadingState(path)).toEqual(DEFAULT_READING_STATE)
  })

  it('normalizes closed tab names and writes atomically with private mode', async () => {
    expect(normalizeReadingState({ formatVersion: 1, navigationTab: 'future', reviewTab: 'future' })).toEqual(DEFAULT_READING_STATE)
    const directory = await temporaryDirectory()
    const path = join(directory, 'one', 'reading.json')
    await writeReadingState(path, { formatVersion: 4, navigationTab: 'contents', reviewTab: 'annotations', walkthrough: { active: false, level: 'h2', current: null, excluded: [], markers: [] }, tables: [], foldedHeadings: [] })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ formatVersion: 4, navigationTab: 'contents', reviewTab: 'annotations', walkthrough: { active: false, level: 'h2', current: null, excluded: [], markers: [] }, tables: [], foldedHeadings: [] })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('migrates version 2 walkthrough state to version 4 table and fold defaults', () => {
    expect(normalizeReadingState({
      formatVersion: 2,
      navigationTab: 'contents',
      reviewTab: 'annotations',
      walkthrough: { active: true, level: 'h2-h3', current: null, excluded: [], markers: [] },
    })).toEqual({
      formatVersion: 4,
      navigationTab: 'contents',
      reviewTab: 'annotations',
      walkthrough: { active: true, level: 'h2-h3', current: null, excluded: [], markers: [] },
      tables: [],
      foldedHeadings: [],
    })
  })

  it('normalizes bounded table state and discards malformed table identities', () => {
    const table = { headingLevel: 2, headingText: '  Islands  ', headers: [' Name ', 'Score'], occurrence: 0 }
    const normalized = normalizeReadingState({
      formatVersion: 3,
      tables: [{
        table,
        presentation: 'compare',
        sort: { column: 1, direction: 'descending' },
        filter: { column: 0, query: 'gap' },
        hiddenColumns: [1, 1, 99],
        selectedRows: [4, 4, -1],
        focusedRow: 4,
        focusedColumn: 1,
        density: 'compact',
        columnWidths: [20, Number.NaN],
      }, { table: { ...table, headers: [] } }],
    })
    expect(normalized.tables).toEqual([{
      table: { headingLevel: 2, headingText: 'Islands', headers: ['Name', 'Score'], occurrence: 0 },
      presentation: 'compare',
      sort: { column: 1, direction: 'descending' },
      filter: { column: 0, query: 'gap' },
      hiddenColumns: [1],
      selectedRows: [4],
      focusedRow: 4,
      focusedColumn: 1,
      density: 'compact',
      columnWidths: [80, 180],
    }])
  })

  it('migrates version 3 with conservative all-level folded heading references', () => {
    const folded = { level: 4, text: 'Details', parentText: 'Section', previousText: 'Before', nextText: null }
    expect(normalizeReadingState({ formatVersion: 3, foldedHeadings: [folded, folded, { ...folded, level: 9 }] }).foldedHeadings).toEqual([folded])
  })
})
