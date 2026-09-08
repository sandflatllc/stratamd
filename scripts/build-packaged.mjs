// Builds the packaged app for the host platform (mac-plan §5): the Linux
// unpacked directory or the macOS .app, without shell-specific conditionals.
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { reservePackageOutput } from './package-output.mjs'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
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
// electron-builder asks pnpm for the workspace root before packaging. pnpm 11's
// pre-command dependency check would repair a relocated verification tree.
const builderOptions = {
  env: {
    ...process.env,
    pnpm_config_verify_deps_before_run: 'false'
  }
}
if (process.platform === 'darwin') {
  run(process.execPath, ['scripts/mac-icon.mjs'])
  run('./node_modules/.bin/electron-builder', ['--mac', 'dir', `--config.directories.output=${output}`], builderOptions)
} else {
  run('./node_modules/.bin/electron-builder', ['--linux', 'dir', `--config.directories.output=${output}`], builderOptions)
}

await writeFile('build/latest-package.json', JSON.stringify({ output }) + '\n')
