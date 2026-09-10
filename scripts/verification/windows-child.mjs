import { spawn } from 'node:child_process'

// The parent assigns this bootstrap to a kill-on-close Windows job before
// granting permission to spawn. Even detached grandchildren inherit that job.
process.once('disconnect', () => process.exit(1))
process.once('message', ({ command, args }) => {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  child.once('error', error => { console.error(error); process.exit(1) })
  child.once('exit', code => process.exit(code ?? 1))
})
