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

    const first = new T3EngineClient({ measureUsage: async provider => provider.instanceId === 'codex-work' ? { ...limited, measuredAt: at } : null, localUsageAvailable: () => true, dataDirectory: directory, fetch: fetchFor(shell()), webSocket: socket, now: () => nowMs })
    await first.pair('http://engine.test', 'code')
    const measured = first.view().accounts.find((account) => account.instanceId === 'codex-work')!
    expect(measured).toMatchObject({ state: 'limited', usable: false, limitedUntil: resetsAt, live: false, pressure: 100, plan: 'Pro' })
    expect(first.view().accounts.find((account) => account.instanceId === 'claude-main')).toMatchObject({ state: 'stale', usable: true })
    await first.shutdown()
    expect((await stat(join(directory, 'engine-accounts.json'))).mode & 0o777).toBe(0o600)

    // The engine restarted and has no usage reading yet; Strata still remembers the limit and its reset.
    providers = [provider('codex-work', 'codex'), provider('claude-main', 'claudeAgent')]
    const laterMs = nowMs + 30 * 60_000
    const commands: Array<Record<string, unknown>> = []
    const second = new T3EngineClient({ localUsageAvailable: () => true, dataDirectory: directory, fetch: fetchFor(shell(), commands, server), webSocket: socket, now: () => laterMs })
    await second.initialize()
    const remembered = second.view().accounts.find((account) => account.instanceId === 'codex-work')!
    expect(remembered).toMatchObject({ state: 'limited', usable: false, limitedUntil: resetsAt, live: false, measuredAt: at })
    const options = pickerAccountOptions(second.view())
    expect(options.find((option) => option.instanceId === 'codex-work')).toMatchObject({ disabled: true })
    expect(options.find((option) => option.instanceId === 'codex-work')!.label).toMatch(/^Codex work · limited until /)
    expect(options.find((option) => option.instanceId === 'claude-main')).toEqual({ instanceId: 'claude-main', label: 'Claude', disabled: false })

    // Auto skips the limited account; an explicit pick of it is refused.
    await second.createThread({ projectId: 'p1', title: 'Auto', model: 'claude-fable-5-1', effort: null, access: 'full-access' })
    expect(commands.at(-1)).toMatchObject({ type: 'thread.create', modelSelection: { instanceId: 'claude-main' } })
    await expect(second.createThread({ projectId: 'p1', title: 'Explicit', model: 'gpt-5.6', effort: null, access: 'full-access', instanceId: 'codex-work' })).rejects.toThrow(/Codex work cannot take a thread/)

    // Once the reset has passed with no newer reading, the account is stale but usable again.
    const afterReset = new T3EngineClient({ localUsageAvailable: () => true, dataDirectory: directory, fetch: fetchFor(shell()), webSocket: socket, now: () => Date.parse(resetsAt) + 60_000 })
    await afterReset.initialize()
    expect(afterReset.view().accounts.find((account) => account.instanceId === 'codex-work')).toMatchObject({ state: 'stale', usable: true })
    await afterReset.shutdown()
    await second.shutdown()
  })

  it('parking lives in the ghost store, survives a restart, and steers Auto and the terminal launcher', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-accounts-park-'))
    const providers = [provider('codex-work', 'codex', { session: { usedPercent: 10, resetsAt: null, measuredAt: at, source: 'session' }, weekly: null, applicable: true }), provider('codex-home', 'codex', { session: { usedPercent: 60, resetsAt: null, measuredAt: at, source: 'session' }, weekly: null, applicable: true })]
    const settings = { providerInstances: { 'codex-work': { driver: 'codex', config: { homePath: '/homes/work' } }, 'codex-home': { driver: 'codex', config: { homePath: '/homes/home' } } } }
    const server = fakeEngineServer((tag) => tag === 'server.getConfig' ? { providers, settings } : tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const socket = server.WebSocket
    const written: Array<{ directory: string; targets: TerminalShimTarget[] }> = []
    const writeShims = async (shimDirectory: string, targets: readonly TerminalShimTarget[]) => { written.push({ directory: shimDirectory, targets: [...targets] }); return [] }
    const commands: Array<Record<string, unknown>> = []

    const first = new T3EngineClient({ measureUsage: async provider => ({ session: { usedPercent: provider.instanceId === 'codex-work' ? 10 : 60, resetsAt: null, measuredAt: at }, weekly: null, applicable: true, measuredAt: at }), localUsageAvailable: () => true, dataDirectory: directory, fetch: fetchFor(shell(), commands, server), webSocket: socket, now: () => nowMs, terminalShimDirectory: '/shims', writeShims })
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

    const second = new T3EngineClient({ localUsageAvailable: () => true, dataDirectory: directory, fetch: fetchFor(shell()), webSocket: socket, now: () => nowMs, terminalShimDirectory: '/shims', writeShims })
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
    const client = new T3EngineClient({ measureUsage: async () => ({ session: { usedPercent: 50, resetsAt: null, measuredAt: at }, weekly: null, applicable: true, measuredAt: at }), localUsageAvailable: () => true, dataDirectory: directory, fetch: fetchFor(shell()), webSocket: socket, now: () => nowMs })
    await client.pair('http://engine.test', 'code')
    expect(client.view().accounts[0]).toMatchObject({ pressure: 50, live: false })
    serve = false
    await expect(client.refreshAccounts()).rejects.toThrow()
    expect(client.view().state).toBe('connected')
    await client.shutdown()
  })
})

