import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { T3Connect } from '../../src/main/engine/connect'
import { setStartAtLogin } from '../../src/main/start-at-login'

it('keeps Connect authorization ephemeral, cancels its own child, and reports rejected authorization without claiming a connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-connect-job-'))
  const control = new T3Connect()
  try {
    await mkdir(join(root, 'node_modules/t3/dist'), { recursive: true })
    await writeFile(join(root, 'node_modules/t3/dist/bin.mjs'), `const args=process.argv.slice(2); if(args.includes('status')) console.log(JSON.stringify({desired:false,authenticated:false,linked:false,cloudUserId:null,publishAgentActivity:false,relayClient:{status:'missing'}})); else if(args.includes('login')) { console.log('https://app.t3.codes/connect?test=ephemeral'); process.stdin.on('data',()=>{ console.error('Authorization expired');process.exit(1) }); setInterval(()=>{},1000) }`)
    const context = { directory: root, baseDirectory: root, executable: process.execPath }
    expect(await control.status(context)).toMatchObject({ authenticated: false, relayClient: { status: 'missing' } })
    let restored = 0
    control.start(context, ['login', '--headless'], async () => undefined, async () => { restored++ })
    await expect.poll(() => control.view().url).toContain('app.t3.codes/connect')
    await control.cancel(); expect(control.view()).toMatchObject({ state: 'cancelled', output: '' }); expect(restored).toBe(1)
    control.start(context, ['login', '--headless'], async () => undefined, async () => { restored++ })
    await expect.poll(() => control.view().url).toContain('app.t3.codes/connect')
    control.input('invalid-code')
    await expect.poll(() => control.busy).toBe(false)
    expect(control.view()).toMatchObject({ state: 'failed' }); expect(control.view().message).toContain('sign in to T3 again')
    expect(restored).toBe(2)
  } finally { await control.cancel(); await rm(root, { recursive: true, force: true }) }
})

it('writes only the selected isolated login entry and removes it when disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-autostart-'))
  try {
    await setStartAtLogin(true, '/apps/Strata Folder/stratamd-app', 'linux', () => undefined, { XDG_CONFIG_HOME: root })
    expect(await readFile(join(root, 'autostart/stratamd.desktop'), 'utf8')).toContain('Exec="/apps/Strata Folder/stratamd-app"')
    await setStartAtLogin(false, '/unused', 'linux', () => undefined, { XDG_CONFIG_HOME: root })
    await expect(readFile(join(root, 'autostart/stratamd.desktop'))).rejects.toThrow()
    let enabled = false
    await setStartAtLogin(true, '/Applications/Strata.app', 'darwin', value => { enabled = value }, {})
    expect(enabled).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
