import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export async function acquireLock(root, owner, signal, announce = console.log) {
  await mkdir(root, { recursive: true })
  const path = join(root, 'heavy-run.lock'), started = Date.now()
  for (;;) {
    signal.throwIfAborted()
    try { await mkdir(path); break }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    let holder
    try { holder = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) }
    catch { holder = { status: 'ownership metadata pending; inspect lock before manual recovery' } }
    announce(`Waiting ${((Date.now() - started) / 1000).toFixed(1)}s for ${JSON.stringify(holder)}; requested ${owner.mode}`)
    // Unknown/stale ownership is never stolen. An operator can inspect and remove
    // an abandoned lock after confirming its process group has exited.
    await delay(1000, undefined, { signal })
  }
  try { await writeFile(join(path, 'owner.json'), JSON.stringify({ ...owner, pid: process.pid, started: new Date().toISOString() })) }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error }
  return async () => { await rm(path, { recursive: true, force: true }) }
}
