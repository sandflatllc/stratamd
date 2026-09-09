/**
 * The platforms StrataMD runs on. Platform checks live in src/platform
 * modules; feature code stays platform-neutral (docs/plans/open/mac-plan.md §3).
 */
export type SupportedPlatform = 'linux' | 'darwin' | 'win32'

export function isSupportedPlatform(platform: string): platform is SupportedPlatform {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32'
}

export function isDarwin(platform: string = process.platform): boolean {
  return platform === 'darwin'
}

export function assertSupportedPlatform(platform: string = process.platform): SupportedPlatform {
  if (!isSupportedPlatform(platform)) {
    throw new Error(`StrataMD supports Linux, macOS and Windows, not ${platform}`)
  }
  return platform
}

export function isWindows(platform: string = process.platform): boolean {
  return platform === 'win32'
}
