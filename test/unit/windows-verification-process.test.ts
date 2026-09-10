import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error The runner is a directly executable Node module.
import { runProcess } from '../../scripts/verification/process.mjs'

for (const action of ['exit', 'cancel']) it.skipIf(process.platform !== 'win32')(`Windows command ${action} closes its job and detached descendants`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-job-'))
  const pidFile = join(root, 'child.pid')
  const controller = new AbortController()
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const live = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const source = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' }); child.unref(); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); ${action === 'exit' ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}`
  const done = runProcess(process.execPath, ['-e', source], { cwd: resolve('.'), env: process.env, log: join(root, 'command.log'), signal: controller.signal }).then(() => 'passed', () => 'cancelled')
  try {
    await expect.poll(async () => readFile(pidFile, 'utf8').catch(() => '')).not.toBe('')
    const pid = Number(await readFile(pidFile, 'utf8'))
    if (action === 'cancel') controller.abort()
    expect(await done).toBe(action === 'exit' ? 'passed' : 'cancelled')
    await expect.poll(() => live(pid)).toBe(false)
    expect(live(unrelated.pid!)).toBe(true)
  } finally {
    controller.abort(); await done
    const closed = new Promise<void>(accept => unrelated.once('exit', () => accept()))
    unrelated.kill(); await closed
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
