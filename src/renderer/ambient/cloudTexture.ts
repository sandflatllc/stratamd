export interface CloudTexture {
  width: number
  height: number
  main: Uint8Array
  details: Uint8Array
}

let cached: Promise<CloudTexture> | undefined
/** Shared by all panels; the worker exits after transferring its two maps. */
export function cloudTexture(): Promise<CloudTexture> {
  if (!cached) {
    cached = new Promise<CloudTexture>((resolve, reject) => {
      const worker = new Worker(new URL('./cloud.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<CloudTexture>) => { worker.terminate(); resolve(event.data) }
      worker.onerror = () => { worker.terminate(); reject(new Error('Could not generate the nebula texture')) }
    }).catch((error: unknown) => { cached = undefined; throw error })
  }
  return cached
}
