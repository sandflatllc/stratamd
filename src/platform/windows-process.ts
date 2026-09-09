import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** CommandLineToArgvW quoting rules for command lines supplied by Windows. */
export function windowsArguments(command: string): string[] {
  const args: string[] = []
  let value = '', quoted = false, started = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (char === '\\') {
      let slashes = 1
      while (command[index + 1] === '\\') { slashes++; index++ }
      if (command[index + 1] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2)); index++
        if (slashes % 2) value += '"'; else quoted = !quoted
      } else value += '\\'.repeat(slashes)
      started = true
    } else if (char === '"') { quoted = !quoted; started = true }
    else if (/\s/.test(char) && !quoted) { if (started) args.push(value); value = ''; started = false }
    else { value += char; started = true }
  }
  if (started) args.push(value)
  return args
}

export async function windowsProcessArguments(pid: number): Promise<string[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 })
  const command: unknown = JSON.parse(stdout)
  return typeof command === 'string' ? windowsArguments(command) : []
}