it('never probes a busy Codex account and finishes cancelling its idle probe before posting a turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-usage-turn-'))
  const snapshot = shell()
  const original = snapshot.threads[0]!.session
  snapshot.threads[0]!.session = { ...original, status: 'running' }
  const providers = [provider('codex-work', 'codex')]
  const server = fakeEngineServer(tag => tag === 'server.getConfig' ? { providers } : tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
  const commands: Array<Record<string, unknown>> = []
  let probes = 0, cancelled = false
  const underlying = fetchFor(snapshot, commands, server)
  const client = new T3EngineClient({ dataDirectory: directory, terminalShimDirectory: null, localUsageAvailable: () => true, webSocket: server.WebSocket, fetch: async (url, init) => {
    if (String(url).endsWith('/dispatch') && JSON.parse(String(init?.body)).type === 'thread.turn.start') expect(cancelled).toBe(true)
    return underlying(url, init)
  }, measureUsage: async (_provider, _settings, signal) => { probes++; return new Promise(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(null) }, { once: true })) } })
  try {
    await client.pair('http://engine.test', 'pair-code')
    expect(probes).toBe(0)
    snapshot.threads[0]!.session = original
    await client.reconnect(); await client.refreshAccounts()
    expect(probes).toBe(1)
    await client.startTurn('t1', { text: 'Test the ordering.', model: 'gpt-5.6', instanceId: 'codex-work', effort: null, access: 'full-access' })
    expect(cancelled).toBe(true)
    expect(commands.some(command => command.type === 'thread.turn.start')).toBe(true)
    await client.refreshAccounts()
    expect(probes).toBe(1)
  } finally { await client.shutdown() }
})


it('cancels its Codex reader when another client starts a turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-usage-remote-turn-'))
  const snapshot = shell()
  const server = fakeEngineServer(tag => tag === 'server.getConfig' ? { providers: [provider('codex-work', 'codex')] } : tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
  let cancelled = false
  const client = new T3EngineClient({ dataDirectory: directory, terminalShimDirectory: null, localUsageAvailable: () => true, webSocket: server.WebSocket, fetch: fetchFor(snapshot), measureUsage: async (_provider, _settings, signal) => new Promise(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(null) }, { once: true })) })
  try {
    await client.pair('http://engine.test', 'pair-code')
    const thread = snapshot.threads[0]!
    server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 2, thread: { ...thread, session: { ...thread.session, status: 'running', activeTurnId: 'from-phone' } } }])
    await expect.poll(() => cancelled).toBe(true)
    expect(client.view().projects[0]?.threads[0]?.status).toBe('running')
  } finally { await client.shutdown() }
})

