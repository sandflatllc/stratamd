/**
 * The two platforms StrataMD runs on. Platform checks live in src/platform
 * modules; feature code stays platform-neutral (docs/plans/open/mac-plan.md §3).
 */
export type SupportedPlatform = 'linux' | 'darwin'

export function isSupportedPlatform(platform: string): platform is SupportedPlatform {
  return platform === 'linux' || platform === 'darwin'
}

export function isDarwin(platform: string = process.platform): boolean {
  return platform === 'darwin'
}

export function assertSupportedPlatform(platform: string = process.platform): SupportedPlatform {
  if (!isSupportedPlatform(platform)) {
    throw new Error(`StrataMD supports Linux and macOS, not ${platform}`)
  }
  return platform
}
