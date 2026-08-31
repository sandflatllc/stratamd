import { realpath } from 'node:fs/promises'
import { unixSupportBinding } from './unix-support.js'

/**
 * The filesystem path an open descriptor currently refers to, so an open
 * document can follow an external rename. Linux resolves through
 * /proc/self/fd; Darwin asks the kernel with F_GETPATH. Returns null when the
 * platform cannot answer or the file no longer has a path. Callers must still
 * verify the result names the same file (dev/ino) before trusting it: both
 * mechanisms race against further renames.
 */
export async function pathForDescriptor(
  descriptor: number,
  platform: string = process.platform,
): Promise<string | null> {
  if (platform === 'linux') {
    try {
      return await realpath(`/proc/self/fd/${descriptor}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  if (platform === 'darwin') {
    const getPathForFd = unixSupportBinding().getPathForFd
    if (!getPathForFd) return null
    try {
      return getPathForFd(descriptor)
    } catch {
      // A deleted or unlinked file has no path; rename following just pauses.
      return null
    }
  }
  return null
}
