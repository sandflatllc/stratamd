import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { EngineSettings, AccountView } from '../../shared/contracts'
import type { ProviderSetupView } from '../../shared/provider-setup'
import { findProviderExecutable, type LocalRuntimeContext } from './local-usage'

/** One explicitly requested official installer/login at a time. Output is ephemeral and never logged. */
export class ProviderSetupJobs {
  #view: ProviderSetupView = { instanceId: '', state: 'idle', message: '', output: '' }
  #child: ChildProcessWithoutNullStreams | null = null
  #done: Promise<void> = Promise.resolve()
  #generation = 0
  #reserved = false
  get busy(): boolean { return this.#reserved || this.#view.state === 'running' }
  view(instanceId: string): ProviderSetupView { return this.#view.instanceId === instanceId ? { ...this.#view } : { instanceId, state: 'idle', message: '', output: '' } }
  input(text: string): void { if (!this.#child || this.#view.state !== 'running') throw new Error('No sign-in is waiting for input.'); this.#child.stdin.write(text.replace(/[\r\n]/g, '') + '\n') }
  async cancel(): Promise<void> {
    if (!this.busy) return
    this.#generation++
    this.#view = { ...this.#view, state: 'cancelled', message: 'Setup cancelled. Documents remain available.' }
    this.#terminate()
    await this.#done
  }
  #terminate(): void {
    const child = this.#child
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') } } }, 1500)
    timer.unref(); child.once('exit', () => clearTimeout(timer))
  }
  async start(action: 'install' | 'login', context: LocalRuntimeContext, account: AccountView, settings: EngineSettings, installRoot: string, saveBinary: (binary: string) => Promise<void>, refresh: () => Promise<void>): Promise<ProviderSetupView> {
    if (this.busy) throw new Error('Finish or cancel the current provider setup first.')
    this.#reserved = true
    const generation = ++this.#generation
    try {
      if (!['codex', 'claudeAgent'].includes(account.driver)) throw new Error(`Install and sign in to ${account.name} using its own tool, then refresh Accounts.`)
      const instance = settings.providerInstances[account.instanceId]
      if (!instance) throw new Error(`Account ${account.instanceId} is no longer configured.`)
      if (instance.environment?.length) throw new Error('This account has environment overrides. Sign in with its configured tool, then refresh Accounts.')
      const config = instance.config ?? {}, name = account.driver === 'codex' ? 'codex' : 'claude'
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(context.executable)}:${process.env.PATH ?? ''}` }
      const home = typeof config.shadowHomePath === 'string' && config.shadowHomePath.trim() ? config.shadowHomePath : typeof config.homePath === 'string' ? config.homePath : ''
      if (home) env[account.driver === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = home
      const configured = typeof config.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : name
      let binary = await findProviderExecutable(configured, context.baseDirectory, env.PATH)
      let args: string[], executable: string
      const prefix = join(installRoot, account.driver)
      if (action === 'install' && binary) {
        try { const version = await promisify(execFile)(binary, ['--version'], { cwd: context.baseDirectory, env, timeout: 5000, maxBuffer: 16000 }); if (!/codex|claude/i.test(version.stdout + version.stderr)) binary = null } catch { binary = null }
      }
      if (generation !== this.#generation) throw new Error('Setup cancelled.')
      if (action === 'install' && binary) {
        await refresh()
        this.#view = { instanceId: account.instanceId, state: 'done', message: 'An installed provider tool is already available. Refreshed its status.', output: '' }
        return this.view(account.instanceId)
      }
      if (action === 'install') {
        const npmCandidates = [join(context.directory, 'node/lib/node_modules/npm/bin/npm-cli.js'), join(context.directory, 'node_modules/npm/bin/npm-cli.js')]
        let npm: string | undefined
        for (const candidate of npmCandidates) { try { await access(candidate); npm = candidate; break } catch { /* Try the bundled layout. */ } }
        if (!npm) throw new Error(`The bundled npm installer is missing from ${context.directory}. Replace this Strata folder with a complete release.`)
        await mkdir(prefix, { recursive: true, mode: 0o700 })
        executable = context.executable
        args = [npm, 'install', '--global', '--prefix', prefix, '--cache', join(installRoot, 'npm-cache'), '--no-audit', '--no-fund', account.driver === 'codex' ? '@openai/codex@0.153.4' : '@anthropic-ai/claude-code@2.1.263']
        binary = join(prefix, 'bin', name)
      } else {
        if (!binary) throw new Error(`Install ${account.name} before signing in.`)
        executable = binary; args = account.driver === 'codex' ? ['login'] : ['auth', 'login']
      }
      if (generation !== this.#generation) throw new Error('Setup cancelled.')
      this.#view = { instanceId: account.instanceId, state: 'running', message: action === 'install' ? `Installing ${account.name} in Strata's folder…` : `Complete ${account.name} sign-in in your browser.`, output: '' }
      const child = spawn(executable, args, { cwd: context.baseDirectory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.#child = child
      const installedBinary = binary
      this.#done = new Promise<void>(resolve => {
        const timeout = setTimeout(() => { this.#view = { ...this.#view, state: 'failed', message: 'Setup timed out. Try again when the network and sign-in are available.' }; this.#terminate() }, 10 * 60 * 1000)
        timeout.unref()
        const output = (bytes: Buffer) => { const plain = bytes.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''); this.#view = { ...this.#view, output: (this.#view.output + plain).slice(-16000) } }
        child.stdout.on('data', output); child.stderr.on('data', output); child.stdin.on('error', () => undefined)
        let finished = false
        const finish = async (code: number | null, error?: Error) => {
          if (finished) return; finished = true; clearTimeout(timeout); this.#child = null
          try {
            if (this.#view.state === 'running') {
              if (error || code !== 0) throw error ?? new Error(`The provider tool exited with ${code ?? 'a signal'}. Review its message and try again.`)
              if (action === 'install') await saveBinary(installedBinary!)
              this.#view = { ...this.#view, state: 'done', message: action === 'install' ? 'Installed. Sign in to use this account.' : 'Sign-in finished. Account status refreshed.', output: '' }
              await refresh()
            }
          } catch (error) { this.#view = { ...this.#view, state: 'failed', message: String(error) } }
          resolve()
        }
        child.once('error', error => void finish(null, error)); child.once('exit', code => void finish(code))
      })
      return this.view(account.instanceId)
    } finally { this.#reserved = false }
  }
}
