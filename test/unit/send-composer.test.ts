import { describe, expect, it } from 'vitest'
import type { SendPreviewRequest } from '../../src/shared/contracts'
import { IDLE_SEND, nextSendState } from '../../src/renderer/components/SendComposer'

const request: SendPreviewRequest = { recipients: ['agent-a'], note: 'Ready for review', includeExternal: true }

describe('send composer commitment', () => {
  // docs/plans/open/performance-plan.md, "Send trace result": one run left the dialog open for
  // 30 seconds with no delivery and the button still reading `Send`, because toggling
  // the external option restarted the preview and disabled the button mid-click.
  it('holds a click made while a preview is still in flight and sends it once the preview settles', () => {
    const queued = nextSendState(IDLE_SEND, { type: 'submit', request })
    expect(queued.phase).toBe('queued')
    expect(queued.request).toBe(request)

    expect(nextSendState(queued, { type: 'submit', request })).toBe(queued)

    const sending = nextSendState(queued, { type: 'preview-settled' })
    expect(sending.phase).toBe('sending')
    expect(sending.request).toBe(request)
    expect(nextSendState(sending, { type: 'preview-settled' })).toBe(sending)
  })

  it('returns the composer to a usable state and shows the reason when the send rejects', () => {
    const sending = nextSendState(nextSendState(IDLE_SEND, { type: 'submit', request }), { type: 'preview-settled' })

    const failed = nextSendState(sending, { type: 'send-failed', error: new Error('The delivery queue is locked.') })
    expect(failed.phase).toBe('idle')
    expect(failed.request).toBeNull()
    expect(failed.error).toBe('The delivery queue is locked.')
    expect(nextSendState(sending, { type: 'send-failed', error: 'socket closed' }).error).toBe('The send failed.')

    const retry = nextSendState(failed, { type: 'submit', request })
    expect(retry.phase).toBe('queued')
    expect(retry.error).toBe('')
  })

  it('reports a failed preview without dropping the click waiting on it', () => {
    const queued = nextSendState(IDLE_SEND, { type: 'submit', request })

    const reported = nextSendState(queued, { type: 'preview-failed', error: new Error('Preview unavailable.') })
    expect(reported.phase).toBe('queued')
    expect(reported.error).toBe('Preview unavailable.')
    expect(nextSendState(reported, { type: 'preview-settled' }).phase).toBe('sending')
  })

  it('never yields a second dispatchable state for one committed send', () => {
    // The dispatch effect keys "this delivery already started" on state identity, so a
    // recipient toggle whose preview rejects mid-send must not mint a new sending state.
    const sending = nextSendState(nextSendState(IDLE_SEND, { type: 'submit', request }), { type: 'preview-settled' })
    expect(nextSendState(sending, { type: 'preview-failed', error: new Error('Preview unavailable.') })).toBe(sending)
  })
})
