import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface UnixSupportBinding {
  /** Darwin only: Linux resolves descriptors through /proc instead. */
  getPathForFd?(descriptor: number): string
}

const require = createRequire(import.meta.url)
let loadedBinding: UnixSupportBinding | undefined

function bindingCandidates(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [
    ...(resourcesPath ? [join(resourcesPath, 'unix-support.node')] : []),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../native/unix-support/build/Release/unix_support.node')
  ]
}

export function unixSupportBinding(): UnixSupportBinding {
  if (loadedBinding) return loadedBinding
  const failures: string[] = []
  for (const candidate of bindingCandidates()) {
    try {
      const binding = require(candidate) as Partial<UnixSupportBinding>
      loadedBinding = binding as UnixSupportBinding
      return loadedBinding
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`The descriptor-path binding is unavailable. ${failures.join('; ')}`)
}
