import { z } from 'zod'
import type { EngineSettings, ProviderInstanceSettings } from './contracts'

const option = z.object({ id: z.string().min(1), value: z.union([z.string(), z.boolean()]) }).strict()
export const generatedModelSchema = z.object({ instanceId: z.string().min(1), model: z.string().min(1), options: z.array(option).optional() }).strict()
export type GeneratedModel = z.infer<typeof generatedModelSchema>
export const backgroundProfileSchema = z.enum(['balanced', 'performance', 'battery-saver'])
const duration = z.number().finite().nonnegative().nullable()
export const backgroundOverridesSchema = z.object({
  automaticGitFetchInterval: duration.optional(), providerHealthRefreshInterval: duration.optional(),
  hostPowerMonitorActiveInterval: duration.optional(), hostPowerMonitorIdleInterval: duration.optional(), idleClientTtl: duration.optional(),
  pauseWhenHostLocked: z.boolean().nullable().optional(), pauseWhenHostLowPower: z.boolean().nullable().optional(),
  pauseWhenClientLowPower: z.boolean().nullable().optional(), pauseWhenOnBattery: z.boolean().nullable().optional(),
}).strict()
export const engineSettingsPatchSchema = z.object({
  defaultThreadEnvMode: z.enum(['local', 'worktree']).optional(), newWorktreesStartFromOrigin: z.boolean().optional(),
  addProjectBaseDirectory: z.string().max(16384).optional(), sidebarAutoSettleOnMerge: z.boolean().optional(),
  sidebarAutoSettleAfterDays: z.number().int().min(1).max(90).nullable().optional(),
  textGenerationModelSelection: generatedModelSchema.optional(), enableProviderUpdateChecks: z.boolean().optional(),
  backgroundActivity: z.object({ schemaVersion: z.literal(1).optional(), profile: z.enum(['balanced', 'performance', 'battery-saver', 'custom']).optional(), baseProfile: backgroundProfileSchema.optional(), overrides: backgroundOverridesSchema.optional() }).strict().optional(),
  sourceControlWritingStyle: z.object({ mode: z.enum(['repo_conventions', 'conventional_commits', 'custom']).optional(), customInstructions: z.string().max(65536).optional(), followChangeRequestTemplates: z.boolean().optional() }).strict().optional(),
  sourceControlWriterModelSelection: generatedModelSchema.nullable().optional(),
}).strict()
export type EngineSettingsPatch = z.infer<typeof engineSettingsPatchSchema>
export interface EngineSettingsEdit { identity: string | null; base: EngineSettings; patch: EngineSettingsPatch }
export interface ProviderEdit { identity: string | null; instanceId: string; base: ProviderInstanceSettings | null; patch: Partial<ProviderInstanceSettings> }
export interface ProviderEnvironment { name: string; value: string; sensitive: boolean; valueRedacted?: boolean | undefined }
export const providerEnvironmentSchema = z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), value: z.string().max(65536), sensitive: z.boolean(), valueRedacted: z.boolean().optional() }).passthrough()).max(128).refine(rows => new Set(rows.map(row => row.name)).size === rows.length, 'Environment variable names must be unique')
export const providerPatchSchema = z.object({
  driver: z.string().min(1).max(64).optional(), displayName: z.string().trim().min(1).max(256).optional(), enabled: z.boolean().optional(),
  accentColor: z.string().regex(/^(?:|#[0-9a-fA-F]{6})$/).optional(), environment: providerEnvironmentSchema.optional(),
  config: z.object({ binaryPath: z.string().optional(), homePath: z.string().optional(), shadowHomePath: z.string().optional(), launchArgs: z.string().optional(), autoCompactWindow: z.string().regex(/^(?:|[1-9]\d{5}|1000000)$/).optional(), apiEndpoint: z.string().optional(), serverUrl: z.string().optional(), serverPassword: z.string().optional(), customModels: z.array(z.string().trim().min(1).max(512)).max(256).optional() }).strict().optional(),
}).strict()
const record = z.record(z.string(), z.unknown())
export const engineSettingsEditSchema = z.object({ identity: z.string().nullable(), base: record, patch: engineSettingsPatchSchema }).strict()
export const providerEditSchema = z.object({ identity: z.string().nullable(), instanceId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), base: record.nullable(), patch: providerPatchSchema }).strict()

export function isSettingsRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
/** Compare only edited leaves against the displayed snapshot; retain everything else from the latest server read. */
export function mergeEdited(current: unknown, base: unknown, patch: unknown, path: string): unknown {
  if (isSettingsRecord(patch)) {
    const latest = isSettingsRecord(current) ? current : {}
    const original = isSettingsRecord(base) ? base : {}
    return { ...latest, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, mergeEdited(latest[key], original[key], value, `${path}.${key}`)])) }
  }
  if (!same(current, base) && !same(current, patch)) throw new Error(`${path} changed in another client. Reload settings before saving this field.`)
  return patch
}
export function mergeEngineSettings(current: EngineSettings, edit: EngineSettingsEdit): EngineSettingsPatch {
  const patch = engineSettingsPatchSchema.parse(edit.patch)
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => {
    if (!(key in current)) throw new Error(`This engine does not support ${key}.`)
    const merged = mergeEdited(current[key], edit.base[key], value, key)
    if (key === 'backgroundActivity' && isSettingsRecord(merged) && isSettingsRecord(merged.overrides)) {
      const overrides = { ...merged.overrides }
      for (const [name, value] of Object.entries(patch.backgroundActivity?.overrides ?? {})) if (value === null) delete overrides[name]
      merged.overrides = overrides
    }
    return [key, merged]
  })) as EngineSettingsPatch
}
/** Legacy built-in accounts must all survive the first providerInstances collection write. */
export function effectiveProviderInstances(settings: EngineSettings): Record<string, ProviderInstanceSettings> {
  if (Object.keys(settings.providerInstances ?? {}).length) return settings.providerInstances
  if (!isSettingsRecord(settings.providers)) return {}
  return Object.fromEntries(Object.entries(settings.providers).flatMap(([driver, value]) => {
    if (!isSettingsRecord(value)) return []
    const { enabled, ...config } = value
    return [[driver, { driver, enabled: enabled !== false, config }]]
  }))
}
export function mergeProviderEdit(settings: EngineSettings, edit: ProviderEdit): Record<string, ProviderInstanceSettings> {
  const instances = effectiveProviderInstances(settings)
  const latest = instances[edit.instanceId]
  const patch = providerPatchSchema.parse(edit.patch)
  if (edit.base === null && latest) throw new Error(`Provider ${edit.instanceId} already exists. Choose another identifier.`)
  if (edit.base !== null && !latest) throw new Error(`Provider ${edit.instanceId} was removed by another client. Reload Accounts.`)
  if (latest && patch.driver && latest.driver !== patch.driver) throw new Error(`The driver of provider ${edit.instanceId} cannot be changed.`)
  const next = mergeEdited(latest, edit.base, patch, `Provider ${edit.instanceId}`) as ProviderInstanceSettings
  if (patch.accentColor === '') delete next.accentColor
  if (!next.driver) throw new Error(`Choose a driver for provider ${edit.instanceId}.`)
  return { ...instances, [edit.instanceId]: next }
}

export interface EngineSupport {
  sourceControl: Array<{ label: string; status: string; detail?: string; account?: string }>
  problems: string[]
}
export interface EngineActivity {
  clientId: string
  visible: boolean
  focused: boolean
  recentlyInteracted: boolean
  hostPower: {
    source: 'electron-main'
    idle: 'true' | 'false' | 'unknown'
    idleSeconds: number | null
    locked: 'true' | 'false' | 'unknown'
    suspended: boolean
    onBattery: 'true' | 'false' | 'unknown'
    lowPowerMode: 'true' | 'false' | 'unknown'
    thermalState: 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'
    stale: boolean
    updatedAt: string
  }
}

/** Refresh untouched leaves while keeping the original value of each deliberate edit. */
export function refreshSettingsBase(base: unknown, latest: unknown, patch: unknown): unknown {
  if (!isSettingsRecord(patch)) return base
  const original = isSettingsRecord(base) ? base : {}
  const current = isSettingsRecord(latest) ? latest : {}
  return { ...current, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, refreshSettingsBase(original[key], current[key], value)])) }
}
