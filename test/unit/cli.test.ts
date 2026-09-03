import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_HELP } from '../../src/cli/agent-help.js'
import { deriveAgentId, runCli, sessionAgentId, type CliRuntime } from '../../src/cli/commands.js'
import { PAYLOAD_VERSION } from '../../src/core/payload.js'
import { CommandFailure, PROTOCOL_VERSION, type CommandRequest, type CommandResponse } from '../../src/cli/protocol.js'
import { SocketTimeoutError, SocketUnavailableError, socketPathForEnvironment } from '../../src/cli/socket-client.js'
import { setup, type SetupCommandRunner } from '../../src/cli/setup.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function captureIo(stdin = ''): { runtime: CliRuntime; stdout: () => string; stderr: () => string } {
  let output = ''
  let errors = ''
  const writer = (append: (value: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(chunk.toString())
        callback()
      }
    })
  return {
    runtime: {
      io: {
        stdin: Readable.from([stdin]),
        stdout: writer((value) => (output += value)),
        stderr: writer((value) => (errors += value))
      }
    },
    stdout: () => output,
    stderr: () => errors
  }
}

async function document(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stratamd-cli-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'document.md')
  await writeFile(file, '# Test\n', 'utf8')
  return file
}

describe('agent contract', () => {
  it('prints section 7 verbatim', async () => {
    const prd = await readFile(join(process.cwd(), 'docs', 'PRD.md'), 'utf8')
    const contract = prd.match(/## 7\. Agent contract[\s\S]*?```\n([\s\S]*?)\n```/)?.[1]
    expect(contract).toBe(AGENT_HELP)
    // A timeout is not an action: the contract says so in the loop and in the chat-conduct block.
    expect(AGENT_HELP).toContain('run it again and say nothing about it in chat')
    expect(AGENT_HELP).toContain('What to say in chat:')

    const io = captureIo()
    expect(await runCli(['--agent-help'], io.runtime)).toBe(0)
    expect(io.stdout()).toBe(`${contract}\n`)
    expect(io.stderr()).toBe('')
  })

  it('derives a stable opaque identity from a harness session', () => {
    const first = deriveAgentId({ CLAUDE_CODE_SESSION_ID: 'session-secret' })
    expect(first).toBe(deriveAgentId({ CLAUDE_CODE_SESSION_ID: 'session-secret' }))
    expect(first).toMatch(/^ag_[a-f0-9]{12}$/)
    expect(first).not.toContain('session-secret')
    expect(sessionAgentId({ CLAUDE_CODE_SESSION_ID: 'session-secret' })).toBe(first)
    expect(sessionAgentId({})).toBeUndefined()
  })

  it('requires a provable identity for every command except a first attach', async () => {
    const file = await document()
    const sent: CommandRequest[] = []
    const runtime = (io: ReturnType<typeof captureIo>, environment: NodeJS.ProcessEnv = {}): CliRuntime => ({
      ...io.runtime,
      environment,
      request: async (request): Promise<CommandResponse> => {
        sent.push(request)
        return { version: PROTOCOL_VERSION, id: request.id, ok: true, result: { done: true } }
      }
    })

    for (const argv of [
      ['annotate', file, '--kind', 'comment', '--quote', 'Test'],
      ['edit', file, '--match', 'Test', '--replace', 'Tested'],
      ['pin', file, '--component', '3', '--x', '25', '--y', '75', '--note', 'Inspect this'],
      ['reply', file, '--to', 'a1', '--text', 'Done'],
      ['answer', file, '--decision', 'd1', '--choice', 'Yes'],
      ['send', file, '--text', 'ping'],
      ['lead', file],
      ['accept', file, '--annotation', 'a1'],
      ['reject', file, '--annotation', 'a1'],
      ['resolve', file, '--annotation', 'a1'],
      ['save', file],
      ['changed', file],
      ['detach', file],
    ]) {
      const io = captureIo()
      expect(await runCli(argv, runtime(io)), argv[0]).toBe(1)
      expect(JSON.parse(io.stderr()), argv[0]).toMatchObject({
        code: 'USAGE',
        error: 'Pass --as <the agent id your first attach returned>'
      })
    }
    expect(sent).toEqual([])

    // A harness session supplies the id for every one of them.
    const harness = { CLAUDE_CODE_SESSION_ID: 'session-secret' }
    const derived = sessionAgentId(harness)!
    const harnessed = captureIo()
    expect(await runCli(['lead', file], runtime(harnessed, harness))).toBe(0)
    expect(sent.at(-1)?.args).toMatchObject({ agent: derived })

    // Only a first attach may mint a fresh id.
    const minted = captureIo()
    expect(await runCli(['attach', file, '--timeout', '0'], runtime(minted))).toBe(0)
    expect((sent.at(-1)?.args as { agent: string }).agent).toMatch(/^ag_/)

    // Read commands need no id at all.
    for (const argv of [['state', file], ['changes', file], ['docs'], ['checkpoint', file]]) {
      const io = captureIo()
      expect(await runCli(argv, runtime(io)), argv[0]).toBe(0)
    }
  })
})

describe('command parsing and output', () => {
  it('launches the desktop app when invoked without a command', async () => {
    let launches = 0
    const io = captureIo()
    expect(
      await runCli([], {
        ...io.runtime,
        launchApp: async () => {
          launches += 1
        }
      })
    ).toBe(0)
    expect(launches).toBe(1)
    expect(io.stdout()).toBe('')
  })

  it('canonicalizes paths and sends attach defaults', async () => {
    const file = await document()
    let sent: CommandRequest | undefined
    const io = captureIo()
    const code = await runCli(['attach', file, '--as', 'ag_test', '--name', 'Reviewer', '--timeout', '0'], {
      ...io.runtime,
      request: async (request): Promise<CommandResponse> => {
        sent = request
        return {
          version: PROTOCOL_VERSION,
          id: request.id,
          ok: true,
          result: { version: PROTOCOL_VERSION, event: 'timeout', agent: 'ag_test' }
        }
      }
    })

    expect(code).toBe(0)
    expect(sent?.command).toBe('attach')
    expect(sent?.args).toEqual({ file, agent: 'ag_test', name: 'Reviewer', timeout: 0 })
    expect(JSON.parse(io.stdout())).toMatchObject({ version: PROTOCOL_VERSION, event: 'timeout' })
  })

  it('launches the desktop app for open without a file, as the desktop entry does', async () => {
    let launches = 0
    let requests = 0
    const io = captureIo()
    expect(
      await runCli(['open'], {
        ...io.runtime,
        launchApp: async () => { launches += 1 },
        request: async () => { requests += 1; throw new SocketUnavailableError('unused', 'ENOENT') }
      })
    ).toBe(0)
    expect(launches).toBe(1)
    expect(requests).toBe(0)
    expect(io.stdout()).toBe('')
    expect(io.stderr()).toBe('')
  })

  it('launches the app and retries open when no instance is running', async () => {
    const file = await document()
    let calls = 0
    let launches = 0
    const io = captureIo()
    const code = await runCli(['open', file], {
      ...io.runtime,
      launchApp: async () => {
        launches += 1
      },
      request: async (request) => {
        calls += 1
        if (calls === 1) throw new SocketUnavailableError('not running', 'ENOENT')
        return { version: PROTOCOL_VERSION, id: request.id, ok: true }
      }
    })
    expect(code).toBe(0)
    expect(launches).toBe(1)
    expect(calls).toBe(2)
  })

  it('reads multiline reply text from stdin', async () => {
    const file = await document()
    let sent: CommandRequest | undefined
    const io = captureIo('first line\nsecond line\n')
    expect(
      await runCli(['reply', file, '--to', 'a1', '--text', '-', '--as', 'ag_test'], {
        ...io.runtime,
        request: async (request) => {
          sent = request
          return { version: PROTOCOL_VERSION, id: request.id, ok: true }
        }
      })
    ).toBe(0)
    expect(sent?.args).toMatchObject({ annotation: 'a1', text: 'first line\nsecond line\n' })
    expect(io.stdout()).toBe('{"ok":true}\n')
    expect(io.stderr()).toBe('')
  })

  it('reads multiline annotation text from stdin without changing it', async () => {
    const file = await document()
    let sent: CommandRequest | undefined
    const io = captureIo('first line\n\nthird line\n')
    expect(
      await runCli(['annotate', file, '--kind', 'comment', '--quote', 'Test', '--text', '-', '--as', 'ag_test'], {
        ...io.runtime,
        request: async (request) => {
          sent = request
          return { version: PROTOCOL_VERSION, id: request.id, ok: true }
        }
      })
    ).toBe(0)
    expect(sent?.args).toMatchObject({
      annotations: [{ kind: 'comment', quote: 'Test', text: 'first line\n\nthird line\n' }]
    })
    expect(io.stdout()).toBe('{"ok":true}\n')
    expect(io.stderr()).toBe('')
  })

  it('parses decision choices and exactly one explicit anchor', async () => {
    const file = await document()
    let sent: CommandRequest | undefined
    const io = captureIo()
    expect(await runCli([
      'annotate', file, '--kind', 'decision', '--text', 'Which path?',
      '--option', 'Fast', '--option', 'Safe', '--heading', '# Test', '--as', 'ag_test',
    ], {
      ...io.runtime,
      request: async (request) => {
        sent = request
        return { version: PROTOCOL_VERSION, id: request.id, ok: true, result: { created: [] } }
      },
    })).toBe(0)
    expect(sent).toMatchObject({ command: 'annotate', args: { annotations: [{ kind: 'decision', text: 'Which path?', options: ['Fast', 'Safe'], heading: '# Test' }] } })

    for (const argv of [
      ['annotate', file, '--kind', 'decision', '--text', 'Which?', '--option', 'One', '--document', '--as', 'ag_test'],
      ['annotate', file, '--kind', 'decision', '--text', 'Which?', '--option', 'One', '--option', 'Two', '--document', '--quote', 'Test', '--as', 'ag_test'],
      ['answer', file, '--decision', 'd1', '--choice', 'One', '--other', 'Two', '--as', 'ag_test'],
    ]) {
      const invalid = captureIo()
      expect(await runCli(argv, { ...invalid.runtime, request: async () => { throw new Error('must not send') } })).toBe(1)
      expect(JSON.parse(invalid.stderr())).toMatchObject({ code: 'USAGE' })
    }
  })

  it('parses bounded screenshot pin placement as one online command', async () => {
    const file = await document()
    let sent: CommandRequest | undefined
    const io = captureIo()
    expect(await runCli([
      'pin', file, '--component', '3', '--x', '24.5', '--y', '100',
      '--note', 'Inspect the long row', '--as', 'ag_test', '--name', 'Reviewer',
    ], {
      ...io.runtime,
      request: async (request) => {
        sent = request
        return { version: PROTOCOL_VERSION, id: request.id, ok: true, result: { pinned: 2, component: 3, x: 24.5, y: 100, note: 'Inspect the long row' } }
      },
    })).toBe(0)
    expect(sent).toMatchObject({
      command: 'pin',
      args: { file, agent: 'ag_test', name: 'Reviewer', componentLine: 3, x: 24.5, y: 100, note: 'Inspect the long row' },
    })
    expect(JSON.parse(io.stdout())).toEqual({ pinned: 2, component: 3, x: 24.5, y: 100, note: 'Inspect the long row' })

    for (const argv of [
      ['pin', file, '--component', '0', '--x', '10', '--y', '20', '--note', 'Note', '--as', 'ag_test'],
      ['pin', file, '--component', '3', '--x', '-1', '--y', '20', '--note', 'Note', '--as', 'ag_test'],
      ['pin', file, '--component', '3', '--x', '10', '--y', '101', '--note', 'Note', '--as', 'ag_test'],
      ['pin', file, '--component', '3', '--x', '10', '--y', '20', '--note', '   ', '--as', 'ag_test'],
    ]) {
      const invalid = captureIo()
      expect(await runCli(argv, { ...invalid.runtime, request: async () => { throw new Error('must not send') } })).toBe(1)
      expect(JSON.parse(invalid.stderr())).toMatchObject({ code: 'USAGE' })
    }
  })

  it('validates annotate JSON before sending one all-or-nothing request', async () => {
    const file = await document()
    const input = JSON.stringify([
      { kind: 'comment', quote: 'Test', text: 'Read this' },
      { kind: 'suggestion', quote: '# Test', text: '# Better', precededBy: '' }
    ])
    let sent: CommandRequest | undefined
    const io = captureIo(input)
    expect(
      await runCli(['annotate', file, '--json', '-', '--as', 'ag_test'], {
        ...io.runtime,
        request: async (request) => {
          sent = request
          return { version: PROTOCOL_VERSION, id: request.id, ok: true }
        }
      })
    ).toBe(0)
    expect(sent?.command).toBe('annotate')
    expect((sent?.args as { annotations: unknown[] }).annotations).toHaveLength(2)
  })

  it('prints usage and not-found errors only on stderr', async () => {
    const badOption = captureIo()
    expect(await runCli(['attach', '--wat'], badOption.runtime)).toBe(1)
    expect(badOption.stdout()).toBe('')
    expect(JSON.parse(badOption.stderr())).toMatchObject({ code: 'USAGE' })

    const missing = captureIo()
    expect(
      await runCli(['open', '/definitely/not/a/stratamd-file.md'], {
        ...missing.runtime,
        request: async (request) => ({
          version: PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          exitCode: 2,
          error: { error: 'Document not found', code: 'NOT_FOUND' }
        })
      })
    ).toBe(2)
    expect(JSON.parse(missing.stderr())).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('preserves quote failure exit code and detail from the app', async () => {
    const file = await document()
    const io = captureIo()
    const code = await runCli(['annotate', file, '--kind', 'comment', '--quote', 'same'], {
      ...io.runtime,
      request: async (request) => ({
        version: PROTOCOL_VERSION,
        id: request.id,
        ok: false,
        exitCode: 3,
        error: { error: 'Quote is ambiguous', code: 'QUOTE_AMBIGUOUS', detail: ['line 2', 'line 9'] }
      })
    })
    expect(code).toBe(3)
    const error = {
      error: 'Quote is ambiguous',
      code: 'QUOTE_AMBIGUOUS',
      detail: ['line 2', 'line 9']
    }
    expect(io.stdout()).toBe('')
    expect(io.stderr()).toBe(`${JSON.stringify(error)}\n`)
  })

  it.each([
    {
      name: 'annotate',
      argv: (file: string) => ['annotate', file, '--as', 'ag_a', '--kind', 'comment', '--quote', 'Test'],
      result: { created: [{ id: 'a_1', kind: 'comment', quote: 'Test' }] }
    },
    {
      name: 'reply',
      argv: (file: string) => ['reply', file, '--as', 'ag_a', '--to', 'a1', '--text', 'Done'],
      result: { replied: 'r_1', annotation: 'a1' }
    },
    {
      name: 'edit',
      argv: (file: string) => ['edit', file, '--as', 'ag_a', '--match', 'Test', '--replace', 'Tested'],
      result: { applied: [{ line: 1, match: 'Test', replace: 'Tested' }] }
    },
    {
      name: 'changed',
      argv: (file: string) => ['changed', file, '--as', 'ag_a'],
      result: { tagged: true }
    },
    {
      name: 'docs',
      argv: () => ['docs'],
      result: { event: 'docs', documents: [], text: 'No document is open.' }
    }
  ])('prints the result of every online command ($name)', async ({ argv, result }) => {
    const file = await document()
    const io = captureIo()
    const code = await runCli(argv(file), {
      ...io.runtime,
      request: async (request) => ({ version: PROTOCOL_VERSION, id: request.id, ok: true, result })
    })
    expect(code).toBe(0)
    expect(JSON.parse(io.stdout())).toEqual(result)
    expect(io.stderr()).toBe('')
  })

  it('parses edit, the state views, attach --text-only, and docs', async () => {
    const file = await document()
    const sent: CommandRequest[] = []
    const runtime = (io: ReturnType<typeof captureIo>): CliRuntime => ({
      ...io.runtime,
      request: async (request): Promise<CommandResponse> => {
        sent.push(request)
        return { version: PROTOCOL_VERSION, id: request.id, ok: true, result: { done: true } }
      }
    })

    const single = captureIo()
    expect(await runCli([
      'edit', file, '--as', 'ag_a', '--name', 'Editor', '--match', 'same', '--replace', '',
      '--preceded-by', 'the ', '--followed-by', ' one',
    ], runtime(single))).toBe(0)
    expect(sent.at(-1)).toMatchObject({
      command: 'edit',
      args: {
        file, agent: 'ag_a', name: 'Editor',
        edits: [{ match: 'same', replace: '', precededBy: 'the ', followedBy: ' one' }]
      }
    })

    const stdinReplace = captureIo('line one\nline two\n')
    expect(await runCli(['edit', file, '--as', 'ag_a', '--match', 'Test', '--replace', '-'], runtime(stdinReplace))).toBe(0)
    expect(sent.at(-1)?.args).toMatchObject({ edits: [{ match: 'Test', replace: 'line one\nline two\n' }] })

    const batch = captureIo(JSON.stringify([
      { match: 'a', replace: 'b' },
      { match: 'c', replace: 'd', precededBy: 'x' },
    ]))
    expect(await runCli(['edit', file, '--as', 'ag_a', '--json', '-'], runtime(batch))).toBe(0)
    expect(sent.at(-1)?.args).toMatchObject({
      edits: [{ match: 'a', replace: 'b' }, { match: 'c', replace: 'd', precededBy: 'x' }]
    })

    for (const [argv, message] of [
      [['edit', file, '--as', 'ag_a', '--match', 'a'], 'Missing --replace'],
      [['edit', file, '--as', 'ag_a', '--replace', 'a'], 'Missing --match (or --append to insert at the end)'],
      [['edit', file, '--as', 'ag_a', '--json', '-', '--match', 'a'], '--json cannot be combined with individual edit options'],
    ] as const) {
      const io = captureIo('[]')
      expect(await runCli([...argv], runtime(io))).toBe(1)
      expect(JSON.parse(io.stderr())).toMatchObject({ code: 'USAGE', error: message })
    }
    const badBatch = captureIo(JSON.stringify([{ match: '', replace: 'x' }]))
    expect(await runCli(['edit', file, '--as', 'ag_a', '--json', '-'], runtime(badBatch))).toBe(1)
    expect(JSON.parse(badBatch.stderr())).toMatchObject({ code: 'USAGE', error: expect.stringContaining('Edit 1 needs a non-empty match') })

    const brief = captureIo()
    expect(await runCli(['state', file, '--brief'], runtime(brief))).toBe(0)
    expect(sent.at(-1)).toMatchObject({ command: 'state', args: { file, brief: true } })
    expect((sent.at(-1)?.args as { textOnly?: boolean }).textOnly).toBeUndefined()

    const textOnly = captureIo()
    expect(await runCli(['state', '--text-only'], runtime(textOnly))).toBe(0)
    expect(sent.at(-1)).toMatchObject({ command: 'state', args: { textOnly: true } })

    const attachTextOnly = captureIo()
    expect(await runCli(['attach', file, '--as', 'ag_a', '--timeout', '0', '--text-only'], runtime(attachTextOnly))).toBe(0)
    expect(sent.at(-1)).toMatchObject({ command: 'attach', args: { file, agent: 'ag_a', timeout: 0, textOnly: true } })

    const docs = captureIo()
    expect(await runCli(['docs'], runtime(docs))).toBe(0)
    expect(sent.at(-1)).toMatchObject({ command: 'docs', args: {} })
    const docsWithFile = captureIo()
    expect(await runCli(['docs', file], runtime(docsWithFile))).toBe(1)
  })

  it('reports a stalled instance without launching a second one or answering offline', async () => {
    const file = await document()
    for (const argv of [
      ['attach', file, '--as', 'ag_a', '--timeout', '0'],
      ['open', file],
      ['annotate', file, '--as', 'ag_a', '--kind', 'comment', '--quote', 'Test'],
      ['state', file],
    ]) {
      let launches = 0
      let offlineCalls = 0
      let requests = 0
      const io = captureIo()
      const code = await runCli(argv, {
        ...io.runtime,
        launchApp: async () => { launches += 1 },
        request: async () => { requests += 1; throw new SocketTimeoutError() },
        offlineHandler: async () => { offlineCalls += 1; return {} }
      })
      expect(code, argv[0]).toBe(4)
      expect(requests, argv[0]).toBe(1)
      expect(launches, argv[0]).toBe(0)
      expect(offlineCalls, argv[0]).toBe(0)
      expect(JSON.parse(io.stderr()), argv[0]).toMatchObject({ code: 'INSTANCE_TIMEOUT' })
    }
  })

  it('parses the six collaboration verbs and prints every result', async () => {
    const file = await document()
    const sent: CommandRequest[] = []
    const runtime = (io: ReturnType<typeof captureIo>): CliRuntime => ({
      ...io.runtime,
      request: async (request): Promise<CommandResponse> => {
        sent.push(request)
        return {
          version: PROTOCOL_VERSION,
          id: request.id,
          ok: true,
          result: request.command === 'send' ? { sent: [{ agent: 'ag_b', name: 'B' }] } : { done: true }
        }
      }
    })

    const send = captureIo()
    expect(await runCli(['send', file, '--as', 'ag_a', '--text', 'ping', '--to', 'ag_b,ag_c'], runtime(send))).toBe(0)
    expect(sent.at(-1)).toMatchObject({
      command: 'send',
      args: { file, agent: 'ag_a', text: 'ping', to: ['ag_b', 'ag_c'] }
    })
    expect(JSON.parse(send.stdout())).toEqual({ sent: [{ agent: 'ag_b', name: 'B' }] })

    const broadcast = captureIo()
    expect(await runCli(['send', file, '--as', 'ag_a', '--text', 'ping'], runtime(broadcast))).toBe(0)
    expect((sent.at(-1)?.args as { to?: unknown }).to).toBeUndefined()

    const stdinNote = captureIo('line one\nline two\n')
    expect(await runCli(['send', file, '--as', 'ag_a', '--text', '-'], runtime(stdinNote))).toBe(0)
    expect(sent.at(-1)?.args).toMatchObject({ text: 'line one\nline two\n' })

    for (const [argv, expected] of [
      [['lead', file, '--as', 'ag_a'], { command: 'lead', args: { file, agent: 'ag_a' } }],
      [['save', file, '--as', 'ag_a'], { command: 'save', args: { file, agent: 'ag_a' } }],
      [['accept', file, '--annotation', 'a1', '--as', 'ag_a'], { command: 'accept', args: { file, agent: 'ag_a', annotation: 'a1' } }],
      [['reject', file, '--annotation', 'a1', '--as', 'ag_a'], { command: 'reject', args: { file, agent: 'ag_a', annotation: 'a1' } }],
      [['resolve', file, '--annotation', 'a1', '--as', 'ag_a'], { command: 'resolve', args: { file, agent: 'ag_a', annotation: 'a1' } }],
    ] as const) {
      const io = captureIo()
      expect(await runCli([...argv], runtime(io))).toBe(0)
      expect(sent.at(-1)).toMatchObject(expected as object)
      expect(JSON.parse(io.stdout())).toEqual({ done: true })
    }
  })

  it('rejects an oversize message note with exit 1 before any socket call', async () => {
    const file = await document()
    let calls = 0
    const io = captureIo()
    const code = await runCli(['send', file, '--as', 'ag_a', '--text', 'x'.repeat(4097)], {
      ...io.runtime,
      request: async (request) => {
        calls += 1
        return { version: PROTOCOL_VERSION, id: request.id, ok: true }
      }
    })
    expect(code).toBe(1)
    expect(calls).toBe(0)
    expect(JSON.parse(io.stderr())).toMatchObject({ code: 'USAGE' })
  })

  it('never routes the online-only commands offline or launches the app for them', async () => {
    const file = await document()
    for (const argv of [
      ['send', file, '--as', 'ag_a', '--text', 'ping'],
      ['lead', file, '--as', 'ag_a'],
      ['accept', file, '--annotation', 'a1', '--as', 'ag_a'],
      ['reject', file, '--annotation', 'a1', '--as', 'ag_a'],
      ['save', file, '--as', 'ag_a'],
      ['docs'],
      ['edit', file, '--as', 'ag_a', '--match', 'Test', '--replace', 'Tested'],
    ]) {
      let launches = 0
      let offlineCalls = 0
      const io = captureIo()
      const code = await runCli(argv, {
        ...io.runtime,
        launchApp: async () => { launches += 1 },
        request: async () => { throw new SocketUnavailableError('absent', 'ENOENT') },
        offlineHandler: async () => { offlineCalls += 1; return {} }
      })
      expect(code, argv[0]).toBe(4)
      expect(launches, argv[0]).toBe(0)
      expect(offlineCalls, argv[0]).toBe(0)
      expect(JSON.parse(io.stderr())).toMatchObject({ code: 'INSTANCE_UNREACHABLE' })
    }
  })

  it('acks a delivery only after writing it to stdout', async () => {
    const file = await document()
    const order: string[] = []
    let output = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        order.push('stdout-flushed')
        callback()
      }
    })
    const code = await runCli(['attach', file, '--as', 'ag_test', '--timeout', '0'], {
      io: { stdin: Readable.from([]), stdout, stderr: new Writable({ write: (_c, _e, cb) => cb() }) },
      request: async (request) => {
        order.push(request.command)
        if (request.command === 'ack') {
          expect(request.args).toEqual({ file, agent: 'ag_test', deliveryId: 'd_1' })
          return { version: PROTOCOL_VERSION, id: request.id, ok: true }
        }
        return {
          version: PROTOCOL_VERSION,
          id: request.id,
          ok: true,
          result: { version: PROTOCOL_VERSION, event: 'send', file, agent: 'ag_test', deliveryId: 'd_1', text: 'payload' }
        }
      }
    })
    expect(code).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ deliveryId: 'd_1' })
    expect(order).toEqual(['attach', 'stdout-flushed', 'ack'])
  })

  it('prints a theme offline with set values, defaults with descriptions, and problems', async () => {
    const config = await mkdtemp(join(tmpdir(), 'stratamd-cli-theme-'))
    await mkdir(join(config, 'themes'), { recursive: true })
    await writeFile(join(config, 'settings.json'), JSON.stringify({ formatVersion: 1, theme: 'dusk' }))
    await writeFile(join(config, 'themes', 'dusk.json'), JSON.stringify({ name: 'Dusk', document: { bold: '#112233', link: 'blue' } }))
    const environment = { ...process.env, STRATAMD_CONFIG_DIRECTORY: config }

    const json = captureIo()
    expect(await runCli(['theme', '--json'], { ...json.runtime, environment })).toBe(0)
    const described = JSON.parse(json.stdout())
    expect(described).toMatchObject({ id: 'dusk', name: 'Dusk', path: join(config, 'themes', 'dusk.json') })
    expect(described.set).toEqual({ 'document.bold': '#112233', 'document.link': '#5ee0b4' })
    expect(described.defaults['document.italic']).toBe('#ff7070')
    expect(described.keys.find((entry: { key: string }) => entry.key === 'document.bold').label).toBe('Bold text')
    expect(described.problems).toEqual([{ key: 'document.link', reason: 'not a color (use #rrggbb)' }])

    const text = captureIo()
    expect(await runCli(['theme', 'dusk'], { ...text.runtime, environment })).toBe(0)
    expect(text.stdout()).toContain('SET (chosen')
    expect(text.stdout()).toContain('document.bold = #112233')
    expect(text.stdout()).toContain('DEFAULT (not in the file')
    expect(text.stdout()).toContain('PROBLEMS')

    const builtIn = captureIo()
    expect(await runCli(['theme', 'strata'], { ...builtIn.runtime, environment })).toBe(0)
    expect(builtIn.stdout()).toContain('built-in; user themes live in')
    await expect(runCli(['theme', 'nope'], { ...captureIo().runtime, environment })).resolves.not.toBe(0)
    await rm(config, { recursive: true, force: true })
  })

  it('discovers the closed component registry offline in readable and JSON forms', async () => {
    const json = captureIo()
    expect(await runCli(['components', '--json'], json.runtime)).toBe(0)
    const registry = JSON.parse(json.stdout()) as { components: Array<{ name: string; example: string }> }
    expect(registry.components.map((component) => component.name)).toEqual([
      'Callout', 'Verdict', 'MetricStrip', 'PhaseBoard', 'DecisionMatrix',
      'BeforeAfter', 'Chart', 'EvidenceChain', 'AnnotatedScreenshot',
    ])
    expect(registry.components.every((component) => component.example.includes(`<${component.name}`))).toBe(true)

    const readable = captureIo()
    expect(await runCli(['components', 'Callout'], readable.runtime)).toBe(0)
    expect(readable.stdout()).toContain('Callout — Keep important context')
    expect(readable.stdout()).toContain('kind: context | warning | implication | support')
    expect(readable.stdout()).toContain('<Callout kind="warning">')

    const missing = captureIo()
    expect(await runCli(['components', 'Timeline'], missing.runtime)).toBe(2)
    expect(JSON.parse(missing.stderr())).toMatchObject({ code: 'COMPONENT_NOT_FOUND', detail: { name: 'Timeline' } })
  })

  it('validates component files offline without rewriting them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratamd-components-'))
    temporaryDirectories.push(directory)
    const validFile = join(directory, 'valid.md')
    const invalidFile = join(directory, 'invalid.md')
    const validSource = '# Report\n\n<Callout kind="support">\nSupporting **evidence**.\n</Callout>\n'
    const invalidSource = '<div>ordinary HTML</div>\n\n<UnknownVisual>\nNo registry entry.\n</UnknownVisual>\n\n<Verdict color="pink">\nShip.\n</Verdict>\n'
    await writeFile(validFile, validSource)
    await writeFile(invalidFile, invalidSource)

    const valid = captureIo()
    expect(await runCli(['validate', validFile, '--json'], valid.runtime)).toBe(0)
    expect(JSON.parse(valid.stdout())).toMatchObject({
      file: validFile,
      valid: true,
      components: [{ name: 'Callout', line: 3 }],
      problems: [],
    })
    expect(await readFile(validFile, 'utf8')).toBe(validSource)

    const invalid = captureIo()
    expect(await runCli(['validate', invalidFile], invalid.runtime)).toBe(0)
    expect(invalid.stdout()).toContain('Needs attention:')
    expect(invalid.stdout()).toContain('COMPONENT_UNKNOWN')
    expect(invalid.stdout()).toContain('COMPONENT_PROPERTY_UNKNOWN')
    expect(invalid.stdout()).not.toContain('ordinary HTML')
    expect(await readFile(invalidFile, 'utf8')).toBe(invalidSource)

    const missing = captureIo()
    expect(await runCli(['validate', join(directory, 'missing.md'), '--json'], missing.runtime)).toBe(2)
    expect(JSON.parse(missing.stderr())).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('uses an injected offline handler when the app is absent', async () => {
    const file = await document()
    const io = captureIo()
    const code = await runCli(['state', file], {
      ...io.runtime,
      request: async () => {
        throw new SocketUnavailableError('absent', 'ENOENT')
      },
      offlineHandler: async (request) => ({ version: PROTOCOL_VERSION, event: 'state', file: request.args.file })
    })
    expect(code).toBe(0)
    expect(JSON.parse(io.stdout())).toMatchObject({ event: 'state', file })
  })

  it.each(['answer', 'resolve'] as const)('routes %s through the offline decision check', async (command) => {
    const file = await document()
    const io = captureIo()
    let offlineCommand = ''
    const args = command === 'answer'
      ? ['answer', file, '--decision', 'd1', '--choice', 'A', '--as', 'ag_a']
      : ['resolve', file, '--annotation', 'd1', '--as', 'ag_a']
    const code = await runCli(args, {
      ...io.runtime,
      request: async () => { throw new SocketUnavailableError('absent', 'ENOENT') },
      offlineHandler: async (request) => {
        offlineCommand = request.command
        throw new CommandFailure('Only the user can act on decision d1', 3, 'DECISION_OWNER_REQUIRED', { decision: 'd1' })
      },
    })
    expect(code).toBe(3)
    expect(offlineCommand).toBe(command)
    expect(JSON.parse(io.stderr())).toMatchObject({ code: 'DECISION_OWNER_REQUIRED', detail: { decision: 'd1' } })
  })
})

