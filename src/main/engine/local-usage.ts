import { terminateProcessTree } from '../../platform/process-tree'
import { executableCandidates, pathDelimiter, nodeCommand } from '../../platform/commands'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { EngineSettings } from '../../shared/contracts'
import type { AccountMeasurement, EngineProviderInstance } from './accounts'
import { isSettingsRecord } from '../../shared/engine-settings'

export interface LocalRuntimeContext { executable: string; directory: string; baseDirectory: string }
export function resolveProviderHome(path: string, cwd: string): string {
  const value = path.trim()
  return value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : resolve(cwd, value)
}
export async function findProviderExecutable(binary: string, cwd: string, searchPath = process.env.PATH ?? ''): Promise<string | null> {
  const candidates = executableCandidates(binary, cwd, searchPath)
  for (const path of candidates) { try { await access(path, constants.X_OK); return path } catch { /* Try the next configured search directory. */ } }
  return null
}
export async function measureLocalUsage(context: LocalRuntimeContext | null, helper: string, provider: EngineProviderInstance, settings: EngineSettings, signal: AbortSignal): Promise<AccountMeasurement | null> {
  if (!context || signal.aborted || !provider.installed || !provider.enabled || provider.auth.status !== 'authenticated' || !['codex', 'claudeAgent'].includes(provider.driver)) return null
  const instance = settings.providerInstances[provider.instanceId]
  // A hidden environment override may select another credential. Do not guess or read its secret store.
  if (instance?.environment?.length) return null
  const config = instance?.config ?? {}
  const home = typeof config.shadowHomePath === 'string' && config.shadowHomePath.trim() ? config.shadowHomePath : typeof config.homePath === 'string' ? config.homePath : provider.homePath
  const searchPath = `${dirname(context.executable)}${pathDelimiter}${process.env.PATH ?? ''}`
  const binary = await findProviderExecutable(typeof config.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : provider.driver === 'codex' ? 'codex' : 'claude', context.baseDirectory, searchPath)
  if (!binary || signal.aborted) return null
  const env = { ...process.env, PATH: searchPath, ...(home?.trim() ? { [provider.driver === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: resolveProviderHome(home, context.baseDirectory) } : {}) }
  const command = await nodeCommand(binary, ['app-server'], context.executable).catch(() => null)
  if (!command || signal.aborted) return null
  return new Promise(resolveReading => {
    const child = spawn(context.executable, [helper], { cwd: context.baseDirectory, env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', done = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    child.stderr.resume()
    const stop = () => { if (child.pid && child.exitCode === null && child.signalCode === null) { terminateProcessTree(child.pid!, 'SIGTERM'); killTimer ??= setTimeout(() => { if (child.pid && child.exitCode === null && child.signalCode === null) { terminateProcessTree(child.pid!, 'SIGKILL') } }, 1500) } }
    const finish = (result: AccountMeasurement | null) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', stop); resolveReading(result) }
    const timer = setTimeout(stop, 35000)
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 65536) stop() })
    child.once('error', () => finish(null))
    child.once('exit', () => {
      if (signal.aborted) { finish(null); return }
      try {
        const value: unknown = JSON.parse(output)
        if (!isSettingsRecord(value) || typeof value.measuredAt !== 'string') { finish(null); return }
        const validWindow = (window: unknown) => window === null || isSettingsRecord(window) && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && typeof window.measuredAt === 'string' && (window.resetsAt === null || typeof window.resetsAt === 'string')
        const validModels = value.modelWindows === undefined || Array.isArray(value.modelWindows) && value.modelWindows.every(window => isSettingsRecord(window) && typeof window.model === 'string' && window.model.trim() && validWindow(window))
        finish(validWindow(value.session) && validWindow(value.weekly) && validModels ? value as unknown as AccountMeasurement : null)
      } catch { finish(null) }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify({ driver: provider.driver, binary, command, email: provider.auth.email, cwd: context.baseDirectory, sdk: join(context.directory, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs') }))
    if (signal.aborted) stop()
  })
}
