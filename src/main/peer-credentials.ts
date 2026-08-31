import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'

interface SocketWithDescriptor extends Socket {
  _handle?: { fd?: number }
}

interface PeerCredentialBinding {
  getPeerUid(descriptor: number): number
}

const require = createRequire(import.meta.url)
let loadedBinding: PeerCredentialBinding | undefined

function bindingCandidates(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [
    ...(resourcesPath ? [join(resourcesPath, 'peercred.node')] : []),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../native/peercred/build/Release/peercred.node')
  ]
}

function peerCredentialBinding(): PeerCredentialBinding {
  if (loadedBinding) return loadedBinding
  const failures: string[] = []
  for (const candidate of bindingCandidates()) {
    try {
      const binding = require(candidate) as Partial<PeerCredentialBinding>
      if (typeof binding.getPeerUid !== 'function') throw new Error('getPeerUid export is missing')
      loadedBinding = binding as PeerCredentialBinding
      return loadedBinding
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`SO_PEERCRED binding is unavailable. ${failures.join('; ')}`)
}

/** Reads Linux SO_PEERCRED for an accepted Unix-domain socket. */
export function peerUidFromSocket(socket: Socket): number {
  const descriptor = (socket as SocketWithDescriptor)._handle?.fd
  if (!Number.isSafeInteger(descriptor) || descriptor! < 0) {
    throw new Error('The accepted socket descriptor is unavailable')
  }
  const uid = peerCredentialBinding().getPeerUid(descriptor!)
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('SO_PEERCRED returned an invalid uid')
  return uid
}