describe('versions, help, and the build handshake', () => {
  it('prints the app, protocol, and payload versions with the CLI and app paths', async () => {
    const io = captureIo()
    expect(await runCli(['--version'], { ...io.runtime, environment: { STRATAMD_CLI_EXECUTABLE: '/opt/strata/stratamd', STRATAMD_APP_EXECUTABLE: '/bin/sh' } })).toBe(0)
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
    expect(JSON.parse(io.stdout())).toEqual({
      version: packageJson.version,
      protocol: PROTOCOL_VERSION,
      payload: PAYLOAD_VERSION,
      cli: '/opt/strata/stratamd',
      app: '/bin/sh',
    })
    expect(io.stderr()).toBe('')

    const missingApp = captureIo()
    expect(await runCli(['--version'], { ...missingApp.runtime, environment: { STRATAMD_APP_EXECUTABLE: '/definitely/missing' } })).toBe(0)
    expect(JSON.parse(missingApp.stdout())).toMatchObject({ app: null, cli: expect.any(String) })
  })

  it.each([['--help'], ['-h'], ['help']])('%s prints the usage screen with the pointer to --agent-help', async (flag) => {
    const io = captureIo()
    expect(await runCli([flag], io.runtime)).toBe(0)
    expect(io.stdout()).toContain('Usage: stratamd')
    expect(io.stdout()).toContain('--agent-help')
    expect(io.stdout()).toContain('doctor')
    expect(io.stdout()).toContain('setup [--skill')
    expect(io.stderr()).toBe('')
  })

  it('gives a subagent an id of its own and tells siblings apart only through --as', () => {
    const parent = sessionAgentId({ CLAUDE_CODE_SESSION_ID: 'shared' })!
    const child = sessionAgentId({ CLAUDE_CODE_SESSION_ID: 'shared', CLAUDE_CODE_CHILD_SESSION: '1' })!
    expect(child).toMatch(/^ag_[a-f0-9]{12}$/)
    expect(child).not.toBe(parent)
    expect(child).toBe(sessionAgentId({ CLAUDE_CODE_SESSION_ID: 'shared', CLAUDE_CODE_CHILD_SESSION: '1' }))
    expect(sessionAgentId({ CLAUDE_CODE_CHILD_SESSION: '1' })).toBeUndefined()
  })

  it('maps a response from another build to PROTOCOL_MISMATCH, whichever side noticed', async () => {
    const file = await document()
    const respond = (version: number, body: Partial<CommandResponse> = {}) => async (request: CommandRequest): Promise<CommandResponse> =>
      ({ version, id: request.id, ok: true, result: { done: true }, ...body } as CommandResponse)

    // The app is older: it answered INVALID_REQUEST with its own version, as builds before the handshake do.
    const olderApp = captureIo()
    expect(await runCli(['state', file], {
      ...olderApp.runtime,
      request: respond(PROTOCOL_VERSION - 1, { ok: false, exitCode: 1, error: { error: 'Invalid socket request', code: 'INVALID_REQUEST' } } as Partial<CommandResponse>),
    })).toBe(4)
    expect(olderApp.stdout()).toBe('')
    expect(JSON.parse(olderApp.stderr())).toMatchObject({
      code: 'PROTOCOL_MISMATCH',
      error: expect.stringContaining('restart StrataMD to pick up the new build'),
      detail: { app: PROTOCOL_VERSION - 1, cli: PROTOCOL_VERSION },
    })

    // The app is newer and answered normally: the command must be updated.
    const newerApp = captureIo()
    expect(await runCli(['state', file], { ...newerApp.runtime, request: respond(PROTOCOL_VERSION + 1) })).toBe(4)
    expect(JSON.parse(newerApp.stderr())).toMatchObject({
      code: 'PROTOCOL_MISMATCH',
      error: expect.stringContaining('update the stratamd command'),
    })

    // The app said it itself: printed as is.
    const appSaid = captureIo()
    expect(await runCli(['state', file], {
      ...appSaid.runtime,
      request: async (request) => ({
        version: PROTOCOL_VERSION + 1, id: request.id, ok: false, exitCode: 4,
        error: { error: 'The running StrataMD speaks protocol 11 and this stratamd command speaks protocol 10: update it', code: 'PROTOCOL_MISMATCH', detail: { app: 11, cli: 10 } },
      }),
    })).toBe(4)
    expect(JSON.parse(appSaid.stderr())).toMatchObject({ code: 'PROTOCOL_MISMATCH', detail: { app: 11, cli: 10 } })
  })

  it('names the socket and log path when the app is unreachable', async () => {
    const file = await document()
    const io = captureIo()
    const home = await mkdtemp(join(tmpdir(), 'stratamd-cli-home-'))
    temporaryDirectories.push(home)
    expect(await runCli(['send', file, '--as', 'ag_a', '--text', 'ping'], {
      ...io.runtime,
      environment: { HOME: home, XDG_DATA_HOME: join(home, 'data') },
      socketPath: join(home, 'run', 'stratamd.sock'),
      request: async () => { throw new SocketUnavailableError('absent', 'ENOENT') },
    })).toBe(4)
    expect(JSON.parse(io.stderr())).toMatchObject({
      code: 'INSTANCE_UNREACHABLE',
      detail: {
        socket: join(home, 'run', 'stratamd.sock'),
        log: join(home, 'data', 'stratamd', 'logs', 'stratamd.log'),
        hint: expect.stringContaining('doctor'),
      },
    })
  })
})

