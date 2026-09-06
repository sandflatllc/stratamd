import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { connectStatus, type ConnectJob, type ConnectStatus } from '../../shared/computer'
import type { LocalRuntimeContext } from './local-usage'

/** Only official Connect subcommands. Auth output stays in memory and status comes from JSON. */
export class T3Connect {
  #child: ChildProcessWithoutNullStreams | null = null
  #done: Promise<void> = Promise.resolve()
  #job: ConnectJob = { state: 'idle', message: '', output: '' }
  #busy = false
  #status: { time: number; value: Promise<ConnectStatus> } | null = null
  get busy(): boolean { return this.#busy }
  view(): ConnectJob { return { ...this.#job } }
  #invocation(context: LocalRuntimeContext, args: string[]) {
    return { executable: context.executable, args: [join(context.directory, 'node_modules/t3/dist/bin.mjs'), 'connect', ...args, '--base-dir', context.baseDirectory], options: { cwd: context.baseDirectory, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('T3CODE_'))), PATH: `${dirname(context.executable)}:${process.env.PATH ?? ''}`, BROWSER: 'false', NO_COLOR: '1' } } }
  }
  async status(context: LocalRuntimeContext): Promise<ConnectStatus> {
    if (this.#status && Date.now() - this.#status.time < 5000) return this.#status.value
    const value = this.#readStatus(context)
    this.#status = { time: Date.now(), value }
    return value
  }
  async command(context: LocalRuntimeContext, args: string[]): Promise<void> {
    const command = this.#invocation(context, args)
    await promisify(execFile)(command.executable, command.args, { ...command.options, timeout: 15000, maxBuffer: 64000 })
    this.#status = null
  }
  async #readStatus(context: LocalRuntimeContext): Promise<ConnectStatus> {
    const command = this.#invocation(context, ['status', '--json'])
    const result = await promisify(execFile)(command.executable, command.args, { ...command.options, timeout: 10000, maxBuffer: 64000 })
    return connectStatus.parse(JSON.parse(result.stdout))
  }
  input(text: string): void {
    if (!this.#child || !this.busy) throw new Error('T3 sign-in is no longer waiting. Start it again.')
    this.#child.stdin.write(text.replace(/[\r\n]/g, '') + '\n')
  }
  async cancel(): Promise<void> {
    if (!this.busy) return
    this.#job = { state: 'cancelled', message: 'T3 Connect cancelled. Local work remains available.', output: '' }
    this.#terminate(); await this.#done
  }
  #terminate(): void {
    const child = this.#child
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') } } }, 1500)
    timer.unref(); child.once('exit', () => clearTimeout(timer))
  }
  start(context: LocalRuntimeContext, args: string[], before: () => Promise<void>, after: () => Promise<void>): void {
    if (this.busy) throw new Error('Finish or cancel T3 Connect first.')
    this.#busy = true
    this.#job = { state: 'running', message: args[0] === 'login' ? 'Complete T3 sign-in in your browser, then enter its code.' : 'Applying T3 Connect. Local documents remain available.', output: '' }
    this.#done = (async () => {
      try {
        await before()
        if (this.#job.state !== 'running') return
        const command = this.#invocation(context, args)
        await new Promise<void>((resolve, reject) => {
          const child = spawn(command.executable, command.args, { ...command.options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
          this.#child = child
          child.stdin.on('error', () => undefined)
          const collect = (bytes: Buffer) => {
            if (this.#job.state !== 'running') return
            const output = (this.#job.output + bytes.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).slice(-16000)
            const candidate = output.match(/https:\/\/app\.t3\.codes\/connect[^\s]*/)?.[0]
            this.#job = { ...this.#job, output, ...(candidate ? { url: candidate } : {}) }
          }
          child.stdout.on('data', collect); child.stderr.on('data', collect)
          const timer = setTimeout(() => { this.#job = { state: 'failed', message: 'T3 Connect timed out. Check the network and sign in to T3 again.', output: '' }; this.#terminate() }, 10 * 60 * 1000)
          timer.unref()
          child.once('error', error => { clearTimeout(timer); reject(error) })
          child.once('exit', code => { clearTimeout(timer); this.#child = null; code === 0 || this.#job.state !== 'running' ? resolve() : reject(new Error(`T3 Connect exited with ${code ?? 'a signal'}. Check the network or sign in to T3 again.`)) })
        })
        if (this.#job.state === 'running') this.#job = { state: 'done', message: 'T3 Connect command finished. Status refreshed below.', output: args[0] === 'login' ? '' : this.#job.output }
      } catch (error) {
        if (this.#job.state === 'running') this.#job = { state: 'failed', message: String(error), output: this.#job.output }
      } finally {
        try { await after() } catch (error) { this.#job = { state: 'failed', message: String(error), output: '' } }
        this.#status = null
        this.#busy = false
      }
    })()
  }
}
