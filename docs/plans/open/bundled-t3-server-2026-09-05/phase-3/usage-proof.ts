import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LocalEngineManager } from '../../../../../src/main/engine/manager'
import { T3EngineClient } from '../../../../../src/main/engine/client'
import { measureLocalUsage } from '../../../../../src/main/engine/local-usage'
async function main() {
const root = await mkdtemp(join(tmpdir(), 'strata-phase3-usage-'))
const results: Record<string, unknown> = {}
let manager: LocalEngineManager
const client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null, localUsageAvailable: () => true, measureUsage: async (provider, settings, signal) => { const value = await measureLocalUsage(manager.runtimeContext(), resolve('resources/engine-helpers/usage.mjs'), provider, settings, signal); results[provider.driver] = value; return value } })
manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle: resolve('docs/plans/open/bundled-t3-server-2026-09-05/phase-1/runtime/0.0.38'), connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(), changed: () => undefined, authenticate: async address => { const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8')); return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok } })
try {
  await manager.start()
  if (manager.view().state !== 'running') throw new Error(manager.view().problem ?? 'Engine failed')
  await client.reportActivity({ clientId: 'strata-usage-proof', visible: true, focused: true, recentlyInteracted: true, hostPower: { source: 'electron-main', idle: 'false', idleSeconds: 0, locked: 'false', suspended: false, onBattery: 'false', lowPowerMode: 'false', thermalState: 'unknown', stale: false, updatedAt: new Date().toISOString() } }, true)
  await client.refreshAccounts()
  const deadline = Date.now() + 40000
  while (Object.keys(results).length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  await writeFile('docs/plans/open/bundled-t3-server-2026-09-05/phase-3/usage-proof.json', JSON.stringify({ measuredAt: new Date().toISOString(), results, view: client.view().accounts.map(({ driver, measuredAt, session, weekly, plan, usageAvailable }) => ({ driver, measuredAt, session, weekly, plan, usageAvailable })) }, null, 2))
  console.log(JSON.stringify(results))
} finally { await client.shutdown(); await manager.stop(); await rm(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
