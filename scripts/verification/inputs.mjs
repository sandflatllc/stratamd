import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const digest = value => createHash('sha256').update(value).digest('hex')
export async function filesIn(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const groups = await Promise.all(entries.filter(entry => !['.vite', '.vite-temp', '.cache'].includes(entry.name)).map(entry => entry.isDirectory()
    ? filesIn(root, join(prefix, entry.name)) : [join(prefix, entry.name)]))
  return groups.flat().sort()
}
export async function fingerprint(root, files) {
  const hash = createHash('sha256')
  // Bound file descriptors and memory even for large dependency trees.
  for (let i = 0; i < files.length; i += 32) {
    const rows = await Promise.all(files.slice(i, i + 32).map(async name => {
      const path = join(root, name), stat = await lstat(path)
      const bytes = stat.isSymbolicLink() ? await readlink(path) : await readFile(path)
      return [name, stat.mode, digest(bytes)]
    }))
    for (const row of rows) hash.update(JSON.stringify(row))
  }
  return hash.digest('hex')
}
export async function inputFiles(root) {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean)
  const existing = []
  for (const name of new Set(names)) {
    if (name === 'node_modules' || name.startsWith('node_modules/')) continue
    try { if (!(await lstat(join(root, name))).isDirectory()) existing.push(name) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const native = 'native/unix-support/build/Release/unix_support.node'
  if (!existing.includes(native)) { await lstat(join(root, native)); existing.push(native) }
  return existing.sort()
}
export async function copyInputs(source, destination, names) {
  for (const name of names) {
    const path = join(source, name), stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      const link = await readlink(path)
      const target = resolve(dirname(path), link)
      if (isAbsolute(link) || relative(source, target).startsWith('..') || target === source) throw new Error(`Input symlink escapes candidate: ${name}`)
    }
    await mkdir(dirname(join(destination, name)), { recursive: true })
    await cp(path, join(destination, name), { verbatimSymlinks: true })
  }
}
export async function copyDependencies(source, destination) {
  const actual = await realpath(source)
  await validateLinks(actual, await filesIn(actual))
  // Preserve pnpm's relative links, executable modes and Electron sandbox mode.
  // Never hardlink: writes in the checkout must not mutate the candidate.
  if (process.platform === 'linux') execFileSync('cp', ['-a', '--reflink=auto', `${actual}/.`, destination])
  else await cp(actual, destination, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  if (process.platform === 'linux') {
    const sandbox = 'electron/dist/chrome-sandbox'
    try {
      const original = await lstat(join(actual, sandbox))
      if (original.uid === 0 && (original.mode & 0o4000)) {
        // A copied setuid helper must still belong to root. CI provisions sudo;
        // a workstation without that permission fails rather than weakening it.
        execFileSync('sudo', ['-n', 'chown', 'root:root', join(destination, sandbox)])
        execFileSync('sudo', ['-n', 'chmod', '4755', join(destination, sandbox)])
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

export async function validateLinks(root, names) {
  for (const name of names) {
    const path = join(root, name)
    if ((await lstat(path)).isSymbolicLink()) {
      const link = await readlink(path)
      const target = resolve(dirname(path), link)
      if (isAbsolute(link) || relative(root, target).startsWith('..')) throw new Error(`Input symlink escapes its identity: ${name}`)
    }
  }
}
