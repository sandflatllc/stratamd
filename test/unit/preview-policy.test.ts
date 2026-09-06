import { describe, expect, it } from 'vitest'
import { guestPermissionDecision, guestWindowDisposition } from '../../src/main/preview/guest-policy'
import { MAX_SCREENSHOT_PIXELS, screenshotPlan } from '../../src/main/preview/capture-budget'

/** Outcrop's guest policy and capture budget tests, ported with the code (docs/plans/open/visual-review, section 3). */
describe('guest policy', () => {
  it('gives a page no permission but fullscreen', () => {
    expect(guestPermissionDecision('fullscreen')).toBe(true)
    expect(guestPermissionDecision('notifications')).toBe(false)
    expect(guestPermissionDecision('media')).toBe(false)
  })

  it('distinguishes opener-dependent popups from ordinary new-tab links and refuses anything but http', () => {
    expect(guestWindowDisposition({ url: 'http://localhost/popup', disposition: 'foreground-tab', features: '', frameName: 'auth' })).toBe('popup')
    expect(guestWindowDisposition({ url: 'http://localhost/page', disposition: 'foreground-tab', features: '' })).toBe('tab')
    expect(guestWindowDisposition({ url: 'file:///etc/passwd', disposition: 'new-window', features: 'popup' })).toBe('deny')
  })
})

describe('screenshot memory budget', () => {
  it('keeps complete captures at or below the 256 MiB decoded ceiling', () => {
    const plan = screenshotPlan(8000, 8000, 1)
    expect(plan.complete).toBe(true)
    expect(plan.decodedBytes).toBe(MAX_SCREENSHOT_PIXELS * 4)
  })

  it('requires an honest viewport fallback above the pixel or dimension limit', () => {
    expect(screenshotPlan(8001, 8000, 1).complete).toBe(false)
    expect(screenshotPlan(1000, 17_000, 1).complete).toBe(false)
  })
})
