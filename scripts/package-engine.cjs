const { join } = require('node:path')
const { cp, rm, readFile, readlink } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
// Electron Builder filters node_modules inside extraResources. The runtime is a complete independent distribution.
module.exports = async function packageEngine(context) {
  const source = join(context.packager.projectDir, 'build/engine')
  const resources = context.electronPlatformName === 'darwin' ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources') : join(context.appOutDir, 'resources')
  const destination = join(resources, 'engine')
  await rm(destination, { recursive: true, force: true })
  if (process.platform === 'win32') await cp(source, destination, { recursive: true, verbatimSymlinks: true })
  else await promisify(execFile)('/bin/cp', process.platform === 'darwin' ? ['-R', '-P', source, destination] : ['-a', '--reflink=auto', '--', source, destination])
  const manifest = JSON.parse(await readFile(join(destination, 'integrity.json'), 'utf8'))
  for (const [path, expected] of Object.entries(manifest.files)) {
    const file = join(destination, path)
    if (expected.link !== undefined ? await readlink(file) !== expected.link : createHash('sha256').update(await readFile(file)).digest('hex') !== expected.sha256) throw new Error(`Packaged engine integrity failed at ${file}`)
  }
}
