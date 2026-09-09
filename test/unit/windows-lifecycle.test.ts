import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('asks the stock runtime to run its shutdown hooks over private parent IPC', async () => {
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('resources/engine-helpers/windows-lifecycle.mjs')).href, '-e', `process.on('SIGTERM', () => { process.send('graceful'); process.exit(0) }); process.send('ready'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const messages: unknown[] = []
  child.on('message', message => messages.push(message))
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  try {
    await expect.poll(() => messages).toContain('ready')
    child.send({ type: 'strata:shutdown' })
    expect(await exited).toBe(0)
    expect(messages).toEqual(['ready', 'graceful'])
  } finally { if (child.exitCode === null) child.kill('SIGKILL') }
})
