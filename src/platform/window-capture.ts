/** Capture policy is pure so the CLI can load platform modules without Electron. */
export function windowCapturePlatform(platform: string = process.platform, waylandDisplay: string | undefined = process.env.WAYLAND_DISPLAY) {
  const supported = platform === 'linux' || platform === 'darwin' || platform === 'win32' ? platform : 'unsupported'
  return {
    platform: supported as 'linux' | 'darwin' | 'win32' | 'unsupported',
    picker: platform === 'linux' && !!waylandDisplay ? 'system' as const : 'windows' as const,
    macPermissions: platform === 'darwin',
    windowIdentity: platform === 'darwin' ? 'core-graphics' as const : platform === 'linux' && !waylandDisplay ? 'x11' as const : null,
    constrainToWindowBounds: platform === 'linux',
    chromiumFeatures: platform === 'linux' ? ['GlobalShortcutsPortal', 'WebRTCPipeWireCapturer'] : [],
  }
}
