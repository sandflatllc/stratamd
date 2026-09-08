/** Focus after a held-context popup has unmounted and returned its old focus. */
export function focusConversationComposer(scope: ParentNode | null = document): void {
  requestAnimationFrame(() => {
    const inputs = scope?.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message conversation"]') ?? []
    Array.from(inputs).find(input => input.getClientRects().length > 0 && !input.disabled)?.focus({ preventScroll: true })
  })
}

/** A fast second Enter waits for the held context to reach the composer. */
export async function holdConversationContext(action: () => Promise<boolean | void>, scope: ParentNode | null = document): Promise<void> {
  let send = false
  const nextEnter = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault(); event.stopImmediatePropagation()
    if (!event.repeat) send = true
  }
  document.addEventListener('keydown', nextEnter, true)
  try {
    if (await action() === false) return
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      const inputs = scope?.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message conversation"]') ?? []
      const input = Array.from(inputs).find(input => input.getClientRects().length > 0 && !input.disabled)
      input?.focus({ preventScroll: true })
      if (send) input?.form?.requestSubmit()
      resolve()
    }))
  } finally { document.removeEventListener('keydown', nextEnter, true) }
}