it('persists Fable limits, routes Auto within the model family, and permits another Claude model on a Fable-limited account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-fable-routing-'))
  const providers = [provider('codex-work', 'codex'), provider('claude-full', 'claudeAgent'), provider('claude-ready', 'claudeAgent')]
  const server = fakeEngineServer(tag => tag === 'server.getConfig' ? { providers } : tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
  const commands: Array<Record<string, unknown>> = []
  const client = new T3EngineClient({ dataDirectory: directory, now: () => nowMs, localUsageAvailable: () => true, fetch: fetchFor(shell(), commands, server), webSocket: server.WebSocket,
    measureUsage: async p => ({ session: { usedPercent: 0, resetsAt: null, measuredAt: at }, weekly: { usedPercent: p.instanceId === 'claude-ready' ? 60 : 20, resetsAt: null, measuredAt: at }, modelWindows: p.driver === 'claudeAgent' ? [{ model: 'Fable', usedPercent: p.instanceId === 'claude-full' ? 100 : 39, resetsAt: '2026-09-04T00:00:00Z', measuredAt: at }] : [], applicable: true, measuredAt: at }) })
  try {
    await client.pair('http://engine.test', 'code')
    await vi.waitFor(() => expect(client.view().accounts.every(account => !account.usageRefreshing)).toBe(true))
    expect(client.view().autoInstanceIds?.claudeAgent).toBe('claude-ready')
    await expect(client.createThread({ projectId: 'p1', title: 'Blocked', model: 'claude-fable-5-1', instanceId: 'claude-full', effort: null, access: 'full-access' })).rejects.toThrow('Fable limit reached')
    expect(commands).toHaveLength(0)
    await client.createThread({ projectId: 'p1', title: 'Auto Fable', model: 'claude-fable-5-1', effort: null, access: 'full-access' })
    expect(commands.at(-1)).toMatchObject({ modelSelection: { instanceId: 'claude-ready' } })
    await client.createThread({ projectId: 'p1', title: 'Sonnet still works', model: 'claude-sonnet-5', instanceId: 'claude-full', effort: null, access: 'full-access' })
    expect(commands.at(-1)).toMatchObject({ modelSelection: { instanceId: 'claude-full' } })
    await expect(client.startTurn(String(commands.at(-1)!.threadId), { text: 'Switch to Fable', model: 'claude-fable-5-1', instanceId: 'claude-full', effort: null, access: 'full-access' })).rejects.toThrow('Fable limit reached')
    const { readAccountsStore } = await import('../../src/main/engine/accounts')
    expect((await readAccountsStore(join(directory, 'engine-accounts.json'))).measurements['claude-full']?.modelWindows).toMatchObject([{ model: 'Fable', usedPercent: 100 }])
  } finally { await client.shutdown() }
})

it('explicit Refresh bypasses disabled polling and exposes failed readings without replacing their timestamps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-refresh-usage-'))
  const server = fakeEngineServer(tag => tag === 'server.getConfig' ? { providers: [provider('claude', 'claudeAgent')], settings: { providerHealthRefreshInterval: 0 } } : tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
  let fail = false
  const measureUsage = vi.fn(async () => fail ? null : ({ session: { usedPercent: 14, resetsAt: null, measuredAt: at }, weekly: null, applicable: true, measuredAt: at }))
  const client = new T3EngineClient({ dataDirectory: directory, now: () => nowMs, localUsageAvailable: () => true, fetch: fetchFor(shell()), webSocket: server.WebSocket, measureUsage })
  try {
    await client.pair('http://engine.test', 'code')
    expect(measureUsage).not.toHaveBeenCalled()
    await client.refreshAccounts()
    await vi.waitFor(() => expect(client.view().accounts[0]).toMatchObject({ measuredAt: at, usageRefreshing: false }))
    fail = true
    await client.refreshAccounts()
    await vi.waitFor(() => expect(client.view().accounts[0]?.usageProblem).toContain('could not be refreshed'))
    expect(client.view().accounts[0]).toMatchObject({ state: 'stale', measuredAt: at, session: { usedPercent: 14 } })
    fail = false
    await client.refreshAccounts()
    await vi.waitFor(() => expect(client.view().accounts[0]).toMatchObject({ state: 'ready', usageProblem: null, usageRefreshing: false }))
  } finally { await client.shutdown() }
})

it('maps remote engine windows, sparse updates, failed probes and unsupported reports without local probes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-reported-usage-'))
  const weekly = { id: 'primary', kind: 'weekly', label: 'Week', usedPercent: 26, resetsAt: '2026-09-05T12:00:00.000Z', windowDurationMins: 10080 }
  let report: Record<string, unknown> = { checkedAt: at, windows: [weekly, { ...weekly, id: 'monthly', kind: 'monthly', label: 'Monthly', usedPercent: 100 }] }
  const config = () => ({ providers: [{ ...provider('codex-work', 'codex'), usageLimits: report }, provider('claude-main', 'claudeAgent')], usageLimitSources: [], settings: {} })
  const server = fakeEngineServer(tag => tag === 'server.getConfig' ? config() : tag.includes('subscribe') ? [] : null)
  const measureUsage = vi.fn(async () => null)
  const client = new T3EngineClient({ dataDirectory: directory, now: () => nowMs, fetch: fetchFor(shell()), webSocket: server.WebSocket, measureUsage, localUsageAvailable: () => true })
  try {
    await client.pair('http://engine.test', 'code')
    expect(client.view().accounts[0]).toMatchObject({ state: 'limited', pressure: 100, session: null, weekly: null, measuredAt: at, windows: [{ id: 'primary' }, { id: 'monthly' }] })
    expect(measureUsage).not.toHaveBeenCalled()
    report = { checkedAt: at, windows: [{ ...weekly, usedPercent: 42 }] }
    server.push('subscribeServerConfig', [{ version: 1, type: 'providerStatuses', payload: config() }])
    await vi.waitFor(() => expect(client.view().accounts[0]?.windows?.[0]?.usedPercent).toBe(42))
    expect(client.view().accounts[0]?.windows).toHaveLength(2)
    report = { checkedAt: '2026-09-03T12:01:00.000Z', windows: [], unavailable: { reason: 'probeFailed', message: 'Provider is offline' } }
    await client.refreshAccounts()
    expect(client.view().accounts[0]).toMatchObject({ measuredAt: at, usageProblem: 'Provider is offline', windows: [{ usedPercent: 42 }, { usedPercent: 100 }] })
    report = { checkedAt: at, windows: [], unavailable: { reason: 'unsupported' } }
    await client.refreshAccounts()
    expect(client.view().accounts[0]).toMatchObject({ windows: [], usageUnsupported: true, pressure: 0, state: 'ready' })
  } finally { await client.shutdown() }
})

