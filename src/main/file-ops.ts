import { access, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

// Explorer file operations (usability round 2 §5.10): create, rename, trash,
// reveal, and an open-file dialog. They live beside the IPC layer rather than
// in the application, which keeps owning sessions; anything touching an open
// document is refused here with a plain message.

/** The pieces of Electron these operations need; tests inject fakes. */
export interface FileOpsShell {
  trashItem(path: string): Promise<void>
  showItemInFolder(path: string): void
}

export interface FileOpsDialog {
  showOpenDialog(options: {
    properties: Array<'openFile'>
    filters: Array<{ name: string; extensions: string[] }>
  }): Promise<{ canceled: boolean; filePaths: string[] }>
}

export interface FileOpsOptions {
  shell: FileOpsShell
  dialog: FileOpsDialog
  /** Paths of documents currently open as tabs; rename and trash refuse these. */
  openPaths(): Promise<readonly string[]>
}

export interface FileOps {
  createFile(directory: string, name?: string): Promise<string>
  renameFile(path: string, name: string): Promise<string>
  trashFile(path: string): Promise<void>
  revealFile(path: string): Promise<void>
  chooseFile(): Promise<string | null>
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** A file name typed by the user, with the markdown extension added when it has none. */
export function normalizeMarkdownName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Type a name for the file.')
  if (trimmed.includes('/') || trimmed.includes('\\')) throw new Error('A file name cannot contain slashes.')
  if (trimmed === '.' || trimmed === '..') throw new Error('That is not a usable file name.')
  const extension = extname(trimmed).toLowerCase()
  return extension === '.md' || extension === '.markdown' ? trimmed : `${trimmed}.md`
}

/** untitled.md, untitled-2.md, untitled-3.md … the first that does not exist. */
export async function untitledPath(directory: string, taken: (path: string) => Promise<boolean> = exists): Promise<string> {
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidate = join(directory, attempt === 1 ? 'untitled.md' : `untitled-${attempt}.md`)
    if (!(await taken(candidate))) return candidate
  }
  throw new Error('Could not find a free name for the new file.')
}

export function createFileOps(options: FileOpsOptions): FileOps {
  const refuseWhenOpen = async (path: string, verb: string): Promise<void> => {
    const open = await options.openPaths()
    if (open.includes(resolve(path))) throw new Error(`Close the tab for ${basename(path)} before you ${verb} it.`)
  }
  return {
    async createFile(directory, name) {
      const target = name === undefined
        ? await untitledPath(resolve(directory))
        : join(resolve(directory), normalizeMarkdownName(name))
      if (await exists(target)) throw new Error(`${basename(target)} already exists here.`)
      // 'wx' fails instead of truncating if the file appears between the check and the write.
      await writeFile(target, '', { flag: 'wx' })
      return target
    },
    async renameFile(path, name) {
      const source = resolve(path)
      await refuseWhenOpen(source, 'rename')
      const target = join(dirname(source), normalizeMarkdownName(name))
      if (target === source) return source
      if (await exists(target)) throw new Error(`${basename(target)} already exists here.`)
      await rename(source, target)
      return target
    },
    async trashFile(path) {
      const source = resolve(path)
      await refuseWhenOpen(source, 'delete')
      await options.shell.trashItem(source)
    },
    async revealFile(path) {
      options.shell.showItemInFolder(resolve(path))
    },
    async chooseFile() {
      const result = await options.dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
  }
}

/** The production wiring; Electron is imported lazily so this module also loads under vitest. */
export async function electronFileOps(openPaths: () => Promise<readonly string[]>): Promise<FileOps> {
  const { dialog, shell } = await import('electron')
  return createFileOps({ shell, dialog, openPaths })
}
