import { applyEngineBackport } from './engine-backport.mjs'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rm, readdir, lstat, readlink, copyFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = JSON.parse(await readFile(join(root, 'packaging/engine/runtime-source.json'), 'utf8'))
const linuxToolchain = process.env.STRATAMD_LINUX_TOOLCHAIN
  ? source.linuxToolchainProfiles?.[process.env.STRATAMD_LINUX_TOOLCHAIN]
  : source.linuxToolchain
if (process.platform === 'linux' && !linuxToolchain) throw new Error(`Unknown pinned Linux toolchain: ${process.env.STRATAMD_LINUX_TOOLCHAIN}`)
const target = `${process.platform}-${process.arch}`
if (!source.nodeArchives[target]) throw new Error(`No bundled engine for ${target}. Build Linux x64, macOS x64 or macOS arm64 on that native host.`)
const destination = resolve(process.argv[2] || join(root, 'build/engine'))
const cache = join(root, 'build/engine-downloads')
await mkdir(cache, { recursive: true })
const name = `node-v${source.node}-${target}.tar.gz`, archive = join(cache, name)
try { await lstat(archive) } catch {
  const response = await fetch(`https://nodejs.org/dist/v${source.node}/${name}`)
  if (!response.ok) throw new Error(`Node download returned ${response.status}`)
  await writeFile(archive, Buffer.from(await response.arrayBuffer()))
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (hash(await readFile(archive)) !== source.nodeArchives[target]) throw new Error(`Node checksum failed for ${archive}`)
function run(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${executable} exited ${result.status}`)
}
await rm(destination, { recursive: true, force: true })
await mkdir(join(destination, 'node'), { recursive: true })
run('tar', ['-xzf', archive, '--strip-components=1', '-C', join(destination, 'node')], root)
for (const file of ['package.json', 'package-lock.json']) await copyFile(join(root, 'packaging/engine', file), join(destination, file))
const executable = join(destination, 'node/bin/node')
const env = { ...process.env, PATH: `${join(destination, 'node/bin')}:${process.env.PATH || ''}`, npm_config_nodedir: join(destination, 'node') }
if (process.platform === 'linux') {
  const toolchain = linuxToolchain
  const version = (tool, args) => {
    const result = spawnSync(tool, args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`Required native tool is unavailable: ${tool}`)
    return result.stdout.trim()
  }
  for (const [tool, args, expected] of [[toolchain.cc, ['-dumpfullversion'], toolchain.gcc], [toolchain.cxx, ['-dumpfullversion'], toolchain.gcc], ['python3', ['--version'], `Python ${toolchain.python}`], ['make', ['--version'], `GNU Make ${toolchain.make}`]]) {
    if (version(tool, args).split('\n')[0] !== expected) throw new Error(`Native staging requires ${tool} ${expected}; use the pinned Linux toolchain.`)
  }
  Object.assign(env, { CC: toolchain.cc, CXX: toolchain.cxx, PYTHON: 'python3', PYTHONDONTWRITEBYTECODE: '1', SOURCE_DATE_EPOCH: toolchain.sourceDateEpoch,
    CFLAGS: `-ffile-prefix-map=${destination}=. -fdebug-prefix-map=${destination}=.`, CXXFLAGS: `-ffile-prefix-map=${destination}=. -fdebug-prefix-map=${destination}=.`,
    npm_config_build_from_source: 'true' })
}

run(executable, [join(destination, 'node/lib/node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(cache, 'npm')], destination, env)
const backport = await applyEngineBackport(root, destination, source)
// Build the PTY with the node-gyp version bundled in the authenticated Node archive.
// Other native dependencies carry lockfile-authenticated platform packages.
await rm(join(destination, 'node_modules/node-pty/prebuilds'), { recursive: true, force: true })
run(executable, [join(destination, 'node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js'), 'rebuild', `--nodedir=${join(destination, 'node')}`], join(destination, 'node_modules/node-pty'), env)
run(executable, ['scripts/post-install.js'], join(destination, 'node_modules/node-pty'), env)
run(executable, ['--input-type=module', '-e', "import {createRequire} from 'node:module';const r=createRequire(process.cwd()+'/package.json');r('node-pty');r('msgpackr-extract');await import('@ff-labs/fff-node');"], destination, env)
// node-gyp emits machine paths in Makefiles, config.gypi and object files.
// Keep only runtime native modules and the PTY spawn helper from build outputs.
const nativeBuild = join(destination, 'node_modules/node-pty/build')
try {
  for (const entry of await readdir(nativeBuild)) if (entry !== 'Release') await rm(join(nativeBuild, entry), { recursive: true, force: true })
  for (const entry of await readdir(join(nativeBuild, 'Release'))) if (!entry.endsWith('.node') && entry !== 'spawn-helper') await rm(join(nativeBuild, 'Release', entry), { recursive: true, force: true })
} catch (error) { if (error.code !== 'ENOENT') throw error }
for (const entry of await readdir(join(destination, 'node_modules/node-pty/node-addon-api'))) if (entry.endsWith('.target.mk')) await rm(join(destination, 'node_modules/node-pty/node-addon-api', entry))
await writeFile(join(destination, 'build-provenance.json'), JSON.stringify({ t3SourceCommit: source.t3SourceCommit, backport, nodeArchiveSHA256: source.nodeArchives[target], headers: 'node/include/node from the verified Node archive', toolchain: process.platform === 'linux' ? linuxToolchain : 'native macOS build; reproducibility unverified' }, null, 2) + '\n')
const lock = JSON.parse(await readFile(join(destination, 'package-lock.json'), 'utf8'))
const inventory = []
const notices = [`Bundled Node ${source.node} and official t3 ${source.t3}, with MIT upstream replay backport ${source.backport.commit}.`, 'These packages retain their own licenses. No hosted service access is granted by redistribution.', await readFile(join(destination, 'node/LICENSE'), 'utf8')]
const packages = { ...lock.packages }
async function npmPackages(path) {
  const manifest = JSON.parse(await readFile(join(destination, path, 'package.json'), 'utf8'))
  packages[path] = { version: manifest.version, license: manifest.license }
  let children
  try { children = await readdir(join(destination, path, 'node_modules'), { withFileTypes: true }) } catch { return }
  for (const child of children) {
    if (!child.isDirectory() || child.name.startsWith('.')) continue
    const next = join(path, 'node_modules', child.name)
    if (child.name.startsWith('@')) for (const scoped of await readdir(join(destination, next))) await npmPackages(join(next, scoped))
    else await npmPackages(next)
  }
}
await npmPackages('node/lib/node_modules/npm')
for (const [path, metadata] of Object.entries(packages)) {
  if (!path) continue
  try { await lstat(join(destination, path, 'package.json')) } catch { continue }
  const manifest = JSON.parse(await readFile(join(destination, path, 'package.json'), 'utf8'))
  const licenses = (await readdir(join(destination, path))).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file) || file === 'README.md' && String(manifest.license).includes('README'))
  inventory.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? metadata.license ?? 'UNDECLARED', integrity: metadata.integrity, path, licenses })
  notices.push(`\n\n## ${manifest.name}@${manifest.version}\nLicense: ${JSON.stringify(manifest.license ?? metadata.license ?? 'UNDECLARED')}\n`)
  for (const file of licenses) if ((await lstat(join(destination, path, file))).isFile()) notices.push(await readFile(join(destination, path, file), 'utf8'))
}
await writeFile(join(destination, 'dependency-inventory.json'), JSON.stringify({ t3SourceCommit: source.t3SourceCommit, backport, node: source.node, nodeArchiveSHA256: source.nodeArchives[target], packages: inventory }, null, 2) + '\n')
await writeFile(join(destination, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'))
await writeFile(join(destination, 'runtime.json'), JSON.stringify({ version: `t3-${source.t3}-node-${source.node}-${target}-${source.runtimeRevision}`, nodeVersion: source.node, platform: process.platform, arch: process.arch, executable: 'node/bin/node', entry: 'node_modules/t3/dist/bin.mjs', integrity: 'integrity.json' }, null, 2) + '\n')
const files = {}
async function visit(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), key = relative(destination, path)
    if (entry.isDirectory()) await visit(path)
    else if (entry.isSymbolicLink()) files[key] = { link: await readlink(path) }
    else if (entry.isFile()) files[key] = { sha256: hash(await readFile(path)) }
  }
}
await visit(destination)
await writeFile(join(destination, 'integrity.json'), JSON.stringify({ files }, null, 2) + '\n')
console.log(`Staged ${target} runtime at ${destination}; ${inventory.length} dependency records.`)
