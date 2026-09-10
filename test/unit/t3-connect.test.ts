import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { T3Connect } from '../../src/main/engine/connect'
import { setStartAtLogin } from '../../src/main/start-at-login'

it('lets recovery replace engine data while a connection status check is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-connect-recovery-'))
  const directory = join(root, 'runtime'), baseDirectory = join(root, 't3')
  const ready = join(root, 'ready'), release = join(root, 'release')
  let pending: Promise<unknown> | undefined
  try {
    await mkdir(join(directory, 'node_modules/t3/dist'), { recursive: true })
    await mkdir(baseDirectory)
    const status = { desired: false, authenticated: false, linked: false, cloudUserId: null, publishAgentActivity: false, relayClient: { status: 'missing' } }
    await writeFile(join(directory, 'status.json'), JSON.stringify(status))
    await writeFile(join(baseDirectory, 'status.json'), JSON.stringify(status))
    await writeFile(join(directory, 'node_modules/t3/dist/bin.mjs'), `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) await setTimeout(10);
      console.log(readFileSync('status.json', 'utf8'));
    `)
    pending = new T3Connect().status({ directory, baseDirectory, executable: process.execPath })
    void pending.catch(() => undefined)
    await expect.poll(() => readFile(ready, 'utf8').catch(() => '')).toBe('ready')
    await rm(baseDirectory, { recursive: true })
    await mkdir(baseDirectory)
    await writeFile(release, 'release')
    await expect(pending).resolves.toEqual(status)
  } finally {
    await writeFile(release, 'release')
    await pending?.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps Connect authorization ephemeral, cancels its own child, and reports rejected authorization without claiming a connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-connect-job-'))
  const control = new T3Connect()
  try {
    await mkdir(join(root, 'node_modules/t3/dist'), { recursive: true })
    await writeFile(join(root, 'node_modules/t3/dist/bin.mjs'), `const args=process.argv.slice(2); if(args.includes('status')) console.log(JSON.stringify({desired:false,authenticated:false,linked:false,cloudUserId:null,publishAgentActivity:false,relayClient:{status:'missing'}})); else if(args.includes('login')) { console.log('https://app.t3.codes/connect?test=ephemeral'); console.log('Authorization code'); process.stdin.on('data',()=>{ console.error('Authorization expired');process.exit(1) }); setInterval(()=>{},1000) }`)
    const context = { directory: root, baseDirectory: root, executable: process.execPath }
    expect(await control.status(context)).toMatchObject({ authenticated: false, relayClient: { status: 'missing' } })
    let restored = 0
    control.start(context, async operation => { try { await operation.execute(['login', '--headless']); return 'Signed in.' } finally { restored++ } })
    await expect.poll(() => control.view().url).toContain('app.t3.codes/connect')
    await control.cancel(); expect(control.view()).toMatchObject({ state: 'cancelled' }); expect(restored).toBe(1)
    control.start(context, async operation => { try { await operation.execute(['login', '--headless']); return 'Signed in.' } finally { restored++ } })
    await expect.poll(() => control.view().phase).toBe('code')
    control.input('invalid-code')
    await expect.poll(() => control.busy).toBe(false)
    expect(control.view()).toMatchObject({ state: 'failed' }); expect(control.view().message).toContain('fresh code')
    expect(JSON.stringify(control.view())).not.toContain('ephemeral')
    expect(restored).toBe(2)
  } finally { await control.cancel(); await rm(root, { recursive: true, force: true }) }
})

it('writes only the selected isolated login entry and removes it when disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-autostart-'))
  try {
    await setStartAtLogin(true, '/apps/Strata Folder/stratamd-app', 'linux', () => undefined, { XDG_CONFIG_HOME: root })
    expect(await readFile(join(root, 'autostart/stratamd.desktop'), 'utf8')).toContain('Exec="/apps/Strata Folder/stratamd-app" --ozone-platform=x11\n')
    await setStartAtLogin(false, '/unused', 'linux', () => undefined, { XDG_CONFIG_HOME: root })
    await expect(readFile(join(root, 'autostart/stratamd.desktop'))).rejects.toThrow()
    let enabled = false
    await setStartAtLogin(true, '/Applications/Strata.app', 'darwin', value => { enabled = value }, {})
    expect(enabled).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('isolates test login registration and leaves production entries untouched in development', async () => {
  const { createLoginRegistration } = await import('../../src/main/start-at-login')
  const root = await mkdtemp(join(tmpdir(), 'strata-login-adapter-'))
  let calls = 0
  const mac = { get: () => ({ openAtLogin: false }), set: () => { calls++ } }
  try {
    const options = { packaged: false, executable: '/apps/Strata', platform: 'darwin', mac }
    await createLoginRegistration(options)(true)
    expect(calls).toBe(0)
    const file = join(root, 'test-login.json')
    await createLoginRegistration({ ...options, packaged: true, testFile: file })(true)
    expect(JSON.parse(await readFile(file, 'utf8')).enabled).toBe(true)
    expect(calls).toBe(0)
    await createLoginRegistration({ ...options, packaged: true, mac: { get: () => ({ openAtLogin: true, path: options.executable }), set: mac.set } })(true)
    expect(calls).toBe(0)
    await createLoginRegistration({ ...options, packaged: true })(true)
    expect(calls).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('a stock-style exit-zero cancellation is not reported as a completed setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-connect-decline-')), control = new T3Connect()
  try {
    await mkdir(join(root, 'node_modules/t3/dist'), { recursive: true })
    await writeFile(join(root, 'node_modules/t3/dist/bin.mjs'), "console.log('T3 Connect setup cancelled. The relay client was not installed.');")
    control.start({ directory: root, baseDirectory: root, executable: process.execPath }, async operation => { await operation.execute(['link']); return 'Ready' })
    await expect.poll(() => control.busy).toBe(false)
    expect(control.view().state).toBe('cancelled')
    expect(control.view().message).not.toBe('Ready')
  } finally { await control.cancel(); await rm(root, { recursive: true, force: true }) }
})
