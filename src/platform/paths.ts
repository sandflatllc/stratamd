import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Every filesystem location StrataMD derives, resolved in one place for the
 * CLI and the main process (docs/plans/open/mac-plan.md §4.1). Pure: callers
 * inject platform, environment, and home in tests; nothing here may import
 * Electron, touch disk, or read state beyond the provided context.
 *
 * Explicit XDG values are honored on both platforms so agents and the test
 * harness keep one environment shape; the macOS fallbacks follow Mac
 * conventions for app-owned data. Config deliberately stays under ~/.config on
 * macOS because agents edit themes there and existing instructions name it.
 */
export interface PathEnvironment {
  readonly XDG_CONFIG_HOME?: string
  readonly XDG_DATA_HOME?: string
  readonly HOME?: string
}

export interface PathContext {
  readonly platform?: string
  readonly env?: PathEnvironment
  readonly home?: string
}

function contextHome(context: PathContext): string {
  return context.home ?? context.env?.HOME ?? process.env.HOME ?? homedir()
}

function contextEnv(context: PathContext): PathEnvironment {
  return context.env ?? process.env
}

function contextPlatform(context: PathContext): string {
  return context.platform ?? process.platform
}

export function getConfigDirectory(context: PathContext = {}): string {
  const env = contextEnv(context)
  const base = env.XDG_CONFIG_HOME || join(contextHome(context), '.config')
  return join(base, 'stratamd')
}

export function getDataDirectory(context: PathContext = {}): string {
  const env = contextEnv(context)
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'stratamd')
  const home = contextHome(context)
  if (contextPlatform(context) === 'darwin') {
    return join(home, 'Library', 'Application Support', 'StrataMD')
  }
  return join(home, '.local', 'share', 'stratamd')
}

/** The managed PATH entry installed by `stratamd setup` on both platforms. */
export function getCliLinkPath(home: string): string {
  return join(home, '.local', 'bin', 'stratamd')
}
