import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function toolCommand(command, args, cwd = process.cwd(), platform = process.platform) {
  if (platform !== 'win32' || !command.startsWith('./node_modules/.bin/')) return { command, args }
  const require = createRequire(resolve(cwd, 'package.json'))
  const packages = { tsc: 'typescript', vitest: 'vitest', playwright: '@playwright/test', 'electron-vite': 'electron-vite', 'electron-builder': 'electron-builder' }
  const name = command.slice('./node_modules/.bin/'.length)
  if (!packages[name]) throw new Error(`No native Windows launcher for ${name}`)
  const manifestPath = require.resolve(`${packages[name]}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name]
  if (!entry) throw new Error(`No ${name} entry in ${manifestPath}`)
  return { command: process.execPath, args: [resolve(dirname(manifestPath), entry), ...args] }
}
