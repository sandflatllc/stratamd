import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { engineEnvironment } from '../../src/main/engine/launch-environment'
import { verifiedServeEndpoint } from '../../src/main/engine/tailscale'
import { T3Connect } from '../../src/main/engine/connect'

it('offers HTTPS only for the actual device, listener and engine mapping', () => {
  const status = { BackendState: 'Running', Self: { DNSName: 'strata.example.ts.net.' } }
  const serve = { TCP: { '8443': { HTTPS: true } }, Web: { 'strata.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:3774' } } } } }
  expect(verifiedServeEndpoint(status, serve, 'http://127.0.0.1:3774', 8443)).toBe('https://strata.example.ts.net:8443')
  expect(verifiedServeEndpoint(status, serve, 'http://127.0.0.1:4774', 8443)).toBeNull()
  expect(verifiedServeEndpoint(status, serve, 'http://127.0.0.1:3774', 443)).toBeNull()
  expect(verifiedServeEndpoint({ ...status, Self: { DNSName: 'other.ts.net' } }, serve, 'http://127.0.0.1:3774', 8443)).toBeNull()
  expect(verifiedServeEndpoint(status, {}, 'http://127.0.0.1:3774', 8443)).toBeNull()
})

it('retains validated cloudflared overrides and PATH discovery without importing unrelated T3 settings', () => {
  expect(engineEnvironment({ PATH: '/tools', T3CODE_PORT: '999', T3CODE_CLOUDFLARED_PATH: process.execPath })).toEqual({ PATH: '/tools', T3CODE_CLOUDFLARED_PATH: process.execPath })
  expect(engineEnvironment({ PATH: '/tools' })).toEqual({ PATH: '/tools' })
  expect(() => engineEnvironment({ T3CODE_CLOUDFLARED_PATH: 'cloudflared' })).toThrow('absolute')
  expect(() => engineEnvironment({ T3CODE_CLOUDFLARED_PATH: '/missing/cloudflared' })).toThrow('not an executable')
})

it('deduplicates expensive Connect status processes and refreshes explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-connect-count-'))
  try {
    await mkdir(join(root, 'node_modules/t3/dist'), { recursive: true })
    await writeFile(join(root, 'node_modules/t3/dist/bin.mjs'), `import{appendFileSync}from'node:fs';appendFileSync('count','x');console.log(JSON.stringify({desired:false,authenticated:false,linked:false,cloudUserId:null,publishAgentActivity:false,relayClient:{status:'missing'}}));`)
    const control = new T3Connect(), context = { executable: process.execPath, directory: root, baseDirectory: root }
    await Promise.all(Array.from({ length: 8 }, () => control.status(context, true)))
    expect(await readFile(join(root, 'count'), 'utf8')).toBe('x')
    await control.status(context); expect(await readFile(join(root, 'count'), 'utf8')).toBe('x')
    await control.status(context, true); expect(await readFile(join(root, 'count'), 'utf8')).toBe('xx')
  } finally { await rm(root, { recursive: true, force: true }) }
})
