import { spawn } from 'node:child_process'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { GhostStore } from './storage'
import { readDocument } from './files'

export interface ExplorerRoot {
  readonly path: string
  readonly configuredPath: string
  readonly missing: boolean
}

export interface ExplorerFile {
  /** Canonical identity used by sessions and the ghost store. */
  readonly path: string
  /** Path reached through the configured explorer folder. */
  readonly displayPath: string
  readonly root: string
  readonly relativePath: string
  readonly missing: boolean
}

export interface ExplorerScanResult {
  readonly roots: readonly ExplorerRoot[]
  readonly files: readonly ExplorerFile[]
}

export interface ExplorerScanOptions {
  readonly knownDocuments?: readonly { readonly realpath: string }[]
  readonly includeMissing?: boolean
}

export interface ExplorerSeedResult extends ExplorerScanResult {
  readonly seeded: readonly string[]
  readonly skippedInvalidUtf8: readonly string[]
}

export interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

interface CandidateFile {
  readonly path: string
  readonly displayPath: string
  readonly root: string
  readonly relativePath: string
}

function isMarkdownPath(path: string): boolean {
  const extension = extname(path)
  return extension === '.md' || extension === '.markdown'
}

function isWithin(path: string, root: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`))
}

async function gitRootFor(path: string): Promise<string | undefined> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolvePromise(undefined)
      else reject(error)
    })
    child.on('close', (code) => {
      if (code !== 0) resolvePromise(undefined)
      else resolvePromise(Buffer.concat(chunks).toString('utf8').trimEnd())
    })
  })
}

async function ignoredPaths(gitRoot: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', gitRoot, 'check-ignore', '--stdin', '-z'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        reject(new Error(`git check-ignore exited with status ${String(code)}`))
        return
      }
      const output = Buffer.concat(chunks).toString('utf8')
      resolvePromise(new Set(output.split('\0').filter(Boolean)))
    })
    child.stdin.end(`${paths.join('\0')}\0`)
  })
}

async function walkRoot(root: string, seenDirectories: Set<string>): Promise<CandidateFile[]> {
  const files: CandidateFile[] = []

  async function walk(logicalDirectory: string): Promise<void> {
    let canonicalDirectory: string
    try {
      canonicalDirectory = await realpath(logicalDirectory)
      const directoryStat = await stat(canonicalDirectory)
      if (!directoryStat.isDirectory()) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (seenDirectories.has(canonicalDirectory)) return
    seenDirectories.add(canonicalDirectory)

    const entries = await readdir(logicalDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const displayPath = resolve(logicalDirectory, entry.name)
      let entryStat
      try {
        entryStat = entry.isSymbolicLink() ? await stat(displayPath) : await lstat(displayPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (entryStat.isDirectory()) {
        await walk(displayPath)
        continue
      }
      if (!entryStat.isFile() || !isMarkdownPath(entry.name)) continue
      const path = await realpath(displayPath)
      files.push({ path, displayPath, root, relativePath: relative(root, displayPath) })
    }
  }

  await walk(root)
  return files
}

async function removeGitIgnored(candidates: readonly CandidateFile[]): Promise<CandidateFile[]> {
  const groups = new Map<string, CandidateFile[]>()
  const outsideGit: CandidateFile[] = []
  const rootCache = new Map<string, Promise<string | undefined>>()

  for (const candidate of candidates) {
    const searchDirectory = dirname(candidate.displayPath)
    let rootPromise = rootCache.get(searchDirectory)
    if (!rootPromise) {
      rootPromise = gitRootFor(searchDirectory)
      rootCache.set(searchDirectory, rootPromise)
    }
    const gitRoot = await rootPromise
    if (!gitRoot || !isWithin(candidate.displayPath, gitRoot)) {
      outsideGit.push(candidate)
      continue
    }
    const group = groups.get(gitRoot) ?? []
    group.push(candidate)
    groups.set(gitRoot, group)
  }

  const visible = [...outsideGit]
  for (const [gitRoot, group] of groups) {
    const relativePaths = group.map((candidate) => relative(gitRoot, candidate.displayPath).split(sep).join('/'))
    const ignored = await ignoredPaths(gitRoot, relativePaths)
    group.forEach((candidate, index) => {
      if (!ignored.has(relativePaths[index]!)) visible.push(candidate)
    })
  }
  return visible
}

export async function scanExplorer(
  folders: readonly string[],
  options: ExplorerScanOptions = {},
): Promise<ExplorerScanResult> {
  const roots: ExplorerRoot[] = []
  const canonicalRoots: string[] = []
  const rootIdentity = new Set<string>()
  for (const configuredPath of folders) {
    const configured = resolve(configuredPath)
    try {
      const path = await realpath(configured)
      const rootStat = await stat(path)
      if (!rootStat.isDirectory()) {
        roots.push({ path: configured, configuredPath, missing: true })
      } else if (!rootIdentity.has(path)) {
        rootIdentity.add(path)
        roots.push({ path, configuredPath, missing: false })
        canonicalRoots.push(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      roots.push({ path: configured, configuredPath, missing: true })
    }
  }

  // Sharing this set detects both symlink cycles and overlapping roots.
  const seenDirectories = new Set<string>()
  const candidates: CandidateFile[] = []
  for (const root of canonicalRoots) candidates.push(...await walkRoot(root, seenDirectories))
  const visible = await removeGitIgnored(candidates)

  const filesByIdentity = new Map<string, ExplorerFile>()
  for (const file of visible) {
    const existing = filesByIdentity.get(file.path)
    if (existing) {
      const existingIsDirect = existing.displayPath === existing.path
      const candidateIsDirect = file.displayPath === file.path
      const existingDepth = existing.relativePath.split(sep).length
      const candidateDepth = file.relativePath.split(sep).length
      if (existingIsDirect && !candidateIsDirect) continue
      if (existingIsDirect === candidateIsDirect && existingDepth <= candidateDepth) continue
    }
    filesByIdentity.set(file.path, { ...file, missing: false })
  }

  if (options.includeMissing !== false) {
    for (const document of options.knownDocuments ?? []) {
      if (filesByIdentity.has(document.realpath)) continue
      if (!canonicalRoots.some((root) => isWithin(document.realpath, root))) continue
      try {
        await lstat(document.realpath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const root = canonicalRoots.find((candidateRoot) => isWithin(document.realpath, candidateRoot))!
        filesByIdentity.set(document.realpath, {
          path: document.realpath,
          displayPath: document.realpath,
          root,
          relativePath: relative(root, document.realpath),
          missing: true,
        })
      }
    }
  }

  const files = [...filesByIdentity.values()].sort((left, right) => {
    const rootOrder = canonicalRoots.indexOf(left.root) - canonicalRoots.indexOf(right.root)
    return rootOrder || left.relativePath.localeCompare(right.relativePath)
  })
  return { roots, files }
}

export const scanExplorerFolders = scanExplorer

/**
 * Locates one already-open Markdown file by filesystem identity. Unlike an
 * explorer refresh, this intentionally does not apply .gitignore: moving an
 * open session into an ignored path must not detach it. Multiple hard links
 * are ambiguous, so this returns null instead of guessing.
 */
export async function findMarkdownByIdentity(
  folders: readonly string[],
  identity: FileIdentity,
  excludedPaths: readonly string[] = [],
): Promise<string | null> {
  const seenDirectories = new Set<string>()
  const candidates: CandidateFile[] = []
  const roots = new Set<string>()
  for (const folder of folders) {
    try {
      const canonical = await realpath(folder)
      if ((await stat(canonical)).isDirectory()) roots.add(canonical)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const root of roots) candidates.push(...await walkRoot(root, seenDirectories))

  const excluded = new Set(excludedPaths.map((path) => resolve(path)))
  const matches = new Set<string>()
  for (const candidate of candidates) {
    if (excluded.has(candidate.path)) continue
    const candidateStat = await stat(candidate.path, { bigint: true }).catch(() => null)
    if (candidateStat?.dev === identity.dev && candidateStat.ino === identity.ino) {
      matches.add(candidate.path)
      if (matches.size > 1) return null
    }
  }
  return matches.values().next().value ?? null
}

export async function scanAndSeedExplorer(
  folders: readonly string[],
  store: GhostStore,
): Promise<ExplorerSeedResult> {
  const knownDocuments = await store.listDocuments()
  const scan = await scanExplorer(folders, { knownDocuments })
  const seeded: string[] = []
  const skippedInvalidUtf8: string[] = []

  for (const file of scan.files) {
    if (file.missing || await store.hasDocument(file.path)) continue
    const current = await readDocument(file.path)
    if (!current.validUtf8) {
      skippedInvalidUtf8.push(file.path)
      continue
    }
    await store.createDocument(file.path, current.bytes)
    seeded.push(file.path)
  }
  return { ...scan, seeded, skippedInvalidUtf8 }
}

export const scanAndSeed = scanAndSeedExplorer

export function markdownFileName(path: string): string | undefined {
  return isMarkdownPath(path) ? basename(path) : undefined
}
