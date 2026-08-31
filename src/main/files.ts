import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { AtomicWriteConflictError, atomicWriteFile, sha256 } from './storage'

const execFile = promisify(execFileCallback)
const MAX_GIT_OUTPUT = 64 * 1024 * 1024

export interface DocumentReadBase {
  readonly path: string
  readonly bytes: Buffer
  readonly hash: string
  readonly mode: number
  readonly size: number
}

export type DocumentRead =
  | (DocumentReadBase & { readonly validUtf8: true; readonly text: string })
  | (DocumentReadBase & { readonly validUtf8: false })

export type DiskState = DocumentRead | { readonly path: string; readonly missing: true }

export type SaveDocumentResult =
  | { readonly status: 'saved'; readonly disk: DocumentRead }
  | { readonly status: 'conflict'; readonly disk: DiskState }

export interface GhostSeed {
  readonly content: Buffer
  readonly source: 'head' | 'empty' | 'disk'
  readonly gitRoot?: string
}

export async function resolveDocumentPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path)
    throw error
  }
}

export async function readDocument(path: string): Promise<DocumentRead> {
  const canonical = await resolveDocumentPath(path)
  const [bytes, fileStat] = await Promise.all([readFile(canonical), stat(canonical)])
  let validUtf8 = true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    validUtf8 = false
  }
  const base: DocumentReadBase = {
    path: canonical,
    bytes,
    hash: sha256(bytes),
    mode: fileStat.mode & 0o7777,
    size: fileStat.size,
  }
  return validUtf8 ? { ...base, validUtf8: true, text: bytes.toString('utf8') } : { ...base, validUtf8: false }
}

export async function readDiskState(path: string): Promise<DiskState> {
  try {
    return await readDocument(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: resolve(path), missing: true }
    }
    throw error
  }
}

export async function atomicWriteDocument(
  path: string,
  content: string | Uint8Array,
  fallbackMode = 0o600,
): Promise<DocumentRead> {
  const canonical = await resolveDocumentPath(path)
  await atomicWriteFile(canonical, content, {
    mode: fallbackMode,
    preserveMode: true,
  })
  return readDocument(canonical)
}

/**
 * Re-reads the file immediately before rename. A mismatch is returned to the
 * caller for external-change handling; this function never overwrites it.
 */
export async function saveDocumentWithHashCheck(
  path: string,
  content: string | Uint8Array,
  expectedDiskHash: string | null,
  fallbackMode = 0o600,
): Promise<SaveDocumentResult> {
  const disk = await readDiskState(path)
  const actualHash = 'missing' in disk ? null : disk.hash
  if (actualHash !== expectedDiskHash) return { status: 'conflict', disk }
  const canonical = await resolveDocumentPath(path)
  try {
    await atomicWriteFile(canonical, content, {
      mode: fallbackMode,
      preserveMode: true,
      expectedTargetHash: expectedDiskHash,
    })
    return { status: 'saved', disk: await readDocument(canonical) }
  } catch (error) {
    if (!(error instanceof AtomicWriteConflictError)) throw error
    return { status: 'conflict', disk: await readDiskState(path) }
  }
}

async function runGit(cwd: string, args: readonly string[]): Promise<Buffer> {
  const result = await execFile('git', ['-C', cwd, ...args], {
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  })
  return result.stdout
}

async function findGitRoot(path: string): Promise<string | undefined> {
  try {
    const output = await runGit(dirname(path), ['rev-parse', '--show-toplevel'])
    return output.toString('utf8').trimEnd()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 128 || code === 1) return undefined
    throw error
  }
}

export async function seedGhostFromGit(
  path: string,
  currentContent?: string | Uint8Array,
): Promise<GhostSeed> {
  const canonical = await resolveDocumentPath(path)
  const gitRoot = await findGitRoot(canonical)
  if (!gitRoot) {
    const content = currentContent === undefined ? await readFile(canonical) : Buffer.from(currentContent)
    return { content, source: 'disk' }
  }

  const gitPath = relative(gitRoot, canonical).split(sep).join('/')
  if (gitPath === '..' || gitPath.startsWith('../')) {
    const content = currentContent === undefined ? await readFile(canonical) : Buffer.from(currentContent)
    return { content, source: 'disk' }
  }

  try {
    await runGit(gitRoot, ['cat-file', '-e', `HEAD:${gitPath}`])
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 128 || code === 1) return { content: Buffer.alloc(0), source: 'empty', gitRoot }
    throw error
  }
  // Supplying rev:path lets cat-file identify the pathname and run checkout
  // filters, including working-tree-encoding and line-ending conversion.
  // Once existence is established, filter failures must remain errors.
  const content = await runGit(gitRoot, ['cat-file', '--filters', `HEAD:${gitPath}`])
  return { content, source: 'head', gitRoot }
}

export const seedGhost = seedGhostFromGit

export function isPathInside(path: string, directory: string): boolean {
  const offset = relative(directory, path)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

/** Resolves local image requests and rejects URLs, missing files, and escapes. */
export async function resolveAllowedLocalPath(
  request: string,
  documentPath: string,
  explorerFolders: readonly string[],
): Promise<string | undefined> {
  if (/^[a-z][a-z\d+.-]*:/i.test(request) || request.startsWith('//')) return undefined
  const documentDirectory = dirname(await resolveDocumentPath(documentPath))
  const requestedPath = await realpath(resolve(documentDirectory, request)).catch(() => undefined)
  if (!requestedPath) return undefined
  const allowedDirectories = await Promise.all([
    realpath(documentDirectory).catch(() => documentDirectory),
    ...explorerFolders.map((folder) => realpath(folder).catch(() => resolve(folder))),
  ])
  return allowedDirectories.some((directory) => isPathInside(requestedPath, directory))
    ? requestedPath
    : undefined
}
