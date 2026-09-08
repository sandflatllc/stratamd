import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, statSync } from 'node:fs'

export async function runProcess(command, args, { cwd, env, log, signal, streamOutput = Boolean(process.env.CI), progress }) {
  signal.throwIfAborted()
  const stream = createWriteStream(log)
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { stream.write(chunk); if (streamOutput) process.stdout.write(chunk) })
  child.stderr.on('data', chunk => { stream.write(chunk); if (streamOutput) process.stderr.write(chunk) })
  const diagnostic = error => {
    const message = `\nProcess cleanup diagnostic: ${error.stack ?? error}\n`
    stream.write(message)
    if (streamOutput) process.stderr.write(message)
  }
  const killGroup = how => { if (!child.pid) return; try { process.kill(-child.pid, how) } catch (error) { if (error.code !== 'ESRCH') diagnostic(error) } }
  // Electron and managed children may own separate process groups. Capture
  // descendants before terminating the parent, while ownership is observable.
  const processRows = () => execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [, pid, parent, born] = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/) ?? []
    return { pid: Number(pid), parent: Number(parent), born }
  })
  let descendants = []
  const killDescendants = how => {
    let current
    try { current = new Map(processRows().map(row => [row.pid, row.born])) }
    catch (error) { diagnostic(error); return }
    for (const row of descendants.toReversed()) if (current.get(row.pid) === row.born) {
      try { process.kill(row.pid, how) } catch (error) { if (error.code !== 'ESRCH') diagnostic(error) }
    }
  }
  let killTimer, watchdogTimer, watchdogError, terminating = false
  const cancel = () => {
    if (terminating) return
    terminating = true
    const owned = new Set([child.pid])
    // Freeze the command group before taking the ownership snapshot. Otherwise
    // a child can detach between `ps` and SIGTERM, losing its visible lineage.
    killGroup('SIGSTOP')
    for (let changed = true; changed;) {
      changed = false
      let rows = []
      try { rows = processRows() } catch (error) { diagnostic(error); break }
      for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid); descendants.push(row); changed = true
        try { process.kill(row.pid, 'SIGSTOP') } catch (error) { if (error.code !== 'ESRCH') diagnostic(error) }
      }
    }
    if (descendants.length) stream.write(`\nProcess cleanup captured descendants: ${descendants.map(row => row.pid).join(', ')}\n`)
    killDescendants('SIGTERM'); killGroup('SIGTERM')
    killDescendants('SIGCONT'); killGroup('SIGCONT')
    killTimer = setTimeout(() => { killDescendants('SIGKILL'); killGroup('SIGKILL') }, 3000)
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (progress) {
    let lastChange = Date.now(), lastMtime = 0
    const interval = Math.min(10_000, Math.max(100, Math.floor(progress.timeoutMs / 4)))
    const failWatchdog = error => {
      if (watchdogError) return
      watchdogError = error
      const message = `\n${watchdogError.message}\n`
      stream.write(message)
      if (streamOutput) process.stderr.write(message)
      cancel()
    }
    watchdogTimer = setInterval(() => {
      try {
        const mtime = statSync(progress.file).mtimeMs
        if (mtime > lastMtime) { lastMtime = mtime; lastChange = Date.now() }
      } catch (error) {
        if (error.code !== 'ENOENT') { failWatchdog(new Error(`Cannot read test-event progress ${progress.file}: ${error.message}`)); return }
      }
      if (Date.now() - lastChange >= progress.timeoutMs) failWatchdog(new Error(`${command} made no test-event progress for ${Math.round(progress.timeoutMs / 1000)}s; see ${log}`))
    }, interval)
    watchdogTimer.unref()
  }
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, reason) => code === 0 && !watchdogError ? accept() : reject(watchdogError ?? new Error(`${command} exited ${code ?? reason}; see ${log}`)))
    })
    signal.throwIfAborted()
  } finally {
    clearTimeout(killTimer)
    clearInterval(watchdogTimer)
    signal.removeEventListener('abort', cancel)
    // Children that outlive their command cannot compete with the next owner.
    if (descendants.length) killDescendants('SIGKILL')
    killGroup('SIGKILL')
    await new Promise(resolve => stream.end(resolve))
  }
}
