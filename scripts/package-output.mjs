import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { dirname, join, resolve, parse } from 'node:path'

// Refuse reuse, including aliases into an existing application. Reserve the new
// directory atomically before staging starts, so two builds cannot share it.
export async function reservePackageOutput(requested, root = resolve('release')) {
  const parent = resolve(requested ? dirname(requested) : root)
  let ancestor = parent
  while (true) {
    try {
      const actual = await realpath(ancestor)
      for (let path = actual; path !== parse(path).root; path = dirname(path)) {
        if (path.endsWith('.app')) throw new Error(`Package output cannot be inside an application: ${path}`)
        for (const marker of ['resources/app.asar', 'Contents/Resources/app.asar', 'stratamd-app', 'runtime.json']) {
          try { await lstat(join(path, marker)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
          throw new Error(`Package output cannot be inside an installation or runtime: ${path}`)
        }
      }
      break
    } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor) }
  }
  await mkdir(parent, { recursive: true })
  const canonicalParent = await realpath(parent)
  if (!requested) return mkdtemp(join(canonicalParent, 'build-'))
  const destination = join(canonicalParent, parse(resolve(requested)).base)
  try { await mkdir(destination) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Package output already exists; choose a new directory: ${destination}`)
    throw error
  }
  return destination
}