describe('doctor', () => {
  async function fixture(): Promise<{ home: string; environment: NodeJS.ProcessEnv; socketPath: string; lock: string; log: string }> {
    const home = await mkdtemp(join(tmpdir(), 'stratamd-doctor-'))
    temporaryDirectories.push(home)
    const data = join(home, 'data', 'stratamd')
    const log = join(data, 'logs', 'stratamd.log')
    await mkdir(join(data, 'logs'), { recursive: true })
    await writeFile(log, [
      JSON.stringify({ time: '2026-09-01T01:00:00.000Z', level: 'warn', scope: 'watcher', message: 'ignored' }),
      ...Array.from({ length: 6 }, (_, index) => JSON.stringify({ time: `2026-09-01T02:0${index}:00.000Z`, level: 'error', scope: 'save', message: `failure ${index}` })),
      'not json at all',
    ].join('\n') + '\n')
    const entry = join(data, 'docs', 'abc123def456')
    await mkdir(entry, { recursive: true })
    const lock = join(entry, 'lock')
    await writeFile(lock, JSON.stringify({ pid: 4194303, token: 'x' }) + '\n')
    await writeFile(join(entry, 'meta.json'), JSON.stringify({ realpath: '/home/u/notes.md' }))
    return {
      home,
      environment: { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), STRATAMD_APP_EXECUTABLE: '/bin/sh' },
      socketPath: join(home, 'run', 'stratamd.sock'),
      lock,
      log,
    }
  }

  it('reports the socket, directories, log errors, stale locks, and versions without the app', async () => {
    const { home, environment, socketPath, lock, log } = await fixture()
    const io = captureIo()
    expect(await runCli(['doctor'], {
      ...io.runtime,
      environment,
      socketPath,
      request: async () => { throw new SocketUnavailableError('absent', 'ENOENT') },
    })).toBe(0)
    const report = JSON.parse(io.stdout())
    expect(report).toMatchObject({
      ok: false,
      version: { protocol: PROTOCOL_VERSION, payload: PAYLOAD_VERSION, app: '/bin/sh' },
      socket: { path: socketPath, exists: false, answers: false, protocol: null, error: 'absent' },
      directories: { data: join(home, 'data', 'stratamd'), config: join(home, 'config', 'stratamd') },
      log: { path: log },
      locks: [{ path: lock, document: '/home/u/notes.md', pid: 4194303, alive: false }],
    })
    expect(report.log.errors).toEqual([
      '2026-09-01T02:02:00.000Z save: failure 2',
      '2026-09-01T02:03:00.000Z save: failure 3',
      '2026-09-01T02:04:00.000Z save: failure 4',
      '2026-09-01T02:05:00.000Z save: failure 5',
      'not json at all',
    ])
    expect(report.problems).toEqual([
      expect.stringContaining('not running'),
      expect.stringContaining(log),
      expect.stringContaining(`Stale lock ${lock}`),
    ])
    expect(io.stderr()).toBe('')
  })

  it('probes the socket and flags a protocol mismatch as a problem', async () => {
    const { environment, socketPath } = await fixture()
    const probes: CommandRequest[] = []
    const io = captureIo()
    expect(await runCli(['doctor'], {
      ...io.runtime,
      environment,
      socketPath,
      request: async (request) => {
        probes.push(request)
        return { version: PROTOCOL_VERSION - 1, id: 'invalid', ok: false, exitCode: 1, error: { error: 'Invalid socket request', code: 'INVALID_REQUEST' } }
      },
    })).toBe(0)
    expect(probes.map((probe) => probe.command)).toEqual(['docs'])
    const report = JSON.parse(io.stdout())
    expect(report.socket).toEqual({ path: socketPath, exists: false, answers: true, protocol: PROTOCOL_VERSION - 1 })
    expect(report.problems[0]).toContain('restart StrataMD to pick up the new build')

    const healthy = captureIo()
    expect(await runCli(['doctor', 'extra'], healthy.runtime)).toBe(1)
    expect(JSON.parse(healthy.stderr())).toMatchObject({ code: 'USAGE', error: expect.stringContaining('doctor takes no arguments') })
  })
})

