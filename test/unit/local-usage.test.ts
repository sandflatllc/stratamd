import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { measureLocalUsage } from '../../src/main/engine/local-usage'
import type { EngineProviderInstance } from '../../src/main/engine/accounts'

it('reads duration-based Codex windows, rejects a different account, and cancels an owned worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-usage-'))
  const binary = join(root, 'codex')
  const context = { executable: process.execPath, directory: root, baseDirectory: root }
  const provider: EngineProviderInstance = { instanceId: 'work', driver: 'codex', displayName: 'Work', homePath: root, enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated', email: 'test@example.com' } }
  const settings = { providerInstances: { work: { driver: 'codex', config: { binaryPath: binary, homePath: root } } } }
  const helper = resolve('resources/engine-helpers/usage.mjs')
  try {
    await writeFile(binary, `#!${process.execPath}\nconst rl = require('node:readline').createInterface({input:process.stdin}); rl.on('line', line => { const q=JSON.parse(line); if(q.id === undefined)return; const result=q.method==='account/read'?{account:{email:'test@example.com',planType:'pro'}}:q.method==='account/rateLimits/read'?{rateLimits:{primary:{windowDurationMins:10080,usedPercent:78,resetsAt:2000000000},secondary:null}}:{}; process.stdout.write(JSON.stringify({id:q.id,result})+'\\n'); });\n`, { mode: 0o700 })
    const measurement = await measureLocalUsage(context, helper, provider, settings, new AbortController().signal)
    expect(measurement).toMatchObject({ session: null, weekly: { usedPercent: 78, resetsAt: new Date(2000000000000).toISOString() }, planLabel: 'pro' })
    expect(await measureLocalUsage(null, helper, provider, settings, new AbortController().signal)).toBeNull()
    expect(await measureLocalUsage(context, helper, { ...provider, auth: { status: 'authenticated', email: 'someone-else@example.com' } }, settings, new AbortController().signal)).toBeNull()
    expect(await measureLocalUsage(context, helper, provider, { providerInstances: { work: { ...settings.providerInstances.work, environment: [{ name: 'SECRET', value: '', sensitive: true, valueRedacted: true }] } } }, new AbortController().signal)).toBeNull()
    const hanging = join(root, 'hanging.mjs')
    await writeFile(hanging, 'setInterval(() => {}, 1000)')
    const abort = new AbortController()
    const pending = measureLocalUsage(context, hanging, provider, settings, abort.signal)
    abort.abort()
    expect(await pending).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})
