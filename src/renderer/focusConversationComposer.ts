/** Focus after a held-context popup has unmounted and returned its old focus. */
export function focusConversationComposer(scope: ParentNode | null = document): void {
  requestAnimationFrame(() => {
    const inputs = scope?.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message conversation"]') ?? []
    Array.from(inputs).find(input => input.getClientRects().length > 0 && !input.disabled)?.focus({ preventScroll: true })
  })
}
