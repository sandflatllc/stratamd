import { rename } from 'node:fs/promises'
import { resolve, toNamespacedPath } from 'node:path'
import { unixSupportBinding } from './unix-support'

/** Windows' ordinary rename refuses replacement while the destination is open. */
export async function atomicRename(source: string, target: string): Promise<void> {
  if (process.platform !== 'win32') return rename(source, target)
  try {
    const replace = unixSupportBinding().replaceFile
    if (!replace) throw new Error('The native atomic rename helper is unavailable')
    replace(toNamespacedPath(resolve(source)), toNamespacedPath(resolve(target)))
  } catch (error) {
    throw Object.assign(new Error(`Could not replace ${target} with ${source}: ${String(error)}`, { cause: error }), {
      code: (error as NodeJS.ErrnoException).code,
    })
  }
}
