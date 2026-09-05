import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { pickerAccountOptions } from '../../src/renderer/model'
import type { TerminalShimTarget } from '../../src/main/account-shims'
import { fakeEngineServer } from './support/fake-engine-socket'

const at = '2026-09-03T12:00:00.000Z'
const nowMs = Date.parse(at)

function shell() {
  const thread = (id: string, instanceId: string) => ({
    id, projectId: 'p1', title: id, modelSelection: { instanceId, model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null, latestTurn: null, createdAt: at, updatedAt: at,
    session: { threadId: id, status: 'idle', providerName: 'codex', providerInstanceId: instanceId, runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at },
    latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
  })
  return { snapshotSequence: 1, projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [thread('t1', 'codex-work')], updatedAt: at }
}

function provider(instanceId: string, driver: string, usage?: unknown) {
  return { instanceId, driver, displayName: instanceId === 'codex-work' ? 'Codex work' : 'Claude', enabled: true, installed: true, version: '1.0.0', status: 'ready', auth: { status: 'authenticated', type: driver === 'codex' ? 'chatgpt' : 'oauth', label: 'Pro' }, checkedAt: at, models: [], ...(usage ? { usage } : {}) }
}

/** The engine over HTTP: token, ticket, dispatch (created threads join the shell), shell, and thread detail. */
function fetchFor(shellSnapshot: ReturnType<typeof shell>, commands: Array<Record<string, unknown>> = [], server?: ReturnType<typeof fakeEngineServer>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket', expiresAt: at })
    const threads = [...shellSnapshot.threads, ...commands.filter((command) => command.type === 'thread.create').map((command) => ({ ...shellSnapshot.threads[0]!, id: String(command.threadId), title: String(command.title), modelSelection: command.modelSelection as (typeof shellSnapshot.threads)[0]['modelSelection'] }))]
    if (url.endsWith('/api/orchestration/dispatch')) {
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>
      commands.push(command)
      // The engine announces the new thread over the shell subscription, as T3 does.
      if (command.type === 'thread.create') server?.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 100 + commands.length, thread: { ...shellSnapshot.threads[0]!, id: String(command.threadId), title: String(command.title), modelSelection: command.modelSelection } }])
      return Response.json({ sequence: commands.length })
    }
    if (url.endsWith('/api/orchestration/shell')) return Response.json({ ...shellSnapshot, threads })
    const thread = threads.find((candidate) => url.endsWith(`/api/orchestration/threads/${candidate.id}`))
    if (thread) return Response.json({ snapshotSequence: 1, thread: { ...thread, deletedAt: null, messages: [], activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 1, threadSequence: 1 } })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
}

