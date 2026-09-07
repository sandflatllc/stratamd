/** Manual release proof. Uses an already signed-in provider and a disposable engine. */
import { app, BrowserWindow } from 'electron'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { T3EngineClient } from '../../src/main/engine/client'
import { LocalEngineManager } from '../../src/main/engine/manager'
import { PreviewHost } from '../../src/main/preview/host'
const root = process.env.STRATA_ROUNDTRIP_ROOT!
app.setPath('userData', join(root, 'electron'))
process.env.XDG_DATA_HOME = join(root, 'data')
process.env.XDG_CONFIG_HOME = join(root, 'config')
app.on('window-all-closed', () => {})
const until = async (condition: () => boolean, budget = 30000) => { const deadline = Date.now() + budget; while (!condition()) { if (Date.now() > deadline) throw new Error('Release proof condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)) } }
app.whenReady().then(async () => {
  await mkdir(join(root, 'project'), { recursive: true })
  const nonce = 'preview-proof-' + Math.random().toString(36).slice(2)
  const site = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<body><h1>Stock preview proof</h1><p>${nonce}</p><button>Capture verified</button></body>`) })
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`
  let client: T3EngineClient
  const requests: Array<{ operation: string; ok: boolean; error?: unknown }> = []
  const host = new PreviewHost({ dataDirectory: root, resolveProject: id => { const p = client.view().projects.find(p => p.id === id); return p ? { workspaceRoot: p.workspaceRoot, title: p.title } : null }, resolveThread: id => { const p = client.view().projects.find(p => p.threads.some(t => t.id === id)); return p ? { projectId: p.id, workingFolder: p.workspaceRoot } : null } })
  client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null, previewHost: { operations: host.operations, setRegistered: value => { console.log('preview registered', value); host.setRegistered(value) }, handle: async request => { console.log('preview request', request.operation); const result = await host.handle(request); requests.push({ operation: request.operation, ok: result.ok, ...(!result.ok ? { error: result.error } : {}) }); console.log('preview operation', request.operation, result.ok); return result } } })
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle: process.env.STRATAMD_ENGINE_BUNDLE!, changed: () => undefined, connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(), authenticate: async address => { const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8')); return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok } })
  const window = new BrowserWindow({ width: 800, height: 600, show: true })
  await window.loadURL('data:text/html,<body>Disposable stock preview proof</body>'); host.attachWindow(window)
  let report: Record<string, unknown> = {}
  try {
    await manager.start()
    if (manager.view().state !== 'running') throw new Error(manager.view().problem ?? 'Engine failed')
    const settings = await client.readSettings()
    await client.editProvider({ identity: client.view().identity!, instanceId: 'codex', base: settings.providerInstances.codex!, patch: { enabled: true, config: { binaryPath: process.env.STRATA_CODEX_BINARY! } } })
    await client.refreshAccounts()
    await until(() => client.view().accounts.some(account => account.instanceId === 'codex' && account.usable))
    const projectId = await client.createProject({ title: 'Disposable preview release proof', workspaceRoot: join(root, 'project') })
    await until(() => client.view().projects.some(project => project.id === projectId))
    const model = client.view().models?.find(model => model.instanceId === 'codex' && model.slug === 'gpt-5.4') ?? client.view().models?.find(model => model.instanceId === 'codex')
    if (!model) throw new Error('No Codex model is available')
    const threadId = await client.createThread({ projectId, title: 'Stock preview round trip', instanceId: 'codex', model: model.slug, effort: null, access: 'full-access' })
    await client.openThread(threadId)
    console.log('stock thread ready', model.slug)
    await client.startTurn(threadId, { instanceId: 'codex', model: model.slug, effort: null, access: 'full-access', text: `Use the T3 preview browser tools provided to you to open ${url}, inspect the page and take a preview snapshot with its screenshot. Report the exact proof string visible in the paragraph. Do not use curl, terminal, external browser automation or filesystem tools to read the page. This verifies the stock T3 preview host round trip. Make no project changes. Finish with the proof string after the snapshot succeeds.` })
    await until(() => client.view().projects.flatMap(p => p.threads).find(t => t.id === threadId)?.messages?.some(message => message.role === 'assistant' && message.text.includes(nonce)) === true, 180000)
    const success = requests.some(request => request.operation === 'open' && request.ok) && requests.some(request => request.operation === 'snapshot' && request.ok)
    report = { success, engine: manager.view().version, model: model.slug, nonceReturned: true, requests }
    if (!success) throw new Error('The provider returned text without the required successful preview operations')
  } catch (error) { report = { ...report, success: false, error: String(error), requests, threads: client.view().projects.flatMap(project => project.threads) }; throw error }
  finally { await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); await manager.stop(); await client.shutdown(); await host.shutdown(); site.close(); window.destroy() }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
