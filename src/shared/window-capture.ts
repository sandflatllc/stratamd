/** Local captures remain staged until the owner's ordinary Send. */
export interface WindowCaptureContext {
  selection: 'window' | 'system-source'
  title: string
  app: string | null
  windowId: string | null
  processId: number | null
  accessibilityText: string | null
  textStatus: 'available' | 'unavailable' | 'permission-required'
}
export interface CaptureStatus {
  shortcut: 'disabled' | 'registered' | 'conflict'
  platform: 'linux' | 'darwin' | 'unsupported'
  picker: 'system' | 'windows'
  screenPermission: string
  accessibilityPermission: boolean
}
export interface CaptureSource { token: string; name: string; thumbnail: string }
export interface CapturedWindow { id: string; name: string; width: number; height: number; context: WindowCaptureContext }
export type CaptureRequest = { action: 'status' | 'choose' | 'screen-settings' | 'accessibility-settings' } | { action: 'capture'; token: string; projectId: string; threadId: string; engine: string | null }
export type CaptureResponse = { status: CaptureStatus } | { sources: CaptureSource[] } | { capture: CapturedWindow } | { cancelled: true }

export function windowCaptureNotice(context: WindowCaptureContext): string | null {
  if (context.accessibilityText) return null
  if (context.textStatus === 'permission-required') return 'Screenshot only. Allow Accessibility in System Settings to include readable text.'
  if (context.selection === 'system-source') return 'Screenshot only. The system picker did not provide readable window text.'
  return 'Screenshot only. This app did not provide readable text.'
}
