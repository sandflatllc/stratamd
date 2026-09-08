import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import * as markdown from '../../src/core/markdown'
import { fixture } from './support/cockpit'

afterEach(() => vi.restoreAllMocks())
const source = '# Plan\n\nFirst line.\nUnchanged middle line.\nSecond line.\n\nSeparate paragraph.\n'
const rangesFor = (text: string) => markdown.parseMarkdown(text).blocks.map(({ span }) => ({ from: span.start.offset, to: span.end.offset }))

it.each(['buffer', 'disk'] as const)('reuses an exact same-content snapshot for an external %s edit and falls back for the next base', async (kind) => {
  const { app, path, store } = await fixture(source)
  await app.openDocument(path)
  const ranges = rangesFor(source)
  await app.updateBuffer(path, source, 'edit', ranges)
  const parse = vi.spyOn(markdown, 'parseMarkdown')
  const next = source.replace('Separate paragraph.', 'External paragraph.')
  if (kind === 'buffer') await store.writeBuffer(path, next)
  else await writeFile(path, next)
  await app.recheckFocused()
  expect((await app.getState()).activeDocument?.content).toBe(next)
  expect(parse.mock.calls.filter(([text]) => text === source)).toHaveLength(0)

  parse.mockClear()
  const again = next.replace('External paragraph.', 'Another external paragraph.')
  if (kind === 'buffer') await store.writeBuffer(path, again)
  else await writeFile(path, again)
  await app.recheckFocused()
  expect((await app.getState()).activeDocument?.content).toBe(again)
  expect(parse.mock.calls.some(([text]) => text === next)).toBe(true)
})

it.each(['exact', 'stale', 'absent'] as const)('preserves whole-paragraph conflict widening with %s ranges', async (snapshot) => {
  const { app, path, store } = await fixture(source)
  await app.openDocument(path)
  if (snapshot === 'exact') await app.updateBuffer(path, source, 'edit', rangesFor(source))
  const local = source.replace('First line.', 'User first line.')
  // Disk remains the old base even after the user edit has been mirrored.
  await app.updateBuffer(path, local, 'edit', snapshot === 'stale' ? rangesFor(local) : undefined)
  await expect.poll(async () => (await store.readBuffer(path))?.toString('utf8')).toBe(local)
  await writeFile(path, source.replace('Second line.', 'External second line.'))
  await app.recheckFocused()
  const state = (await app.getState()).activeDocument!
  expect(state.content).toBe(local)
  expect(state.conflicts).toHaveLength(1)
  expect(state.conflicts[0]?.incoming).toContain('External second line.')
})
