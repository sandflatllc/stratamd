import { engineEnvironment } from './launch-environment'
import { createEngineBackup, listEngineBackups, readEngineBackup, restoreEngineBackup, retainEngineRecovery, type EngineBackup } from './backups'
import type { RecoveryView } from '../../shared/engine-recovery'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, readFile, rename, stat, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { atomicWriteFile, ensurePrivateDirectory } from '../storage'
import { processStamp, takeEngineLock, verifiedProcess, type OwnedProcess } from './managed-process'
import { stageRuntime, verifyRuntime, type StagedRuntime } from './managed-runtime'
import type { ManagedEngineView } from '../../shared/contracts'

interface RuntimeRecord extends OwnedProcess { phase?: 'bootstrap' | 'ready'; version: string; nodeVersion: string; runtimeDirectory: string; generation: string; address: string; environmentId: string }
export interface EngineManagerOptions {
  directory: string
  bundle: string
  connect(address: string, token: string, environmentId: string): Promise<void>
  authenticate(address: string): Promise<boolean>
  reconnect(): Promise<void>
  changed(view: ManagedEngineView): void
  reserveChange?(): Promise<() => Promise<void>>
  captureState?(directory: string): Promise<void>
  restoreState?(directory: string): Promise<void>
  healthyIntervalMs?: number
  network?(): { lan?: boolean; tailscale?: boolean; tailscalePort?: number }
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
  #healthySince: number | null = null
  #view: ManagedEngineView
  #transition: Promise<void> | null = null
  #changing = false
  #pendingRuntime: StagedRuntime | null = null
  #logQueue: Promise<void> = Promise.resolve()
  constructor(options: EngineManagerOptions) {
    this.#options = options
    this.#view = { state: 'stopped', version: null, nodeVersion: null, directory: options.directory, problem: null }
  }
  view(): ManagedEngineView { return this.#view }
  runtimeContext(): import('./local-usage').LocalRuntimeContext | null {
    return this.#record ? { executable: this.#record.executable, directory: this.#record.runtimeDirectory, baseDirectory: this.#record.baseDirectory } : null
  }
  #publish(patch: Partial<ManagedEngineView>): void {
    this.#view = { ...this.#view, ...patch }; this.#options.changed(this.#view)
  }
  start(): Promise<void> {
    if (this.#starting) return this.#starting
    this.#stopping = false
    this.#starting = this.#start().catch(error => {
      if (this.#child && (!this.#record || this.#record.phase === 'bootstrap') && this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGTERM')
      this.#publish({ state: this.#attempt >= 3 ? 'failed' : 'recovering', problem: error instanceof Error ? error.message : String(error), failure: { at: Date.now(), exitCode: this.#child?.exitCode ?? null, signal: this.#child?.signalCode ?? null, attempt: this.#attempt } })
      this.#scheduleRecovery()
    }).finally(() => { this.#starting = null })
    return this.#starting
  }
  async #start(): Promise<void> {
    this.#pendingRuntime = null
    this.#publish({ state: 'starting', problem: null })
    this.#release ??= await takeEngineLock(this.#options.directory)
    const baseDirectory = join(this.#options.directory, 't3')
    await ensurePrivateDirectory(baseDirectory)
    try { this.#record = JSON.parse(await readFile(join(this.#options.directory, 'runtime.json'), 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read engine runtime record at ${this.#options.directory}`)
    }
    let bundled: StagedRuntime
    let stagingProblem: string | null = null
    try { bundled = await stageRuntime(this.#options.bundle, this.#options.directory) } catch (error) {
      if (!this.#record) throw error
      bundled = await this.#runtime(this.#record.version)
      stagingProblem = `The new bundled engine could not be verified. The previous runtime was kept. ${String(error)}`
    }
    let runtime = bundled
    try {
      const selected = JSON.parse(await readFile(join(this.#options.directory, 'selected-runtime.json'), 'utf8'))
      if (selected.bundleVersion === bundled.version) runtime = await this.#runtime(selected.version)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let journal: { backupId: string; targetVersion: string } | null = null
    try { journal = JSON.parse(await readFile(join(this.#options.directory, 'transition.json'), 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let adopted = false
    if (this.#record && await verifiedProcess(this.#record)) {
      if (this.#record.baseDirectory !== baseDirectory) throw new Error(`A surviving engine does not own ${baseDirectory}. It was left running.`)
      if (await this.#options.authenticate(this.#record.address)) {
        await this.#options.reconnect()
        this.#record.phase = 'ready'
        await atomicWriteFile(join(this.#options.directory, 'runtime.json'), JSON.stringify(this.#record))
        this.#publish({ state: 'running', version: this.#record.version, nodeVersion: this.#record.nodeVersion })
        this.#healthySince = Date.now()
        adopted = true
        if (journal && this.#record.version === journal.targetVersion) { await rm(join(this.#options.directory, 'transition.json')); journal = null }
      } else if (this.#record.phase === 'bootstrap') {
        // Only an explicitly incomplete launch may be replaced without credentials.
        // #halt verifies the complete incarnation again while this manager holds the lock.
        await this.#halt(false)
        this.#stopping = false
      } else throw new Error(`A surviving engine at ${baseDirectory} could not be authenticated. It was left running.`)
    }
    if (adopted) {
      // Authenticated survivors keep their process and data.
    } else if (journal) {
      const backup = await readEngineBackup(this.#options.directory, journal.backupId)
      const failedRuntime = this.#record ? await this.#runtime(this.#record.version) : backup.runtime
      await createEngineBackup(this.#options.directory, failedRuntime, 'failed-update', this.#options.captureState ?? (async () => undefined))
      await restoreEngineBackup(this.#options.directory, backup, this.#options.restoreState ?? (async () => undefined))
      await this.#pin(backup.version, bundled.version)
      runtime = backup.runtime
      await this.#launch(runtime, baseDirectory)
      await rm(join(this.#options.directory, 'transition.json'))
    } else {
      const initial = this.#record && this.#record.version !== runtime.version ? await this.#runtime(this.#record.version) : runtime
      await this.#launch(initial, baseDirectory)
    }
    this.#monitor()
    if (this.#record?.version !== runtime.version) await this.#runTransition(() => this.#upgrade(runtime))
    if (stagingProblem) this.#publish({ problem: stagingProblem })
  }
  async #runtime(version: string): Promise<StagedRuntime> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version)) throw new Error('Invalid engine runtime version')
    const directory = join(this.#options.directory, 'runtime', version)
    const manifest = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
    const runtime = { ...manifest, directory } as StagedRuntime
    await verifyRuntime(runtime); return runtime
  }
  async #pin(version: string, bundleVersion: string): Promise<void> {
    await atomicWriteFile(join(this.#options.directory, 'selected-runtime.json'), JSON.stringify({ version, bundleVersion }))
  }
  async recovery(): Promise<RecoveryView> {
    const manifest = JSON.parse(await readFile(join(this.#options.bundle, 'runtime.json'), 'utf8'))
    return { bundledVersion: manifest.version, currentVersion: this.#record?.version ?? null, backups: (await listEngineBackups(this.#options.directory)).map(({ id, createdAt, version, kind }) => ({ id, createdAt, version, kind })), message: this.#view.problem }
  }
  async #runTransition(operation: () => Promise<void>): Promise<void> {
    if (this.#transition) throw new Error('An engine transition is already in progress.')
    const transition = operation()
    this.#transition = transition
    try { await transition } finally { if (this.#transition === transition) this.#transition = null }
  }
  async update(): Promise<void> {
    if (this.#starting) throw new Error('An engine transition is already in progress.')
    await this.#runTransition(async () => {
      const runtime = await stageRuntime(this.#options.bundle, this.#options.directory)
      if (runtime.version === this.#record?.version) return
      await rm(join(this.#options.directory, 'selected-runtime.json'), { force: true })
      await this.#upgrade(runtime)
    })
  }
  async #upgrade(runtime: StagedRuntime): Promise<void> {
    if (this.#changing || !this.#record) return
    const previous = await this.#runtime(this.#record.version)
    this.#changing = true
    let release: (() => Promise<void>) | undefined
    let backup: EngineBackup | undefined
    try {
      try { release = await this.#options.reserveChange?.() } catch (error) {
        this.#pendingRuntime = runtime
        this.#publish({ problem: `Engine update is waiting. ${String(error)}` }); return
      }
      this.#pendingRuntime = null
      await this.#halt(false)
      backup = await createEngineBackup(this.#options.directory, previous, 'upgrade', this.#options.captureState ?? (async () => undefined), runtime.version)
      await atomicWriteFile(join(this.#options.directory, 'transition.json'), JSON.stringify({ backupId: backup.id, targetVersion: runtime.version }))
      this.#stopping = false
      await this.#launch(runtime, join(this.#options.directory, 't3'))
      await rm(join(this.#options.directory, 'transition.json'), { force: true })
    } catch (error) {
      await this.#halt(false)
      if (backup) {
        await createEngineBackup(this.#options.directory, runtime, 'failed-update', this.#options.captureState ?? (async () => undefined))
        await atomicWriteFile(join(this.#options.directory, 'transition.json'), JSON.stringify({ backupId: backup.id, targetVersion: previous.version }))
        await restoreEngineBackup(this.#options.directory, backup, this.#options.restoreState ?? (async () => undefined))
      }
      await this.#pin(previous.version, runtime.version)
      this.#stopping = false
      await this.#launch(previous, join(this.#options.directory, 't3'))
      await rm(join(this.#options.directory, 'transition.json'), { force: true })
      this.#publish({ problem: `The update failed; the previous engine is running. ${String(error)}` })
    } finally { this.#changing = false; await release?.() }
  }
  async restore(backupId: string): Promise<void> {
    await this.#runTransition(() => this.#restore(backupId))
  }
  async #restore(backupId: string): Promise<void> {
    if (this.#starting || this.#changing || !this.#record) throw new Error('Wait for the current engine transition to finish.')
    this.#pendingRuntime = null
    const backup = await readEngineBackup(this.#options.directory, backupId)
    await verifyRuntime(backup.runtime)
    let release: (() => Promise<void>) | undefined
    let archive: EngineBackup | undefined
    const current = await this.#runtime(this.#record.version)
    const bundled = JSON.parse(await readFile(join(this.#options.bundle, 'runtime.json'), 'utf8'))
    this.#changing = true
    try {
      release = await this.#options.reserveChange?.()
      await this.#halt(false)
      archive = await createEngineBackup(this.#options.directory, current, 'newer-work', this.#options.captureState ?? (async () => undefined))
      await atomicWriteFile(join(this.#options.directory, 'transition.json'), JSON.stringify({ backupId: backup.id, targetVersion: backup.version }))
      await restoreEngineBackup(this.#options.directory, backup, this.#options.restoreState ?? (async () => undefined))
      await this.#pin(backup.version, bundled.version)
      this.#stopping = false
      await this.#launch(backup.runtime, join(this.#options.directory, 't3'))
      await rm(join(this.#options.directory, 'transition.json'), { force: true })
      this.#publish({ problem: `Restored ${backup.createdAt}. Newer engine work is preserved in ${join(this.#options.directory, 'backups', archive.id)}. Markdown files and unsent text were kept.` })
    } catch (error) {
      if (archive) {
        await this.#halt(false)
        await atomicWriteFile(join(this.#options.directory, 'transition.json'), JSON.stringify({ backupId: archive.id, targetVersion: current.version }))
        await restoreEngineBackup(this.#options.directory, archive, this.#options.restoreState ?? (async () => undefined))
        await this.#pin(current.version, bundled.version)
        this.#stopping = false; await this.#launch(current, join(this.#options.directory, 't3'))
        await rm(join(this.#options.directory, 'transition.json'), { force: true })
      } else if (this.#stopping) { this.#stopping = false; await this.#launch(current, join(this.#options.directory, 't3')) }
      throw error
    } finally { this.#changing = false; await release?.() }
  }
  async #launch(runtime: StagedRuntime, baseDirectory: string): Promise<void> {
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const network = this.#options.network?.() ?? {}
    const host = network.lan ? '0.0.0.0' : '127.0.0.1'
    const token = randomBytes(32).toString('base64url')
    const executable = join(runtime.directory, runtime.executable)
    const env = engineEnvironment()
    env.PATH = `${dirname(executable)}:${env.PATH ?? ''}`
    const child = spawn(executable, [join(runtime.directory, runtime.entry), '--base-dir', baseDirectory, '--host', host, '--port', String(port), '--no-browser', '--bootstrap-fd', '3'], { cwd: baseDirectory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    this.#child = child
    let spawnError: Error | null = null
    child.once('error', error => { spawnError = error })
    const pipe = child.stdio[3] as import('node:stream').Writable
    pipe.on('error', () => undefined)
    // Record the owned incarnation before bootstrap. A crash before pairing must not leave an unrecorded database writer.
    if (!child.pid) throw spawnError ?? new Error('The engine process could not be spawned.')
    let knownEnvironmentId = ''
    try { knownEnvironmentId = (await readFile(join(baseDirectory, 'userdata/environment-id'), 'utf8')).trim() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.#record = { phase: 'bootstrap', pid: child.pid, ...await processStamp(child.pid), executable, baseDirectory, version: runtime.version, nodeVersion: runtime.nodeVersion, runtimeDirectory: runtime.directory, generation: randomUUID(), address: `http://127.0.0.1:${port}`, environmentId: knownEnvironmentId }
    await atomicWriteFile(join(this.#options.directory, 'runtime.json'), JSON.stringify(this.#record))
    pipe.end(JSON.stringify({ mode: 'desktop', noBrowser: true, port, t3Home: baseDirectory, host, desktopBootstrapToken: token, tailscaleServeEnabled: network.tailscale === true, tailscaleServePort: network.tailscalePort ?? 443 }))
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
        if (reported.pid !== child.pid || !['127.0.0.1', host].includes(address.hostname) || address.port !== String(port)) { await pause(50); continue }
        address.hostname = '127.0.0.1'
        const environmentId = (await readFile(join(baseDirectory, 'userdata', 'environment-id'), 'utf8')).trim()
        const record: RuntimeRecord = { phase: 'bootstrap', pid: child.pid!, ...await processStamp(child.pid!), executable, baseDirectory, version: runtime.version, nodeVersion: runtime.nodeVersion, runtimeDirectory: runtime.directory, generation: randomUUID(), address: address.origin, environmentId }
        if (!await verifiedProcess(record)) throw new Error(`Could not verify newly launched engine process ${child.pid}`)
        this.#record = record
        await this.#options.connect(address.origin, token, environmentId)
        if (!await this.#options.authenticate(address.origin)) throw new Error(`Engine at ${address.origin} did not pass authenticated readiness`)
        record.phase = 'ready'
        await atomicWriteFile(join(this.#options.directory, 'runtime.json'), JSON.stringify(record))
        child.once('exit', (code, signal) => { if (this.#child === child) this.#unexpectedExit(code, signal) })
        this.#healthySince = Date.now()
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
      if (!this.#record || this.#stopping || this.#changing) return
      if (this.#pendingRuntime) { void this.#runTransition(() => this.#upgrade(this.#pendingRuntime!)).catch(error => this.#publish({ problem: String(error) })); return }
      const record = this.#record
      void verifiedProcess(record).then(alive => {
        if (this.#record !== record || this.#stopping) return
        if (!alive) this.#unexpectedExit()
        else if (this.#healthySince !== null && Date.now() - this.#healthySince >= (this.#options.healthyIntervalMs ?? 300_000)) this.#attempt = 0
      })
    }, Math.min(5000, this.#options.healthyIntervalMs ?? 5000))
    this.#healthTimer.unref()
  }
  #unexpectedExit(exitCode: number | null = null, signal: string | null = null): void {
    // Native exit and an in-flight health check can report the same death.
    // Once recovery starts, late reports must not spend another retry.
    if (this.#stopping || this.#restartTimer || this.#view.state !== 'running') return
    if (this.#healthTimer) clearInterval(this.#healthTimer)
    this.#healthTimer = null
    this.#healthySince = null
    this.#publish({ problem: 'The engine stopped. Documents remain available.', failure: { at: Date.now(), exitCode, signal, attempt: this.#attempt } })
    this.#scheduleRecovery()
  }
  #scheduleRecovery(): void {
    if (this.#stopping || this.#restartTimer) return
    this.#healthySince = null
    if (this.#attempt >= 3) { this.#publish({ state: 'failed' }); return }
    this.#publish({ state: 'recovering' })
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
    await this.#transition?.catch(() => undefined)
    await this.#halt(true)
  }
  async #halt(release: boolean): Promise<void> {
    let clean = release && this.#view.state === 'running' && !this.#changing && this.#healthySince !== null
    this.#healthySince = null
    this.#stopping = true
    if (this.#healthTimer) clearInterval(this.#healthTimer)
    this.#healthTimer = null
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = null
    const alive = this.#record && await verifiedProcess(this.#record)
    clean = clean && !!alive
    if (this.#record && alive) {
      process.kill(this.#record.pid, 'SIGTERM')
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && await verifiedProcess(this.#record)) await pause(50)
      if (await verifiedProcess(this.#record)) {
        clean = false
        process.kill(-this.#record.pid, 'SIGKILL')
        const killedDeadline = Date.now() + 2000
        while (Date.now() < killedDeadline && await verifiedProcess(this.#record)) await pause(25)
        if (await verifiedProcess(this.#record)) throw new Error('The owned engine did not stop. Its data was left in place.')
      }
    } else if (this.#child?.pid && this.#child.exitCode === null && this.#child.signalCode === null) {
      // A child handle still owned by this parent can be stopped before a runtime record exists.
      const child = this.#child
      child.kill('SIGTERM')
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) await pause(50)
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }
    await this.#logQueue
    if (clean && this.#record) await retainEngineRecovery(this.#options.directory, this.#record.version).catch(error => this.#publish({ problem: `Engine stopped. Recovery files were kept because cleanup could not finish: ${String(error)}` }))
    if (release) { await this.#release?.(); this.#release = null }
    this.#child = null
    this.#publish({ state: 'stopped' })
  }
}