it('guards reset credits and returns the actual provider outcome for instances and source accounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-reset-credit-'))
  let report: Record<string, unknown> = { checkedAt: at, windows: [], resetCredits: { availableCount: 1 } }
  let outcome = 'nothingToReset'
  const sourceReport = { checkedAt: at, windows: [], resetCredits: { availableCount: 1, nextCreditId: 'credit-1' } }
  const server = fakeEngineServer(tag => tag === 'server.getConfig' ? { providers: [{ ...provider('codex-work', 'codex'), usageLimits: report }], usageLimitSources: [{ id: 'hub', kind: 'cliproxy', label: 'Hub', checkedAt: at, accounts: [{ id: 'hub-account', driver: 'codex', usageLimits: sourceReport }] }] } : tag === 'provider.consumeResetCredit' ? { outcome } : tag.includes('subscribe') ? [] : null)
  const client = new T3EngineClient({ dataDirectory: directory, now: () => nowMs, fetch: fetchFor(shell()), webSocket: server.WebSocket })
  try {
    await client.pair('http://engine.test', 'code')
    expect(client.view().accounts).toHaveLength(1)
    expect(client.view().usageLimitSources?.[0]?.accounts).toHaveLength(1)
    await expect(client.consumeResetCredit({ instanceId: 'codex-work' })).resolves.toEqual({ outcome: 'nothingToReset' })
    outcome = 'alreadyRedeemed'
    await expect(client.consumeResetCredit({ sourceId: 'hub', accountId: 'hub-account', creditId: 'credit-1' })).resolves.toEqual({ outcome: 'alreadyRedeemed' })
    expect(server.requests.filter(request => request.tag === 'provider.consumeResetCredit').at(-1)?.payload).toEqual({ sourceId: 'hub', accountId: 'hub-account', creditId: 'credit-1' })
    await expect(client.consumeResetCredit({ sourceId: 'hub', accountId: 'hub-account', creditId: 'old-credit' })).rejects.toThrow('No current reset credit')
    report = { ...report, resetCredits: { availableCount: 0 } }
    await client.refreshAccounts()
    await expect(client.consumeResetCredit({ instanceId: 'codex-work' })).rejects.toThrow('No current reset credit')
    expect(server.requests.filter(request => request.tag === 'provider.consumeResetCredit')).toHaveLength(2)
  } finally { await client.shutdown() }
})

it('keeps native model-scoped limits selective and retains reset metadata across sparse updates', async () => {
  const { providerInstancesOf, accountViews, emptyAccountsStore, recordMeasurements } = await import('../../src/main/engine/accounts')
  const { serverConfigSlice } = await import('../../src/main/engine/t3-contract')
  const { accountForModel } = await import('../../src/core/accountState')
  const resetsAt = '2026-09-05T12:00:00.000Z'
  const parse = (windows: unknown[]) => providerInstancesOf(serverConfigSlice.parse({ providers: [{ ...provider('claude', 'claudeAgent'), usageLimits: { checkedAt: at, windows } }] }))
  const full = parse([{ id: 'seven_day_fable', kind: 'weekly', label: 'Weekly · Fable', usedPercent: 100, resetsAt, windowDurationMins: 10080 }, { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt, windowDurationMins: 10080 }])
  let store = recordMeasurements(emptyAccountsStore(), full, at)
  const sparse = parse([{ id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 15 }])
  store = recordMeasurements(store, sparse, at)
  const account = accountViews(store, sparse, nowMs)[0]!
  expect(account.windows).toMatchObject([{ id: 'seven_day_fable', usedPercent: 100 }, { id: 'seven_day', usedPercent: 15, resetsAt, windowDurationMins: 10080 }])
  expect(accountForModel(account, 'claude-fable-5-1', nowMs)).toMatchObject({ usable: false, reason: 'Fable limit reached' })
  expect(accountForModel(account, 'claude-sonnet-5', nowMs)).toMatchObject({ usable: true, pressure: 15 })
})
