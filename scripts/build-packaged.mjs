// Builds the packaged app for the host platform (mac-plan §5): the Linux
// unpacked directory or the macOS .app, without shell-specific conditionals.
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { reservePackageOutput } from './package-output.mjs'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.error(`StrataMD packages for Linux and macOS, not ${process.platform}`)
  process.exit(1)
}

const output = await reservePackageOutput(process.argv[2])
process.env.STRATAMD_PACKAGE_OUTPUT = output
console.log(`Package output: ${output}`)
run(process.execPath, ['scripts/stage-engine.mjs'])
run('./node_modules/.bin/electron-vite', ['build'])
if (process.platform === 'darwin') {
  run(process.execPath, ['scripts/mac-icon.mjs'])
  run('./node_modules/.bin/electron-builder', ['--mac', 'dir', `--config.directories.output=${output}`])
} else {
  run('./node_modules/.bin/electron-builder', ['--linux', 'dir', `--config.directories.output=${output}`])
}

await writeFile('build/latest-package.json', JSON.stringify({ output }) + '\n')
