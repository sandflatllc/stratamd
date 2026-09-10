import { terminateProcessTree } from '../../platform/process-tree'
import { pathDelimiter } from '../../platform/commands'
import { engineEnvironment } from './launch-environment'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { connectStatus, type ConnectJob, type ConnectPhase, type ConnectStatus } from '../../shared/computer'
import type { LocalRuntimeContext } from './local-usage'
import { connectFailure, readConnectOutput } from './connect-output'
import { ConnectRecoveryError } from './connect-setup'

export interface ConnectOperation {
  signal: AbortSignal
  execute(args: string[]): Promise<void>
  phase(phase: ConnectPhase, message: string): void
  confirmDownload(): Promise<void>
  check(): void
}

/** Owns one cancellable setup, including all child commands and recovery. Secrets never enter the view. */
export class T3Connect {
  #child: ChildProcessWithoutNullStreams | null = null
  #done: Promise<void> = Promise.resolve()
  #job: ConnectJob = { state: 'idle', message: '' }
  #abort: AbortController | null = null
  #confirmation: ((accepted: boolean) => void) | null = null
  #account: string | null = null
  #warning = ''
  #status: { pending: boolean; key: string; value: Promise<ConnectStatus> } | null = null
  get busy(): boolean { return this.#abort !== null }
  get account(): string | null { return this.#account }
  view(): ConnectJob { return { ...this.#job } }
  #invocation(context: LocalRuntimeContext, args: string[]) {
    const env: NodeJS.ProcessEnv = { ...engineEnvironment(), PATH: `${dirname(context.executable)}${pathDelimiter}${process.env.PATH ?? ''}`, BROWSER: 'false', NO_COLOR: '1' }
    // Strata runs on the browser's computer even when its parent shell came through SSH.
    delete env.SSH_CONNECTION; delete env.SSH_TTY
    // Recovery replaces the data directory. A process cwd would lock it on Windows.
    return { executable: context.executable, args: [join(context.directory, 'node_modules/t3/dist/bin.mjs'), 'connect', ...args, '--base-dir', context.baseDirectory], options: { cwd: context.directory, env } }
  }
  async status(context: LocalRuntimeContext, refresh = false): Promise<ConnectStatus> {
    const key = context.directory + ':' + context.baseDirectory
    if (this.#status?.key === key && (!refresh || this.#status.pending)) return this.#status.value
    const command = this.#invocation(context, ['status', '--json'])
    const value = promisify(execFile)(command.executable, command.args, { ...command.options, timeout: 10000, maxBuffer: 64000 }).then(result => connectStatus.parse(JSON.parse(result.stdout)))
    this.#status = { pending: true, key, value }
    void value.then(() => { if (this.#status?.value === value) this.#status.pending = false }, () => { if (this.#status?.value === value) this.#status = null })
    return value
  }
  input(text: string): void {
    if (!this.#child || this.#job.phase !== 'code') throw new Error('T3 is not waiting for a code. Start sign-in again.')
    this.#child.stdin.write(text.replace(/[\r\n]/g, '') + '\n')
  }
  useCode(): void {
    if (!this.#child || this.#job.phase !== 'browser') throw new Error('Start browser sign-in before choosing a pasted code.')
    this.#child.stdin.write('h')
    this.#job = { state: 'running', phase: 'authorizing', message: 'Preparing a new authorization link…' }
  }
  download(accepted: boolean): void {
    if (this.#confirmation) { const respond = this.#confirmation; this.#confirmation = null; respond(accepted); return }
    if (!this.#child || this.#job.phase !== 'download') throw new Error('No connection-support download is waiting.')
    this.#child.stdin.write(accepted ? 'y\n' : 'n\n')
    this.#job = { state: 'running', phase: 'installing', message: accepted ? 'Installing connection support…' : 'Cancelling setup…' }
  }
  async cancel(): Promise<void> {
    if (!this.#abort) return
    this.#abort.abort(); this.#confirmation?.(false); this.#confirmation = null
    this.#terminate(); await this.#done
  }
  #terminate(): void {
    const child = this.#child
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    terminateProcessTree(child.pid!, 'SIGTERM')
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { terminateProcessTree(child.pid!, 'SIGKILL') } }, 1500)
    timer.unref(); child.once('exit', () => clearTimeout(timer))
  }
  start(context: LocalRuntimeContext, run: (operation: ConnectOperation) => Promise<string>): void {
    if (this.busy) throw new Error('Finish or cancel T3 setup first.')
    const abort = new AbortController(); this.#abort = abort; this.#warning = ''
    const check = () => { if (abort.signal.aborted) throw new Error('Setup cancelled.') }
    const phase = (phase: ConnectPhase, message: string) => { this.#job = { state: 'running', phase, message } }
    phase('authorizing', 'Preparing T3 setup…')
    this.#done = (async () => {
      try {
        const message = await run({ signal: abort.signal, check, phase,
          execute: args => { check(); return this.#execute(context, args, abort) },
          confirmDownload: async () => {
            check(); phase('download', 'T3 needs connection support to make this computer available remotely.')
            const accepted = await new Promise<boolean>(resolve => { this.#confirmation = resolve })
            check(); if (!accepted) { abort.abort(); check() }
          },
        })
        this.#job = { state: abort.signal.aborted ? 'cancelled' : 'done', message: abort.signal.aborted ? 'Setup cancelled. Your current connection settings are shown below.' : message + this.#warning }
      } catch (error) {
        this.#job = { state: abort.signal.aborted && !(error instanceof ConnectRecoveryError) ? 'cancelled' : 'failed', message: abort.signal.aborted && !(error instanceof ConnectRecoveryError) ? 'Setup cancelled. Your current connection settings are shown below.' : error instanceof Error ? error.message : 'T3 setup could not finish.' }
      } finally { this.#status = null; this.#confirmation = null; this.#abort = null }
    })()
  }
  async #execute(context: LocalRuntimeContext, args: string[], abort: AbortController): Promise<void> {
    const command = this.#invocation(context, args)
    let output = '', cancelled = false, timedOut = false
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.executable, command.args, { ...command.options, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.#child = child
      child.stdin.on('error', () => undefined)
      const collect = (bytes: Buffer) => {
        output = (output + bytes.toString()).slice(-16000)
        const read = readConnectOutput(output); cancelled ||= read.cancelled
        if (read.account) this.#account = read.account
        if (!abort.signal.aborted && read.phase) this.#job = { state: 'running', phase: read.phase, message: read.message!, ...(read.url ? { url: read.url } : {}) }
      }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      const timer = setTimeout(() => { timedOut = true; this.#terminate() }, 10 * 60 * 1000)
      timer.unref()
      child.once('error', () => { clearTimeout(timer); this.#child = null; reject(new Error('The bundled T3 command could not start. Restart Strata and retry.')) })
      child.once('close', code => {
        clearTimeout(timer); this.#child = null
        if (cancelled) abort.abort()
        if (abort.signal.aborted) reject(new Error('Setup cancelled.'))
        else if (timedOut) reject(new Error('T3 setup timed out. Check your connection and retry.'))
        else if (code !== 0) reject(new Error(connectFailure(output)))
        else {
          if (/Could not revoke the relay-side environment record/i.test(output)) this.#warning = ' T3 could not remove the remote account record. Remove this computer in your T3 account when the network is available.'
          if (args[0] === 'logout') this.#account = null; this.#status = null; resolve() }
      })
    })
  }
}
