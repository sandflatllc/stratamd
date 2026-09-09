import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { atomicWriteFile } from './storage'
export async function setStartAtLogin(enabled: boolean, executable: string, platform: string, mac: (enabled: boolean) => void, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (platform === 'darwin' || platform === 'win32') { mac(enabled); return }
  if (platform !== 'linux') throw new Error('Start at login is unavailable on this operating system.')
  const path = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'stratamd.desktop')
  if (!enabled) { await rm(path, { force: true }); return }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const quoted = '"' + executable.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%') + '"'
  if (/[\r\n]/.test(executable)) throw new Error('The Strata executable path cannot contain a newline.')
  const content = `[Desktop Entry]\nType=Application\nName=StrataMD\nExec=${quoted} --ozone-platform=x11\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`
  if (await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error }) !== content) await atomicWriteFile(path, content)
}

export interface LoginRegistration {
  packaged: boolean
  executable: string
  platform: string
  env?: NodeJS.ProcessEnv
  mac: { get(): { openAtLogin: boolean; path?: string }; set(enabled: boolean): void }
  testFile?: string | undefined
}

/** Test wiring never receives the native adapter; development leaves OS entries alone. */
export function createLoginRegistration(options: LoginRegistration): (enabled: boolean) => Promise<void> {
  return async enabled => {
    if (options.testFile) {
      await atomicWriteFile(options.testFile, JSON.stringify({ enabled, executable: options.executable }) + '\n')
      return
    }
    if (!options.packaged) return
    await setStartAtLogin(enabled, options.executable, options.platform, value => {
      const current = options.mac.get()
      if (current.openAtLogin !== value || value && current.path !== options.executable) options.mac.set(value)
    }, options.env)
  }
}
