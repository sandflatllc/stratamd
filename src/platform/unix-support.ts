import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'

interface SocketWithDescriptor extends Socket {
  _handle?: { fd?: number }
}

interface UnixSupportBinding {
  getPeerUid(descriptor: number): number
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
      if (typeof binding.getPeerUid !== 'function') throw new Error('getPeerUid export is missing')
      loadedBinding = binding as UnixSupportBinding
      return loadedBinding
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`The peer-credentials binding is unavailable. ${failures.join('; ')}`)
}

/** Reads the kernel-supplied peer uid for an accepted Unix-domain socket. */
export function peerUidFromSocket(socket: Socket): number {
  const descriptor = (socket as SocketWithDescriptor)._handle?.fd
  if (!Number.isSafeInteger(descriptor) || descriptor! < 0) {
    throw new Error('The accepted socket descriptor is unavailable')
  }
  const uid = unixSupportBinding().getPeerUid(descriptor!)
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Peer credentials returned an invalid uid')
  return uid
}
