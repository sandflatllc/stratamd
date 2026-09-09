import { type UsageLimits } from '../../shared/usage-limits'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { atomicWriteFile, isRecord, PRIVATE_FILE_MODE } from '../storage'
import { accountForModel, deriveAccountState, resolveNewThreadInstance, type AccountProvider, type AccountUsage, type ModelUsageWindow, type UsageWindow } from '../../core/accountState'
import type { AccountView } from '../../shared/contracts'
import type { T3ServerConfigSlice } from './t3-contract'

/**
 * What Strata keeps about provider accounts between runs (§5.13): the owner's
 * parking choices, the last usage measurement per instance with its reset
 * schedule, the instance Auto last chose, and the terminal default per driver.
 * Lives in the ghost store beside the engine credential, never in settings.json.
 */
export interface AccountsStore {
  formatVersion: 1
  parked: string[]
  measurements: Record<string, AccountMeasurement>
  stickyInstanceId: string | null
  /** Per driver: `auto`, an instance id, or null for the system default (§5.13 terminal defaults). */
  terminalDefaults: Record<string, string | null>
  modelPreferences?: Record<string, { favorites: string[]; hidden: string[]; order?: string[] }>
}

export interface AccountMeasurement {
  windows?: UsageWindow[] | undefined
  checkedAt?: string | undefined
  accountKey?: string
  session: UsageWindow | null
  weekly: UsageWindow | null
  modelWindows?: ModelUsageWindow[]
  planLabel?: string
  applicable: boolean
  measuredAt: string
}

/** A provider instance as the engine's configuration reports it, already narrowed to what accounts need. */
export interface EngineProviderInstance {
  instanceId: string
  driver: string
  displayName: string
  homePath: string | null
  enabled: boolean
  installed: boolean
  commands?: import("../../shared/provider-commands").ProviderCommandCatalog
  usageReporting?: boolean
  usageLocal?: boolean
  accentColor?: string
  status: string
  availability?: string
  unavailableReason?: string
  message?: string
  auth: { status: string; type?: string; label?: string; email?: string }
  usageLimits?: UsageLimits | undefined
  usage?: AccountUsage | undefined
}

/** Narrows `server.getConfig` to the instances Accounts shows; the home path comes from the instance settings when the owner set one. */
export function providerInstancesOf(config: T3ServerConfigSlice): EngineProviderInstance[] {
  return config.providers.map((provider) => {
    const home = config.settings?.providerInstances?.[provider.instanceId]?.config?.homePath?.trim()
    return {
      usageReporting: config.usageLimitSources !== undefined || config.providers.some(item => item.usageLimits !== undefined),
      usageLimits: provider.usageLimits,
      ...(provider.usageLimits ? { usage: usageOf(provider.usageLimits, provider.driver) } : {}),
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.instanceId,
      commands: { instanceId: provider.instanceId, slashCommands: provider.slashCommands, skills: provider.skills, workspaceSnapshots: provider.workspaceSnapshots },
      homePath: home || null,
      enabled: provider.enabled,
      installed: provider.installed,
      status: provider.status,
      ...(provider.availability ? { availability: provider.availability } : {}),
      ...(provider.unavailableReason ? { unavailableReason: provider.unavailableReason } : {}),
      ...(provider.message ? { message: provider.message } : {}),
      auth: { status: provider.auth.status, ...(provider.auth.type ? { type: provider.auth.type } : {}), ...(provider.auth.label ? { label: provider.auth.label } : {}), ...(provider.auth.email ? { email: provider.auth.email } : {}) },
      ...(typeof config.settings?.providerInstances?.[provider.instanceId]?.accentColor === 'string' ? { accentColor: config.settings!.providerInstances![provider.instanceId]!.accentColor as string } : {}),
    }
  })
}

export function emptyAccountsStore(): AccountsStore {
  return { formatVersion: 1, parked: [], measurements: {}, stickyInstanceId: null, terminalDefaults: {} }
}

function window(value: unknown): UsageWindow | null {
  if (!isRecord(value)) return null
  if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) || typeof value.measuredAt !== 'string') return null
  return { ...value, usedPercent: value.usedPercent, resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null, measuredAt: value.measuredAt }
}