describe('accounts (§5.13)', () => {
  it('a hit limit with a future reset survives a restart and disables that instance in the picker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-accounts-limit-'))
    const resetsAt = new Date(nowMs + 2 * 3_600_000).toISOString()
    const limited = { session: { usedPercent: 100, resetsAt, measuredAt: at, source: 'session' }, weekly: { usedPercent: 35, resetsAt: null, measuredAt: at, source: 'session' }, planLabel: 'Pro', applicable: true }
    let providers: unknown[] = [provider('codex-work', 'codex', limited), provider('claude-main', 'claudeAgent')]
    const server = fakeEngineServer((tag) => tag === 'server.getConfig' ? { providers, settings: { providerInstances: {} } } : tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const socket = server.WebSocket

    const first = new T3EngineClient({ dataDirectory: directory, fetch: fetchFor(shell()), webSocket: socket, now: () => nowMs })
    await first.pair('http://engine.test', 'code')
    const measured = first.view().accounts.find((account) => account.instanceId === 'codex-work')!
    expect(measured).toMatchObject({ state: 'limited', usable: false, limitedUntil: resetsAt, live: true, pressure: 100, plan: 'Pro' })
    expect(first.view().accounts.find((account) => account.instanceId === 'claude-main')).toMatchObject({ state: 'ready', usable: true })
    expect((await stat(join(directory, 'engine-accounts.json'))).mode & 0o777).toBe(0o600)
    await first.shutdown()

    // The engine restarted and has no usage reading yet; Strata still remembers the limit and its reset.
    providers = [provider('codex-work', 'codex'), provider('claude-main', 'claudeAgent')]
    const laterMs = nowMs + 30 * 60_000
    const commands: Array<Record<string, unknown>> = []
    const second = new T3EngineClient({ dataDirectory: directory, fetch: fetchFor(shell(), commands, server), webSocket: socket, now: () => laterMs })
    await second.initialize()
    const remembered = second.view().accounts.find((account) => account.instanceId === 'codex-work')!
    expect(remembered).toMatchObject({ state: 'limited', usable: false, limitedUntil: resetsAt, live: false, measuredAt: at })
    const options = pickerAccountOptions(second.view())
    expect(options.find((option) => option.instanceId === 'codex-work')).toMatchObject({ disabled: true })
    expect(options.find((option) => option.instanceId === 'codex-work')!.label).toMatch(/^Codex work · limited until /)
    expect(options.find((option) => option.instanceId === 'claude-main')).toEqual({ instanceId: 'claude-main', label: 'Claude', disabled: false })

    // Auto skips the limited account; an explicit pick of it is refused.
    await second.createThread({ projectId: 'p1', title: 'Auto', model: 'gpt-5.6', effort: null, access: 'full-access' })
    expect(commands.at(-1)).toMatchObject({ type: 'thread.create', modelSelection: { instanceId: 'claude-main' } })
    await expect(second.createThread({ projectId: 'p1', title: 'Explicit', model: 'gpt-5.6', effort: null, access: 'full-access', instanceId: 'codex-work' })).rejects.toThrow(/Codex work cannot take a thread/)

    // Once the reset has passed with no newer reading, the account is stale but usable again.
    const afterReset = new T3EngineClient({ dataDirectory: directory, fetch: fetchFor(shell()), webSocket: socket, now: () => Date.parse(resetsAt) + 60_000 })
    await afterReset.initialize()
    expect(afterReset.view().accounts.find((account) => account.instanceId === 'codex-work')).toMatchObject({ state: 'stale', usable: true })
    await afterReset.shutdown()
    await second.shutdown()
  })

  it('parking lives in the ghost store, survives a restart, and steers Auto and the terminal launcher', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-accounts-park-'))
    const providers = [provider('codex-work', 'codex', { session: { usedPercent: 10, resetsAt: null, measuredAt: at, source: 'session' }, weekly: null, applicable: true }), provider('codex-home', 'codex', { session: { usedPercent: 60, resetsAt: null, measuredAt: at, source: 'session' }, weekly: null, applicable: true })]
    const settings = { providerInstances: { 'codex-work': { config: { homePath: '/homes/work' } }, 'codex-home': { config: { homePath: '/homes/home' } } } }
    const server = fakeEngineServer((tag) => tag === 'server.getConfig' ? { providers, settings } : tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const socket = server.WebSocket
    const written: Array<{ directory: string; targets: TerminalShimTarget[] }> = []
    const writeShims = async (shimDirectory: string, targets: readonly TerminalShimTarget[]) => { written.push({ directory: shimDirectory, targets: [...targets] }); return [] }
    const commands: Array<Record<string, unknown>> = []

    const first = new T3EngineClient({ dataDirectory: directory, fetch: fetchFor(shell(), commands, server), webSocket: socket, now: () => nowMs, terminalShimDirectory: '/shims', writeShims })
    await first.pair('http://engine.test', 'code')
    await first.createThread({ projectId: 'p1', title: 'Least loaded', model: 'gpt-5.6', effort: null, access: 'full-access' })
    expect(commands.at(-1)).toMatchObject({ modelSelection: { instanceId: 'codex-work' } })
    // Accounts shows the same choice as an Auto mark on the row (§5.13).
    expect(first.view().autoInstanceIds).toEqual({ codex: 'codex-work' })

    await first.parkAccount('codex-work', true)
    expect(first.view().accounts.find((account) => account.instanceId === 'codex-work')).toMatchObject({ state: 'parked', parked: true, usable: false })
    expect(first.view().autoInstanceIds).toEqual({ codex: 'codex-home' })
    await first.createThread({ projectId: 'p1', title: 'Parked skipped', model: 'gpt-5.6', effort: null, access: 'full-access' })
    expect(commands.at(-1)).toMatchObject({ modelSelection: { instanceId: 'codex-home' } })

    await first.setTerminalDefault('codex', 'auto')
    expect(first.view().terminalDefaults).toEqual({ codex: 'auto' })
    expect(written.at(-1)).toEqual({ directory: '/shims', targets: [{ name: 'codex', command: 'codex', homeVariable: 'CODEX_HOME', home: '/homes/home' }] })
    expect(first.view().terminalShimDirectory).toBe('/shims')
    await first.shutdown()

    const stored = JSON.parse(await readFile(join(directory, 'engine-accounts.json'), 'utf8')) as { parked: string[]; terminalDefaults: Record<string, string | null> }
    expect(stored.parked).toEqual(['codex-work'])
    expect(stored.terminalDefaults).toEqual({ codex: 'auto' })

    const second = new T3EngineClient({ dataDirectory: directory, fetch: fetchFor(shell()), webSocket: socket, now: () => nowMs, terminalShimDirectory: '/shims', writeShims })
    await second.initialize()
    expect(second.view().accounts.find((account) => account.instanceId === 'codex-work')).toMatchObject({ state: 'parked', parked: true })
    expect(pickerAccountOptions(second.view()).find((option) => option.instanceId === 'codex-work')).toEqual({ instanceId: 'codex-work', label: 'Codex work · parked', disabled: true })
    await second.parkAccount('codex-work', false)
    expect(second.view().accounts.find((account) => account.instanceId === 'codex-work')).toMatchObject({ state: 'ready', usable: true, pressure: 10 })
    // Auto sticks with the account it last chose while that one stays usable, so the launcher does not flap.
    expect(written.at(-1)!.targets[0]!.home).toBe('/homes/home')
    await second.shutdown()
  })

  it('a config the engine cannot serve keeps the connection and the last measurement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-accounts-offline-'))
    let serve = true
    const server = fakeEngineServer((tag) => tag === 'server.getConfig' && serve ? { providers: [provider('codex-work', 'codex', { session: { usedPercent: 50, resetsAt: null, measuredAt: at, source: 'session' }, weekly: null, applicable: true })] } : tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const socket = server.WebSocket
    const client = new T3EngineClient({ dataDirectory: directory, fetch: fetchFor(shell()), webSocket: socket, now: () => nowMs })
    await client.pair('http://engine.test', 'code')
    expect(client.view().accounts[0]).toMatchObject({ pressure: 50, live: true })
    serve = false
    await expect(client.refreshAccounts()).rejects.toThrow()
    expect(client.view().state).toBe('connected')
    await client.shutdown()
  })
})
