import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'

export async function runProcess(command, args, { cwd, env, log, signal }) {
  signal.throwIfAborted()
  const stream = createWriteStream(log)
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false })
  const killGroup = how => { if (!child.pid) return; try { process.kill(-child.pid, how) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  // Electron and managed children may own separate process groups. Capture
  // descendants before terminating the parent, while ownership is observable.
  const processRows = () => execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [, pid, parent, born] = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/) ?? []
    return { pid: Number(pid), parent: Number(parent), born }
  })
  let descendants = []
  const killDescendants = how => {
    const current = new Map(processRows().map(row => [row.pid, row.born]))
    for (const row of descendants.toReversed()) if (current.get(row.pid) === row.born) {
      try { process.kill(row.pid, how) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  let timer
  const cancel = () => {
    const rows = processRows(), owned = new Set([child.pid])
    for (let changed = true; changed;) {
      changed = false
      for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); descendants.push(row); changed = true }
    }
    killDescendants('SIGTERM'); killGroup('SIGTERM')
    timer = setTimeout(() => { killDescendants('SIGKILL'); killGroup('SIGKILL') }, 3000)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, reason) => code === 0 ? accept() : reject(new Error(`${command} exited ${code ?? reason}; see ${log}`)))
    })
    signal.throwIfAborted()
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    // Children that outlive their command cannot compete with the next owner.
    if (descendants.length) killDescendants('SIGKILL')
    killGroup('SIGKILL')
    await new Promise(resolve => stream.end(resolve))
  }
}