export function normalizeAccountsStore(value: unknown): AccountsStore {
  const store = emptyAccountsStore()
  if (!isRecord(value) || value.formatVersion !== 1) return store
  if (Array.isArray(value.parked)) store.parked = value.parked.filter((item): item is string => typeof item === 'string')
  if (isRecord(value.measurements)) {
    for (const [instanceId, raw] of Object.entries(value.measurements)) {
      if (!isRecord(raw) || typeof raw.measuredAt !== 'string') continue
      store.measurements[instanceId] = {
        ...(typeof raw.accountKey === 'string' ? { accountKey: raw.accountKey } : {}),
        modelWindows: Array.isArray(raw.modelWindows) ? raw.modelWindows.flatMap(value => { const reading = window(value); return reading && isRecord(value) && typeof value.model === 'string' && value.model.trim() ? [{ ...reading, model: value.model }] : [] }) : [],
        windows: Array.isArray(raw.windows) ? raw.windows.map(window).filter((item): item is UsageWindow => !!item) : undefined,
        checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : undefined,
        session: window(raw.session), weekly: window(raw.weekly), applicable: raw.applicable !== false, measuredAt: raw.measuredAt,
        ...(typeof raw.planLabel === 'string' ? { planLabel: raw.planLabel } : {}),
      }
    }
  }
  if (typeof value.stickyInstanceId === 'string') store.stickyInstanceId = value.stickyInstanceId
  if (isRecord(value.terminalDefaults)) {
    for (const [driver, selection] of Object.entries(value.terminalDefaults)) {
      if (selection === null || typeof selection === 'string') store.terminalDefaults[driver] = selection
    }
  }
  if (isRecord(value.modelPreferences)) {
    store.modelPreferences = Object.fromEntries(Object.entries(value.modelPreferences).flatMap(([id, raw]) => {
      if (!isRecord(raw)) return []
      const strings = (input: unknown) => Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
      return [[id, { favorites: strings(raw.favorites), hidden: strings(raw.hidden), order: strings(raw.order) }]]
    }))
  }
  return store
}

export async function readAccountsStore(path: string): Promise<AccountsStore> {
  try { return normalizeAccountsStore(JSON.parse(await readFile(path, 'utf8'))) } catch { return emptyAccountsStore() }
}

export async function writeAccountsStore(path: string, store: AccountsStore): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
}

/**
 * Folds the engine's live usage into the persisted measurements. A live
 * measurement replaces the stored one; an instance the server reports without
 * usage keeps what Strata last measured, so a limit with a future reset
 * survives a restart and still disables the instance in the picker.
 */
export function recordMeasurements(store: AccountsStore, providers: readonly EngineProviderInstance[], nowIso: string): AccountsStore {
  let changed = false
  const measurements = { ...store.measurements }
  for (const provider of providers) {
    if (!provider.usage || provider.usageLimits?.unavailable?.reason === 'probeFailed') continue
    const next: AccountMeasurement = {
      windows: mergeWindows(measurements[provider.instanceId]?.accountKey === measurementAccountKey(provider) ? measurements[provider.instanceId]?.windows : undefined, provider.usage),
      checkedAt: provider.usage.checkedAt,
      accountKey: measurementAccountKey(provider),
      modelWindows: provider.usage.modelWindows ?? [],
      session: provider.usage.session, weekly: provider.usage.weekly, applicable: provider.usage.applicable, measuredAt: provider.usage.checkedAt ?? nowIso,
      ...(provider.usage.planLabel ? { planLabel: provider.usage.planLabel } : {}),
    }
    const previous = measurements[provider.instanceId]
    if (previous && JSON.stringify({ ...previous, measuredAt: '' }) === JSON.stringify({ ...next, measuredAt: '' })) continue
    measurements[provider.instanceId] = next
    changed = true
  }
  return changed ? { ...store, measurements } : store
}

function measurementAccountKey(instance: EngineProviderInstance): string { return createHash('sha256').update(JSON.stringify([instance.driver, instance.auth.email?.trim().toLowerCase() ?? '', instance.homePath ?? ''])).digest('hex') }
function measurementFor(instance: EngineProviderInstance, store: AccountsStore): AccountMeasurement | undefined {
  const stored = store.measurements[instance.instanceId]
  return instance.usageLocal === false && !instance.usageLimits || stored?.accountKey && stored.accountKey !== measurementAccountKey(instance) ? undefined : stored
}

function providerFor(instance: EngineProviderInstance, store: AccountsStore): AccountProvider {
  const measurement = measurementFor(instance, store)
  const usage = instance.usageLimits?.unavailable?.reason === 'probeFailed' && measurement ? { ...measurement } : instance.usage && instance.usageLimits ? { ...instance.usage, windows: mergeWindows(measurement?.windows, instance.usage) } : instance.usage ?? (measurement ? { windows: measurement.windows, checkedAt: measurement.checkedAt, modelWindows: measurement.modelWindows ?? [], session: measurement.session, weekly: measurement.weekly, applicable: measurement.applicable, ...(measurement.planLabel ? { planLabel: measurement.planLabel } : {}) } : undefined)
  return {
    instanceId: instance.instanceId, driver: instance.driver, enabled: instance.enabled, status: instance.status,
    ...(instance.availability ? { availability: instance.availability } : {}),
    ...(instance.unavailableReason ? { unavailableReason: instance.unavailableReason } : {}),
    ...(instance.message ? { message: instance.message } : {}),
    auth: instance.auth,
    ...(usage ? { usage } : {}),
  }
}

