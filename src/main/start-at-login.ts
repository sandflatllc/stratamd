import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, rm } from 'node:fs/promises'
import { atomicWriteFile } from './storage'
export async function setStartAtLogin(enabled: boolean, executable: string, platform: string, mac: (enabled: boolean) => void, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (platform === 'darwin') { mac(enabled); return }
  if (platform !== 'linux') throw new Error('Start at login is unavailable on this operating system.')
  const path = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'stratamd.desktop')
  if (!enabled) { await rm(path, { force: true }); return }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const quoted = '"' + executable.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%') + '"'
  if (/[\r\n]/.test(executable)) throw new Error('The Strata executable path cannot contain a newline.')
  await atomicWriteFile(path, `[Desktop Entry]\nType=Application\nName=StrataMD\nExec=${quoted}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`)
}
