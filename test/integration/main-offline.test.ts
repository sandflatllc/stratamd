import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandFailure, PROTOCOL_VERSION, type CommandName, type CommandRequest } from '../../src/cli/protocol.js'
import { createOfflineCommandHandler } from '../../src/main/offline.js'
import { GhostStore } from '../../src/main/storage.js'

const temporaryDirectories: string[] = []
const context = {
  connectionId: 'offline-test',
  signal: new AbortController().signal,
}

async function fixture(content: string): Promise<{
  directory: string
  file: string
  store: GhostStore
}> {
  const directory = await mkdtemp(join(tmpdir(), 'stratamd-offline-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'document.md')
  await writeFile(file, content)
  return { directory, file, store: new GhostStore({ dataDirectory: join(directory, 'data') }) }
}

function request<C extends CommandName>(command: C, args: CommandRequest<C>['args']): CommandRequest<C> {
  return { version: PROTOCOL_VERSION, id: `request-${command}`, command, args } as CommandRequest<C>
}

function ids(): (prefix: 'a' | 'r') => string {
  let next = 0
  return (prefix) => `${prefix}${++next}`
}

async function filesystemSnapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relative = path.slice(root.length + 1)
      const metadata = await stat(path)
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: 'directory', mode: metadata.mode & 0o777, mtimeMs: metadata.mtimeMs })
        await visit(path)
      } else {
        entries.push({
          path: relative,
          type: 'file',
          mode: metadata.mode & 0o777,
          mtimeMs: metadata.mtimeMs,
          content: await readFile(path, 'utf8'),
        })
      }
    }
  }
  await visit(root)
  return entries
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('offline main-process commands', () => {
  it('reads state without creating or changing ghost-store files', async () => {
    const { directory, file, store } = await fixture('# Disk\n\nDisk wording.\n')
    const withLock = vi.spyOn(store, 'withLock')
    const handler = createOfflineCommandHandler({ store })
    const dataDirectory = join(directory, 'data')

    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })

    const first = await handler(request('state', { file }), context) as Record<string, unknown>
    const buffer = first.buffer as string
    expect(first).toMatchObject({
      version: 11,
      event: 'state',
      file,
      document: '# Disk\n\nDisk wording.\n',
    })
    expect(first).not.toHaveProperty('agent')
    expect(first.text).toContain(`Write only to ${buffer}.`)
    expect(buffer).toMatch(/\/docs\/[0-9a-f]{12}\/buffer\.md$/)
    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })

    const base = Date.now() / 1_000
    await mkdir(dirname(buffer), { recursive: true })
    await writeFile(buffer, '# Buffer\n\nUnsaved wording.\n')
    await utimes(buffer, base + 10, base + 10)
    const beforeBufferState = await filesystemSnapshot(dataDirectory)
    const buffered = await handler(request('state', { file }), context) as Record<string, unknown>
    expect(buffered.document).toBe('# Buffer\n\nUnsaved wording.\n')
    expect(await filesystemSnapshot(dataDirectory)).toEqual(beforeBufferState)

    await writeFile(file, '# New disk\n')
    await utimes(file, base + 20, base + 20)
    const beforeDiskState = await filesystemSnapshot(dataDirectory)
    const disk = await handler(request('state', { file }), context) as Record<string, unknown>
    expect(disk.document).toBe('# New disk\n')
    expect(await readFile(buffer, 'utf8')).toBe('# Buffer\n\nUnsaved wording.\n')
    expect(await filesystemSnapshot(dataDirectory)).toEqual(beforeDiskState)
    expect(withLock).not.toHaveBeenCalled()
  })

  it('does not move persisted attachment baselines or cursors', async () => {
    const { directory, file, store } = await fixture('Reviewed text.\n')
    const handler = createOfflineCommandHandler({ store })
    await handler(request('checkpoint', { file }), context)
    const meta = await store.loadMeta(file)
    await store.saveMeta({
      ...meta,
      attachments: {
        ag_waiting: {
          id: 'ag_waiting',
          name: 'Waiting agent',
          attachedAt: 10,
          lastCallAt: 20,
          waiting: false,
          baselineBlob: meta.ghostBlob,
          segmentIndex: 3,
          deliveries: [],
          cursor: 7,
        },
      },
    })

    const dataDirectory = join(directory, 'data')
    const before = await filesystemSnapshot(dataDirectory)
    const state = await handler(request('state', { file }), context) as { event: string }
    expect(state.event).toBe('state')
    expect(await filesystemSnapshot(dataDirectory)).toEqual(before)

    const unchanged = await store.loadMeta(file)
    expect(unchanged.attachments.ag_waiting).toMatchObject({
      baselineBlob: meta.ghostBlob,
      segmentIndex: 3,
      cursor: 7,
    })
  })

  it('validates an annotation batch before its one metadata commit and persists replies', async () => {
    const { file, store } = await fixture('First same phrase.\n\nSecond same phrase.\n')
    const handler = createOfflineCommandHandler({ store, createId: ids() })

    const invalid = request('annotate', {
      file,
      agent: 'ag_test',
      annotations: [
        { kind: 'comment', quote: 'First', text: 'This one is valid.' },
        { kind: 'question', quote: 'missing phrase', text: 'Where is it?' },
        { kind: 'comment', quote: 'same phrase', text: 'Which one?' },
      ],
    })
    await expect(handler(invalid, context)).rejects.toMatchObject({
      exitCode: 3,
      code: 'QUOTE_INVALID',
      detail: [
        expect.objectContaining({
          index: 1,
          code: 'quote_missing',
          matches: expect.arrayContaining([expect.stringContaining('First same phrase.')]),
        }),
        expect.objectContaining({
          index: 2,
          code: 'quote_ambiguous',
          matches: expect.arrayContaining([expect.stringContaining('same phrase')]),
        }),
      ],
    })
    const afterFailure = await store.loadMeta(file) as unknown as {
      annotations?: Record<string, unknown>
      readonly annotationEvents: readonly unknown[]
    }
    expect(afterFailure.annotations).toBeUndefined()
    expect(afterFailure.annotationEvents).toEqual([])

    await handler(request('annotate', {
      file,
      agent: 'ag_test',
      annotations: [{
        kind: 'question',
        quote: 'same phrase',
        text: 'Can this be specific?',
        precededBy: 'First ',
      }],
    }), context)
    const annotated = await handler(request('state', { file }), context) as {
      annotations: Array<{ id: string; seq: number; replies: unknown[] }>
      cursor: number
    }
    expect(annotated.annotations).toEqual([
      expect.objectContaining({ id: 'a4', seq: 1, replies: [] }),
    ])
    expect(annotated.cursor).toBe(1)

    await handler(request('reply', {
      file,
      agent: 'ag_reply',
      annotation: 'a4',
      text: 'It can.',
    }), context)
    const replied = await handler(request('state', { file }), context) as {
      annotations: Array<{ replies: Array<Record<string, unknown>> }>
      cursor: number
    }
    expect(replied.cursor).toBe(2)
    expect(replied.annotations[0]?.replies).toEqual([
      expect.objectContaining({ id: 'r5', seq: 2, agent: 'ag_reply', text: 'It can.' }),
    ])
    await expect(handler(request('reply', {
      file,
      agent: 'ag_reply',
      annotation: 'absent',
      text: 'No thread.',
    }), context)).rejects.toMatchObject({ exitCode: 2, code: 'ANNOTATION_NOT_FOUND' })
  })

  it('renders ghost-relative external changes with an unexpired pending tag', async () => {
    const { file, store } = await fixture('# Plan\n\nShip Tuesday.\n')
    const clock = 1_800_000_000_000
    const handler = createOfflineCommandHandler({ store, now: () => clock })

    await handler(request('checkpoint', { file }), context)
    await handler(request('changed', { file, agent: 'ag_editor', name: 'Editor' }), context)
    const buffer = store.pathsForDocument(file).buffer
    const bufferMtime = (await stat(buffer)).mtimeMs / 1_000
    await writeFile(file, '# Plan\n\nShip Thursday.\n')
    await utimes(file, bufferMtime + 10, bufferMtime + 10)

    const changes = await handler(request('changes', { file }), context) as {
      event: string
      segments: Array<{ author: string; tag?: unknown; hunks: Array<Record<string, unknown>> }>
      text: string
    }
    expect(changes.event).toBe('changes')
    expect(changes.segments).toEqual([{
      author: 'external',
      tag: { agent: 'ag_editor', name: 'Editor' },
      hunks: [expect.objectContaining({
        oldStart: 3,
        newStart: 3,
        removed: ['Ship Tuesday.'],
        added: ['Ship Thursday.'],
      })],
    }])
    expect(changes.text).toContain('Changes by Editor (ag_editor):')

    await handler(request('checkpoint', { file }), context)
    const reviewed = await handler(request('changes', { file }), context) as { segments: unknown[] }
    expect(reviewed.segments).toEqual([])
  })

  it('makes directory checkpoint match Scan and forgets entries under the document lock', async () => {
    const { directory, file, store } = await fixture('first\n')
    const nested = join(directory, 'notes')
    await mkdir(nested)
    const second = join(nested, 'second.markdown')
    const ignored = join(nested, 'ignored.txt')
    await writeFile(second, 'second\n')
    await writeFile(ignored, 'ignored\n')
    const handler = createOfflineCommandHandler({ store })
    const withLock = vi.spyOn(store, 'withLock')

    await handler(request('checkpoint', { file: directory }), context)
    expect(await store.hasDocument(file)).toBe(true)
    expect(await store.hasDocument(second)).toBe(true)
    expect(await store.hasDocument(ignored)).toBe(false)

    const firstGhost = (await store.loadMeta(file)).ghostBlob
    await writeFile(file, 'changed after review\n')
    await handler(request('checkpoint', { file: directory }), context)
    expect((await store.loadMeta(file)).ghostBlob).toBe(firstGhost)

    await handler(request('forget', { file }), context)
    expect(await store.hasDocument(file)).toBe(false)
    expect(withLock.mock.calls.some(([path]) => path === file)).toBe(true)
    expect(withLock.mock.calls.some(([path]) => path === second)).toBe(true)
  })

  it('reports fileless state and unsupported offline commands with protocol exit codes', async () => {
    const { directory, file, store } = await fixture('text\n')
    const handler = createOfflineCommandHandler({ store, lockTimeoutMs: 0 })
    const dataDirectory = join(directory, 'data')

    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(handler(request('state', {}), context)).rejects.toEqual(
      new CommandFailure('No document is open and no file was supplied', 2, 'NOT_FOUND'),
    )
    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(handler(request('open', { file }), context)).rejects.toMatchObject({
      exitCode: 4,
      code: 'INSTANCE_UNREACHABLE',
    })
  })
})
