// Builds the packaged app for the host platform (mac-plan §5): the Linux
// unpacked directory or the macOS .app, without shell-specific conditionals.
import { spawnSync } from 'node:child_process'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.error(`StrataMD packages for Linux and macOS, not ${process.platform}`)
  process.exit(1)
}

run('pnpm', ['build'])
if (process.platform === 'darwin') {
  run('node', ['scripts/mac-icon.mjs'])
  run('npx', ['electron-builder', '--mac', 'dir'])
} else {
  run('npx', ['electron-builder', '--linux', 'dir'])
}
