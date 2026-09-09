// Builds the packaged app for the host platform (mac-plan §5): the Linux
// unpacked directory or the macOS .app, without shell-specific conditionals.
import { toolCommand } from './tool-command.mjs'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { reservePackageOutput } from './package-output.mjs'

function run(command, args, options = {}) {
  const invocation = toolCommand(command, args)
  const result = spawnSync(invocation.command, invocation.args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!['linux', 'darwin', 'win32'].includes(process.platform)) {
  console.error(`StrataMD packages for Linux, macOS and Windows, not ${process.platform}`)
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
} else if (process.platform === 'win32') {
  run('./node_modules/.bin/electron-builder', ['--win', 'nsis', '--x64', '--publish', 'never', `--config.directories.output=${output}`], builderOptions)
} else {
  run('./node_modules/.bin/electron-builder', ['--linux', 'dir', `--config.directories.output=${output}`], builderOptions)
}

await writeFile('build/latest-package.json', JSON.stringify({ output }) + '\n')
