import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_HELP } from '../../src/cli/agent-help.js'
import { deriveAgentId, runCli, type CliRuntime } from '../../src/cli/commands.js'
import { PROTOCOL_VERSION, type CommandRequest, type CommandResponse } from '../../src/cli/protocol.js'
import { SocketUnavailableError, socketPathForEnvironment } from '../../src/cli/socket-client.js'
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
    expect(io.stdout()).toBe('')
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
    expect(io.stdout()).toBe('')
    expect(io.stderr()).toBe('')
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
      argv: (file: string) => ['annotate', file, '--kind', 'comment', '--quote', 'Test'],
      result: { created: 1 }
    },
    {
      name: 'reply',
      argv: (file: string) => ['reply', file, '--to', 'a1', '--text', 'Done'],
      result: { replied: true }
    }
  ])('keeps online $name success silent even when a legacy handler returns a result', async ({ argv, result }) => {
    const file = await document()
    const io = captureIo()
    const code = await runCli(argv(file), {
      ...io.runtime,
      request: async (request) => ({ version: PROTOCOL_VERSION, id: request.id, ok: true, result })
    })
    expect(code).toBe(0)
    expect(io.stdout()).toBe('')
    expect(io.stderr()).toBe('')
  })

  it('parses the six collaboration verbs and prints only send output', async () => {
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
      expect(io.stdout()).toBe('')
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

  it('never routes the collaboration verbs offline or launches the app for them', async () => {
    const file = await document()
    for (const argv of [
      ['send', file, '--as', 'ag_a', '--text', 'ping'],
      ['lead', file, '--as', 'ag_a'],
      ['accept', file, '--annotation', 'a1', '--as', 'ag_a'],
      ['reject', file, '--annotation', 'a1', '--as', 'ag_a'],
      ['resolve', file, '--annotation', 'a1', '--as', 'ag_a'],
      ['save', file, '--as', 'ag_a'],
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
    expect(described.set).toEqual({ 'document.bold': '#112233', 'document.link': '#4f8dff' })
    expect(described.defaults['document.italic']).toBe('#dbdade')
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

  it.each([
    ['update-desktop-database', 'DESKTOP_DATABASE_FAILED'],
    ['update-mime-database', 'MIME_DATABASE_FAILED']
  ] as const)('fails when %s fails', async (failedCommand, expectedCode) => {
    const home = await mkdtemp(join(tmpdir(), 'stratamd-setup-failure-'))
    temporaryDirectories.push(home)
    const runner: SetupCommandRunner = (command) => command === failedCommand
      ? { status: 1, stderr: `${command} is unavailable` }
      : { status: 0, stdout: '', stderr: '' }

    await expect(setup({
      platform: 'linux',
      home,
      executable: join(process.cwd(), 'bin', 'stratamd'),
      environment: { HOME: home, XDG_DATA_HOME: join(home, 'data') },
      commandRunner: runner
    })).rejects.toMatchObject({
      code: expectedCode,
      detail: `${failedCommand} is unavailable`
    })
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
