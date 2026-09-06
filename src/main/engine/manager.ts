import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, readFile, rename, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { atomicWriteFile, ensurePrivateDirectory } from '../storage'
import { processStamp, takeEngineLock, verifiedProcess, type OwnedProcess } from './managed-process'
import { stageRuntime, type StagedRuntime } from './managed-runtime'
import type { ManagedEngineView } from '../../shared/contracts'

interface RuntimeRecord extends OwnedProcess { version: string; nodeVersion: string; runtimeDirectory: string; generation: string; address: string; environmentId: string }
export interface EngineManagerOptions {
  directory: string
  bundle: string
  connect(address: string, token: string, environmentId: string): Promise<void>
  authenticate(address: string): Promise<boolean>
  reconnect(): Promise<void>
  changed(view: ManagedEngineView): void
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Owns processes and health. Conversation delivery remains exclusively in T3EngineClient. */
export class LocalEngineManager {
  #options: EngineManagerOptions
  #child: ChildProcess | null = null
  #record: RuntimeRecord | null = null
  #release: (() => Promise<void>) | null = null
  #stopping = false
  #starting: Promise<void> | null = null
  #healthTimer: ReturnType<typeof setInterval> | null = null
  #restartTimer: ReturnType<typeof setTimeout> | null = null
  #attempt = 0
  #view: ManagedEngineView
  #logQueue: Promise<void> = Promise.resolve()
  constructor(options: EngineManagerOptions) {
    this.#options = options
    this.#view = { state: 'stopped', version: null, nodeVersion: null, directory: options.directory, problem: null }
  }
  view(): ManagedEngineView { return this.#view }
  #publish(patch: Partial<ManagedEngineView>): void {
    this.#view = { ...this.#view, ...patch }; this.#options.changed(this.#view)
  }
  start(): Promise<void> {
    if (this.#starting) return this.#starting
    this.#stopping = false
    this.#starting = this.#start().catch(error => {
      if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGTERM')
      this.#publish({ state: 'failed', problem: error instanceof Error ? error.message : String(error) })
      this.#scheduleRecovery()
    }).finally(() => { this.#starting = null })
    return this.#starting
  }
  async #start(): Promise<void> {
    this.#publish({ state: 'starting', problem: null })
    this.#release ??= await takeEngineLock(this.#options.directory)
    const baseDirectory = join(this.#options.directory, 't3')
    await ensurePrivateDirectory(baseDirectory)
    try { this.#record = JSON.parse(await readFile(join(this.#options.directory, 'runtime.json'), 'utf8')) } catch(error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read engine runtime record at ${this.#options.directory}`)
    }
    if (this.#record && await verifiedProcess(this.#record)) {
      if (this.#record.baseDirectory !== baseDirectory || !await this.#options.authenticate(this.#record.address)) throw new Error(`A surviving engine at ${baseDirectory} could not be authenticated. It was left running.`)
      await this.#options.reconnect()
      this.#publish({ state: 'running', version: this.#record.version, nodeVersion: this.#record.nodeVersion })
      this.#monitor()
      return
    }
    const runtime = await stageRuntime(this.#options.bundle, this.#options.directory)
    await this.#launch(runtime, baseDirectory)
  }
  async #launch(runtime: StagedRuntime, baseDirectory: string): Promise<void> {
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const token = randomBytes(32).toString('base64url')
    const executable = join(runtime.directory, runtime.executable)
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('T3CODE_')))
    const child = spawn(executable, [join(runtime.directory, runtime.entry), '--base-dir', baseDirectory, '--host', '127.0.0.1', '--port', String(port), '--no-browser', '--bootstrap-fd', '3'], { cwd: baseDirectory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    this.#child = child
    let spawnError: Error | null = null
    child.once('error', error => { spawnError = error })
    const pipe = child.stdio[3] as import('node:stream').Writable
    pipe.on('error', () => undefined)
    pipe.end(JSON.stringify({ mode: 'desktop', noBrowser: true, port, t3Home: baseDirectory, host: '127.0.0.1', desktopBootstrapToken: token, tailscaleServeEnabled: false, tailscaleServePort: 443 }))
    const log = (bytes: Buffer) => {
      const safe = bytes.toString().replaceAll(token, '[bootstrap omitted]').replace(/([#?]token=)[^\s]+/g, '$1[omitted]')
      this.#logQueue = this.#logQueue.then(() => this.#appendLog(safe)).catch(() => undefined)
    }
    child.stdout?.on('data', log); child.stderr?.on('data', log)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !this.#stopping) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Engine process exited (${child.exitCode ?? child.signalCode}); see ${join(this.#options.directory, 'log', 'engine.log')}`)
      try {
        const reported = JSON.parse(await readFile(join(baseDirectory, 'userdata', 'server-runtime.json'), 'utf8'))
        const address = new URL(reported.origin)
        if (reported.pid !== child.pid || address.hostname !== '127.0.0.1' || address.port !== String(port)) { await pause(50); continue }
        const environmentId = (await readFile(join(baseDirectory, 'userdata', 'environment-id'), 'utf8')).trim()
        const record: RuntimeRecord = { pid: child.pid!, ...await processStamp(child.pid!), executable, baseDirectory, version: runtime.version, nodeVersion: runtime.nodeVersion, runtimeDirectory: runtime.directory, generation: randomUUID(), address: address.origin, environmentId }
        if (!await verifiedProcess(record)) throw new Error(`Could not verify newly launched engine process ${child.pid}`)
        this.#record = record
        await this.#options.connect(address.origin, token, environmentId)
        if (!await this.#options.authenticate(address.origin)) throw new Error(`Engine at ${address.origin} did not pass authenticated readiness`)
        await atomicWriteFile(join(this.#options.directory, 'runtime.json'), JSON.stringify(record))
        child.once('exit', () => this.#unexpectedExit())
        this.#publish({ state: 'running', version: runtime.version, nodeVersion: runtime.nodeVersion, problem: null })
        this.#monitor()
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await pause(50)
    }
    if (child.pid && child.exitCode === null) child.kill('SIGTERM')
    throw new Error(`Engine startup timed out at ${baseDirectory}`)
  }
  async #appendLog(text: string): Promise<void> {
    const directory = join(this.#options.directory, 'log'), path = join(directory, 'engine.log')
    await ensurePrivateDirectory(directory)
    try { if ((await stat(path)).size > 2_000_000) await rename(path, `${path}.1`) } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await appendFile(path, text, { mode: 0o600 })
  }
  #monitor(): void {
    if (this.#healthTimer) clearInterval(this.#healthTimer)
    this.#healthTimer = setInterval(() => {
      if (!this.#record || this.#stopping) return
      void verifiedProcess(this.#record).then(alive => { if (!alive && !this.#stopping) this.#unexpectedExit() })
    }, 5000)
    this.#healthTimer.unref()
  }
  #unexpectedExit(): void {
    if (this.#stopping || this.#restartTimer) return
    if (this.#healthTimer) clearInterval(this.#healthTimer)
    this.#healthTimer = null
    this.#publish({ state: 'failed', problem: 'The engine stopped. Documents remain available.' })
    this.#scheduleRecovery()
  }
  #scheduleRecovery(): void {
    if (this.#stopping || this.#restartTimer || this.#attempt >= 3) return
    this.#restartTimer = setTimeout(() => { this.#restartTimer = null; void this.start() }, [1000, 3000, 10_000][this.#attempt++]!)
  }
  async restart(): Promise<void> { await this.stop(); this.#attempt = 0; await this.start() }
  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#healthTimer) clearInterval(this.#healthTimer)
    this.#healthTimer = null
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = null
    await this.#starting
    if (this.#record && await verifiedProcess(this.#record)) {
      process.kill(this.#record.pid, 'SIGTERM')
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && await verifiedProcess(this.#record)) await pause(50)
      if (await verifiedProcess(this.#record)) process.kill(-this.#record.pid, 'SIGKILL')
    } else if (this.#child?.pid && this.#child.exitCode === null && this.#child.signalCode === null) {
      // A child handle still owned by this parent can be stopped before a runtime record exists.
      this.#child.kill('SIGTERM')
    }
    await this.#logQueue
    await this.#release?.(); this.#release = null; this.#child = null
    this.#publish({ state: 'stopped' })
  }
}