describe('agent loop ergonomics', () => {
  it('defaults attach to a 90 second timeout with the socket deadline 15 seconds later', async () => {
    const file = await document()
    let sent: CommandRequest | undefined
    let timeoutMs: number | undefined
    const io = captureIo()
    expect(await runCli(['attach', file, '--as', 'ag_test'], {
      ...io.runtime,
      request: async (request, options): Promise<CommandResponse> => {
        sent = request
        timeoutMs = options?.timeoutMs
        return { version: PROTOCOL_VERSION, id: request.id, ok: true, result: { version: PAYLOAD_VERSION, event: 'timeout' } }
      },
    })).toBe(0)
    expect(sent?.args).toMatchObject({ timeout: 90 })
    expect(timeoutMs).toBe(105_000)
  })

  it('prints a warning and exits 0 when the ack fails after the delivery was printed', async () => {
    const file = await document()
    for (const failAck of ['error', 'throw'] as const) {
      const io = captureIo()
      expect(await runCli(['attach', file, '--as', 'ag_test', '--timeout', '0'], {
        ...io.runtime,
        request: async (request) => {
          if (request.command === 'ack') {
            if (failAck === 'throw') throw new SocketTimeoutError()
            return { version: PROTOCOL_VERSION, id: request.id, ok: false, exitCode: 2, error: { error: 'Delivery d_1 was not found', code: 'NOT_FOUND' } }
          }
          return {
            version: PROTOCOL_VERSION, id: request.id, ok: true,
            result: { version: PAYLOAD_VERSION, event: 'send', file, agent: 'ag_test', deliveryId: 'd_1', text: 'payload' },
          }
        },
      }), failAck).toBe(0)
      expect(JSON.parse(io.stdout())).toMatchObject({ deliveryId: 'd_1' })
      expect(JSON.parse(io.stderr())).toMatchObject({ warning: expect.stringContaining('not acknowledged') })
    }
  })

  it('state --raw prints the buffer verbatim, --annotations asks for the annotations view, and views are exclusive', async () => {
    const file = await document()
    const sent: CommandRequest[] = []
    const runtime = (io: ReturnType<typeof captureIo>): CliRuntime => ({
      ...io.runtime,
      request: async (request): Promise<CommandResponse> => {
        sent.push(request)
        return { version: PROTOCOL_VERSION, id: request.id, ok: true, result: { version: PAYLOAD_VERSION, event: 'state', document: '# Raw\n\nno newline at end', text: 'rendered' } }
      },
    })

    const raw = captureIo()
    expect(await runCli(['state', file, '--raw'], runtime(raw))).toBe(0)
    expect(sent.at(-1)?.args).toEqual({ file })
    expect(raw.stdout()).toBe('# Raw\n\nno newline at end')
    expect(raw.stderr()).toBe('')

    const annotations = captureIo()
    expect(await runCli(['state', file, '--annotations'], runtime(annotations))).toBe(0)
    expect(sent.at(-1)?.args).toEqual({ file, annotationsOnly: true })
    expect(JSON.parse(annotations.stdout())).toMatchObject({ event: 'state' })

    const both = captureIo()
    expect(await runCli(['state', file, '--raw', '--brief'], runtime(both))).toBe(1)
    expect(JSON.parse(both.stderr())).toMatchObject({ code: 'USAGE', error: expect.stringContaining('one view') })
  })

  it('parses anchorless inserts, --append, --dry-run, and refuses an empty match without a context', async () => {
    const file = await document()
    const sent: CommandRequest[] = []
    const runtime = (io: ReturnType<typeof captureIo>): CliRuntime => ({
      ...io.runtime,
      request: async (request): Promise<CommandResponse> => {
        sent.push(request)
        return { version: PROTOCOL_VERSION, id: request.id, ok: true, result: { applied: [] } }
      },
    })

    expect(await runCli(['edit', file, '--as', 'ag_a', '--match', '', '--preceded-by', '# Test\n', '--replace', 'Intro.\n'], runtime(captureIo()))).toBe(0)
    expect(sent.at(-1)?.args).toMatchObject({ edits: [{ match: '', precededBy: '# Test\n', replace: 'Intro.\n' }] })

    expect(await runCli(['edit', file, '--as', 'ag_a', '--match', '', '--preceded-by', '', '--replace', 'Top\n'], runtime(captureIo()))).toBe(0)
    expect(sent.at(-1)?.args).toMatchObject({ edits: [{ match: '', precededBy: '', replace: 'Top\n' }] })

    expect(await runCli(['edit', file, '--as', 'ag_a', '--append', '--replace', '\nEnd.\n', '--dry-run'], runtime(captureIo()))).toBe(0)
    expect(sent.at(-1)?.args).toMatchObject({ edits: [{ match: '', replace: '\nEnd.\n', append: true }], dryRun: true })

    const batch = captureIo(JSON.stringify([{ append: true, replace: 'x' }, { match: '', followedBy: 'Test', replace: 'y' }]))
    expect(await runCli(['edit', file, '--as', 'ag_a', '--json', '-'], runtime(batch))).toBe(0)
    expect(sent.at(-1)?.args).toMatchObject({ edits: [{ match: '', replace: 'x', append: true }, { match: '', followedBy: 'Test', replace: 'y' }] })

    for (const [argv, message] of [
      [['edit', file, '--as', 'ag_a', '--match', '', '--replace', 'x'], 'empty match'],
      [['edit', file, '--as', 'ag_a', '--append', '--match', 'x', '--replace', 'y'], '--append takes no --match'],
      [['edit', file, '--as', 'ag_a', '--replace', 'x'], 'Missing --match'],
    ] as const) {
      const io = captureIo()
      expect(await runCli([...argv], runtime(io))).toBe(1)
      expect(JSON.parse(io.stderr())).toMatchObject({ code: 'USAGE', error: expect.stringContaining(message) })
    }
  })

  it('lists the valid options for an unknown one and says what a positional error expected', async () => {
    const badOption = captureIo()
    expect(await runCli(['state', '--wat'], badOption.runtime)).toBe(1)
    expect(JSON.parse(badOption.stderr())).toMatchObject({
      code: 'USAGE',
      error: 'Unknown option --wat',
      detail: { valid: ['--brief', '--text-only', '--annotations', '--raw'] },
    })

    const positional = captureIo()
    expect(await runCli(['docs', 'extra'], positional.runtime)).toBe(1)
    expect(JSON.parse(positional.stderr())).toMatchObject({ error: 'docs takes no arguments; got 1', detail: { positionals: ['extra'] } })

    const file = await document()
    const tooMany = captureIo()
    expect(await runCli(['changes', file, file], tooMany.runtime)).toBe(1)
    expect(JSON.parse(tooMany.stderr())).toMatchObject({ error: 'changes takes exactly <file>; got 2' })
  })
})

