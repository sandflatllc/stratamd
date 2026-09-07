import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** Launch overrides must not carry unrelated T3 settings into the managed engine. */
export function engineEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('T3CODE_')))
  const relay = source.T3CODE_CLOUDFLARED_PATH
  if (relay) {
    if (!isAbsolute(relay)) throw new Error(`T3CODE_CLOUDFLARED_PATH must name an absolute executable path: ${relay}`)
    try {
      const path = realpathSync(relay)
      if (!statSync(path).isFile()) throw new Error('Not a file')
      accessSync(path, constants.X_OK)
      env.T3CODE_CLOUDFLARED_PATH = path
    } catch { throw new Error(`The cloudflared override is not an executable file: ${relay}`) }
  }
  return env
}