/** The account rows the modal and the picker share (§5.13). */
export function accountViews(store: AccountsStore, providers: readonly EngineProviderInstance[], nowMs: number): AccountView[] {
  return providers.map((instance) => {
    const provider = providerFor(instance, store)
    const parked = store.parked.includes(instance.instanceId)
    const derived = deriveAccountState({ provider, parked, nowMs })
    const measurement = measurementFor(instance, store)
    return {
      instanceId: instance.instanceId,
      installed: instance.installed, enabled: instance.enabled,
      providerReady: instance.installed && deriveAccountState({ provider, parked: false, nowMs }).usable,
      ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
      usageAvailable: !!instance.usageLimits || instance.usageLocal !== false,
      usageUnsupported: instance.usageLimits?.unavailable?.reason === 'unsupported',
      usageProblem: instance.usageLimits?.unavailable?.reason === 'probeFailed' ? instance.usageLimits.unavailable.message ?? 'Usage refresh failed' : null,
      resetCredits: instance.usageLimits?.resetCredits,
      windows: provider.usage?.windows,
      driver: instance.driver,
      name: instance.displayName,
      homePath: instance.homePath,
      email: instance.auth.email ?? null,
      plan: instance.auth.label ?? provider.usage?.planLabel ?? null,
      state: derived.state,
      usable: derived.usable,
      reason: derived.reason,
      limitedUntil: derived.limitedUntil,
      pressure: derived.pressure,
      parked,
      session: provider.usage?.session ?? null,
      weekly: provider.usage?.weekly ?? null,
      modelWindows: [...(provider.usage?.modelWindows ?? []), ...(provider.usage?.windows ?? []).flatMap(window => window.modelScope ? [{ ...window, model: window.modelScope }] : [])],
      measuredAt: provider.usage?.checkedAt ?? measurement?.measuredAt ?? (instance.usage ? nowIso(nowMs) : null),
      live: instance.usage !== undefined,
    }
  })
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString()
}

/**
 * Auto (§5.13): the picker's choice is explicit when the owner picked an
 * instance; otherwise the fork's ordering picks the least loaded usable
 * account, sticking with the last choice while it stays usable.
 */
export function chooseInstance(store: AccountsStore, accounts: readonly AccountView[], explicitInstanceId: string | null, driver: string | null = null, model = '', nowMs = Date.now()): string | null {
  const candidates = accounts
    .filter((account) => driver === null || account.driver === driver)
    .map(account => model ? accountForModel(account, model, nowMs) : account)
    .map((account) => ({ instanceId: account.instanceId, derived: { state: account.state, usable: account.usable, tier: account.state === 'ready' && account.pressure !== null ? 0 as const : account.state === 'ready' ? 1 as const : 2 as const, limitedUntil: account.limitedUntil, pressure: account.pressure, reason: account.reason } }))
  return resolveNewThreadInstance({
    candidates,
    startedThreadInstanceId: null,
    explicitInstanceId,
    projectDefaultInstanceId: null,
    newThreadDefault: 'auto',
    stickyInstanceId: store.stickyInstanceId,
  })
}

/** The launcher scripts Strata writes on Linux (§5.13): one per driver whose terminal default resolves to an instance with a home. */
export function terminalShimTargets(store: AccountsStore, accounts: readonly AccountView[]): Array<{ name: string; command: string; homeVariable: string; home: string }> {
  const drivers: Record<string, { command: string; homeVariable: string }> = {
    codex: { command: 'codex', homeVariable: 'CODEX_HOME' },
    claudeAgent: { command: 'claude', homeVariable: 'CLAUDE_CONFIG_DIR' },
  }
  const targets: Array<{ name: string; command: string; homeVariable: string; home: string }> = []
  for (const [driver, shim] of Object.entries(drivers)) {
    const selection = store.terminalDefaults[driver] ?? null
    if (selection === null) continue
    const instanceId = selection === 'auto' ? chooseInstance(store, accounts, null, driver, driver === 'claudeAgent' ? 'fable' : '') : selection
    const account = accounts.find((candidate) => candidate.instanceId === instanceId && candidate.driver === driver)
    if (!account?.homePath) continue
    targets.push({ name: shim.command, command: shim.command, homeVariable: shim.homeVariable, home: account.homePath })
  }
  return targets
}

function usageOf(limits: UsageLimits, driver: string): AccountUsage {
  return { session: null, weekly: null, applicable: limits.unavailable?.reason !== 'unsupported', checkedAt: limits.checkedAt, windows: limits.windows.map(window => ({ ...window, ...(driver === 'claudeAgent' && window.id.startsWith('seven_day_') && window.label.startsWith('Weekly · ') ? { modelScope: window.label.slice('Weekly · '.length) } : {}), resetsAt: window.resetsAt ?? null, measuredAt: limits.checkedAt })) }
}
function mergeWindows(previous: UsageWindow[] | undefined, next: AccountUsage): UsageWindow[] | undefined {
  if (!next.applicable) return []
  if (!next.windows) return undefined
  const windows = new Map(previous?.map(window => [window.id, window]))
  for (const window of next.windows) { const old = windows.get(window.id); windows.set(window.id, { ...old, ...window, resetsAt: window.resetsAt ?? old?.resetsAt ?? null, ...(window.windowDurationMins === undefined && old?.windowDurationMins !== undefined ? { windowDurationMins: old.windowDurationMins } : {}) }) }
  return [...windows.values()]
}