describe('XDG paths', () => {
  it('uses XDG_RUNTIME_DIR when absolute and the private cache fallback otherwise', () => {
    // socketPathForEnvironment answers for the host platform; the full
    // per-platform matrix lives in test/unit/platform-paths.test.ts.
    const fallback = process.platform === 'darwin'
      ? '/home/me/Library/Caches/StrataMD/run/stratamd.sock'
      : '/home/me/.cache/stratamd/run/stratamd.sock'
    expect(socketPathForEnvironment({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/me')).toBe(
      '/run/user/1000/stratamd.sock'
    )
    expect(socketPathForEnvironment({}, '/home/me')).toBe(fallback)
    expect(socketPathForEnvironment({ XDG_RUNTIME_DIR: 'relative' }, '/home/me')).toBe(fallback)
  })
})

describe('local setup', () => {
  it('installs and removes the PATH link, desktop entry, icon, and MIME metadata idempotently', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stratamd-setup-'))
    temporaryDirectories.push(home)
    const data = join(home, 'data')
    const executable = join(process.cwd(), 'bin', 'stratamd')
    const options = {
      platform: 'linux',
      home,
      executable,
      environment: { HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(home, 'config') },
      commandRunner: (() => ({ status: 0, stdout: '', stderr: '' })) satisfies SetupCommandRunner
    }

    await setup(options)
    await setup(options)
    const { readlink, stat } = await import('node:fs/promises')
    expect(await readlink(join(home, '.local', 'bin', 'stratamd'))).toBe(executable)
    const entry = await readFile(join(data, 'applications', 'stratamd.desktop'), 'utf8')
    expect(entry).toContain('MimeType=text/markdown;')
    // TryExec is a bare path (the spec allows quoting only in Exec); a quoted value makes KDE hide the entry.
    expect(entry).toContain(`TryExec=${executable}\n`)
    expect(entry).not.toMatch(/TryExec="/)
    expect(entry).toContain('Icon=stratamd-icon\n')
    expect(entry).toContain('StartupWMClass=stratamd-app\n')
    const installedIcon = await readFile(join(data, 'icons', 'hicolor', 'scalable', 'apps', 'stratamd-icon.svg'), 'utf8')
    expect(installedIcon).toContain('<svg')
    expect(installedIcon).toContain('#ff5c8a')
    expect(installedIcon).toContain('#ffb03a')
    expect(installedIcon).toContain('#9b5cff')
    expect(installedIcon).toContain('fill="url(#bg)"')
    expect(installedIcon).toContain('stroke="url(#edge)"')
    expect(installedIcon).toContain('mask="url(#layer-cutouts)"')
    expect(installedIcon).not.toContain('stroke="#FFFFFF"')
    expect(await readFile(join(data, 'mime', 'packages', 'stratamd.xml'), 'utf8')).toContain(
      '<glob pattern="*.markdown"/>'
    )

    await setup({ ...options, remove: true })
    await setup({ ...options, remove: true })
    await expect(stat(join(home, '.local', 'bin', 'stratamd'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the previous default on removal without replacing a later user choice', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stratamd-setup-default-'))
    temporaryDirectories.push(home)
    const commands: Array<{ command: string; args: readonly string[] }> = []
    let currentDefault = 'other-editor.desktop'
    const runner: SetupCommandRunner = (command, args) => {
      commands.push({ command, args: [...args] })
      if (command === 'xdg-mime' && args[0] === 'query') {
        return { status: 0, stdout: `${currentDefault}\n`, stderr: '' }
      }
      if (command === 'xdg-mime' && args[0] === 'default') {
        currentDefault = args[1] ?? ''
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const options = {
      platform: 'linux',
      home,
      executable: join(process.cwd(), 'bin', 'stratamd'),
      environment: {
        HOME: home,
        XDG_DATA_HOME: join(home, 'data'),
        XDG_CONFIG_HOME: join(home, 'config')
      },
      commandRunner: runner
    }

    await setup({ ...options, makeDefault: true })
    expect(currentDefault).toBe('stratamd.desktop')
    await setup({ ...options, remove: true })
    expect(currentDefault).toBe('other-editor.desktop')
    expect(commands).toContainEqual({
      command: 'xdg-mime',
      args: ['default', 'other-editor.desktop', 'text/markdown']
    })

    await setup({ ...options, makeDefault: true })
    currentDefault = 'user-selected.desktop'
    commands.length = 0
    await setup({ ...options, remove: true })
    expect(currentDefault).toBe('user-selected.desktop')
    expect(commands.some(({ command, args }) => command === 'xdg-mime' && args[0] === 'default')).toBe(false)
  })

  it('removes only its own default entry when there was no previous handler', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stratamd-setup-empty-default-'))
    temporaryDirectories.push(home)
    const config = join(home, 'config')
    const mimeapps = join(config, 'mimeapps.list')
    let currentDefault = ''
    const runner: SetupCommandRunner = (command, args) => {
      if (command === 'xdg-mime' && args[0] === 'query') {
        return { status: 0, stdout: `${currentDefault}\n`, stderr: '' }
      }
      if (command === 'xdg-mime' && args[0] === 'default') currentDefault = args[1] ?? ''
      return { status: 0, stdout: '', stderr: '' }
    }
    const options = {
      platform: 'linux',
      home,
      executable: join(process.cwd(), 'bin', 'stratamd'),
      environment: { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: config },
      commandRunner: runner
    }

    await setup({ ...options, makeDefault: true })
    await mkdir(config, { recursive: true })
    await writeFile(
      mimeapps,
      '[Default Applications]\ntext/markdown=stratamd.desktop;fallback.desktop;\ntext/plain=text.desktop;\n'
    )
    await setup({ ...options, remove: true })
    expect(await readFile(mimeapps, 'utf8')).toBe(
      '[Default Applications]\ntext/markdown=fallback.desktop;\ntext/plain=text.desktop;\n'
    )
  })

  it('on macOS manages only the PATH link and prints the Finder steps for defaults', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stratamd-setup-mac-'))
    temporaryDirectories.push(home)
    const notices: string[] = []
    const options = {
      platform: 'darwin',
      home,
      executable: join(process.cwd(), 'bin', 'stratamd'),
      environment: { HOME: home, PATH: '/usr/bin:/bin' },
      // Any command invocation on macOS would be a bug; there is no desktop machinery.
      commandRunner: (() => { throw new Error('setup must not run commands on macOS') }) satisfies SetupCommandRunner,
      report: (text: string) => { notices.push(text) },
    }

    await setup(options)
    await setup(options)
    const { readlink, stat } = await import('node:fs/promises')
    expect(await readlink(join(home, '.local', 'bin', 'stratamd'))).toBe(options.executable)
    await expect(stat(join(home, 'data', 'applications', 'stratamd.desktop'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(notices.join('')).toContain('.local/bin is not on your PATH')

    notices.length = 0
    await setup({ ...options, makeDefault: true })
    expect(notices.join('')).toContain('Change All')

    await setup({ ...options, remove: true })
    await expect(stat(join(home, '.local', 'bin', 'stratamd'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
