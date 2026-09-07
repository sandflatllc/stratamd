import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ASK_JSON_SCHEMA, ASK_MAX_SOURCE, askPrompt, parseAskOutput } from '../../core/asks'
import { findProviderExecutable, resolveProviderHome, type LocalRuntimeContext } from './local-usage'
import type { EngineSettings } from '../../shared/contracts'
import { generatedModelSchema } from '../../shared/engine-settings'

const configText = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

export interface AskInvocation { binary: string; env: NodeJS.ProcessEnv; model: string }
export function askConfigurationProblem(context: LocalRuntimeContext | null, settings: EngineSettings | null): string | null {
  if (!context) return 'Ask scans require the managed engine on this computer.'
  const parsed = generatedModelSchema.safeParse(settings?.textGenerationModelSelection)
  if (!parsed.success) return 'Choose a text generation model in Settings to find asks.'
  const instance = settings?.providerInstances[parsed.data.instanceId]
  if (!instance || !instance.enabled || instance.driver !== 'codex') return 'Ask scans require an enabled Codex text generation account.'
  if (instance.environment?.length || configText(instance.config?.launchArgs) || instance.config?.apiEndpoint) return 'Ask scans do not support this account’s custom launch or environment settings.'
  return null
}
export async function resolveAskInvocation(context: LocalRuntimeContext, settings: EngineSettings): Promise<AskInvocation> {
  const problem = askConfigurationProblem(context, settings)
  if (problem) throw new Error(problem)
  const selected = generatedModelSchema.parse(settings.textGenerationModelSelection)
  const config = settings.providerInstances[selected.instanceId]!.config ?? {}
  const path = `${dirname(context.executable)}:${process.env.PATH ?? ''}`
  const binary = await findProviderExecutable(configText(config.binaryPath) || 'codex', context.baseDirectory, path)
  if (!binary) throw new Error('The selected Codex executable is unavailable. Check Accounts.')
  const home = configText(config.shadowHomePath) || configText(config.homePath)
  const env = { ...process.env, PATH: path, ...(home ? { CODEX_HOME: resolveProviderHome(home, context.baseDirectory) } : {}) }
  return { binary, env, model: selected.model }
}
export function askArguments(model: string, directory: string): string[] {
  return ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only', '--model', model,
    '-c', 'model_reasoning_effort="low"', '-c', 'service_tier="fast"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
    ...['shell_tool', 'code_mode', 'code_mode_host', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'image_generation', 'sleep_tool'].flatMap(name => ['--disable', name]),
    '--json', '--output-schema', join(directory, 'schema.json'), '--output-last-message', join(directory, 'answer.json'), '-']
}
export async function scanAsks(invocation: AskInvocation, source: string, registered: readonly string[], signal: AbortSignal, timeoutMs = 60_000): Promise<Array<{ quote: string }>> {
  if (signal.aborted) throw new Error('Scan cancelled')
  if (source.length > ASK_MAX_SOURCE || registered.reduce((size, text) => size + text.length, 0) > ASK_MAX_SOURCE) throw new Error('This reply is too long to scan.')
  const directory = await mkdtemp(join(tmpdir(), 'strata-asks-'))
  try {
    await writeFile(join(directory, 'schema.json'), JSON.stringify(ASK_JSON_SCHEMA), { mode: 0o600 })
    if (signal.aborted) throw new Error('Scan cancelled')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.binary, askArguments(invocation.model, directory), { cwd: directory, env: invocation.env, detached: true, stdio: ['pipe','pipe','pipe'] })
      let failure: Error | null = null, output = '', bytes = 0, killTimer: ReturnType<typeof setTimeout> | undefined
      const stop = (reason: string) => {
        failure ??= new Error(reason)
        if (!child.pid) return
        // Descendants may still own our pipes after the parent has exited.
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
        killTimer ??= setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') } }, 1000)
        killTimer.unref()
      }
      const cancel = () => stop('Scan cancelled')
      const timer = setTimeout(() => stop('Ask scan timed out. Click to retry.'), timeoutMs)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      child.stdin.on('error', () => undefined)
      const checkEvent = (line: string) => {
        try {
          const event = JSON.parse(line)
          const type = event.item?.type
          if (type && !['agent_message', 'reasoning', 'plan', 'error'].includes(type)) stop('Ask scan attempted to use a tool.')
        } catch { /* Non-event diagnostics are not a result. */ }
      }
      child.stdout.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 2_000_000) { stop('Ask scan output exceeded its limit.'); return }
        output += chunk.toString()
        const lines = output.split('\n'); output = lines.pop() ?? ''
        lines.forEach(checkEvent)
      })
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 2_000_000) stop('Ask scan output exceeded its limit.') })
      let finished = false
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        if (output.trim()) checkEvent(output)
        clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', cancel)
        // Reap any descendant still in our private process group, including one
        // that closed its pipes before the parent exited.
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Group already exited. */ } }
        if (failure || error) reject(failure ?? error); else resolve()
      }
      child.once('error', error => finish(error))
      child.once('close', code => finish(code === 0 ? undefined : new Error(`Ask scan exited with ${code ?? 'a signal'}.`)))
      child.stdin.end(askPrompt(source, registered))
    })
    if (signal.aborted) throw new Error('Scan cancelled')
    const path = join(directory, 'answer.json')
    if ((await stat(path)).size > 1_000_000) throw new Error('Ask result exceeded its limit.')
    return parseAskOutput(await readFile(path, 'utf8'))
  } finally { await rm(directory, { recursive: true, force: true }) }
}

interface ScanJob { key: string; manual: boolean; run(signal: AbortSignal): Promise<void>; controller: AbortController }
/** One process for the application, with replaceable per-thread work and nonblocking cancellation. */
export class AskScanQueue {
  #jobs: ScanJob[] = []
  #active: ScanJob | null = null
  #paused = false
  #maintenance = false
  #done: Promise<void> = Promise.resolve()
  enqueue(key: string, manual: boolean, run: ScanJob['run']) { this.cancel(key); this.#jobs.push({ key, manual, run, controller: new AbortController() }); this.#pump() }
  cancel(key: string) { this.#jobs = this.#jobs.filter(job => job.key !== key); if (this.#active?.key === key) this.#active.controller.abort() }
  policy(paused: boolean, maintenance = false) { this.#paused = paused; this.#maintenance = maintenance; this.#pump() }
  async stop() { this.#jobs = []; this.#active?.controller.abort(); await this.#done }
  #pump() {
    if (this.#active || this.#maintenance) return
    const index = this.#jobs.findIndex(job => !this.#paused || job.manual)
    if (index < 0) return
    const job = this.#jobs.splice(index, 1)[0]!
    this.#active = job
    this.#done = job.run(job.controller.signal).catch(() => undefined).finally(() => { this.#active = null; this.#pump() })
  }
}
