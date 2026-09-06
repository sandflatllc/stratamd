/**
 * What a previewed page may do (from Outcrop's guest policy): pages get no
 * permission but fullscreen, ordinary links join the tab strip, and only an
 * opener-dependent window stays a real popup.
 */
export const SUPPORTED_GUEST_PERMISSIONS = new Set(['fullscreen'])

export function guestPermissionDecision(permission: string): boolean {
  return SUPPORTED_GUEST_PERMISSIONS.has(permission)
}

export interface GuestWindowRequest {
  url: string
  disposition: string
  features: string
  frameName?: string
}

export type GuestWindowDisposition = 'tab' | 'popup' | 'deny'

export function guestWindowDisposition(request: GuestWindowRequest): GuestWindowDisposition {
  if (!/^https?:\/\//i.test(request.url)) return 'deny'
  if (request.disposition === 'new-window'
    || request.features.trim().length > 0
    || (request.frameName !== undefined && request.frameName !== '' && request.frameName !== '_blank')) return 'popup'
  return 'tab'
}
