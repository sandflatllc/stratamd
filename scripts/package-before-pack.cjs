// Also guard direct electron-builder invocations, before it changes app output.
module.exports = async function beforePack(context) {
  const { realpath, readdir } = require('node:fs/promises')
  const { resolve } = require('node:path')
  const expected = process.env.STRATAMD_PACKAGE_OUTPUT
  const output = resolve(context.packager.projectDir, context.packager.config.directories.output)
  if (!expected || await realpath(output) !== expected || (await readdir(output)).length !== 0) {
    throw new Error('Build packages with scripts/build-packaged.mjs and a new output directory.')
  }
}
