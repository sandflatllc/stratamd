// Renderer-side entry to the local failure log (docs/plans/completed/crash-hardening-plan.md
// §7). Fields are capped here so the main-side schema never rejects a real
// report for being too long, and nothing in this path may throw.

const cap = (value: string, limit: number): string => (value.length > limit ? value.slice(0, limit) : value)

export function sendErrorReport(scope: string, message: string, stack?: string, componentStack?: string): void {
  try {
    window.strata.reportError?.({
      scope: cap(scope, 100),
      message: cap(message || 'Unknown error', 2_000),
      ...(stack ? { stack: cap(stack, 4_000) } : {}),
      ...(componentStack ? { componentStack: cap(componentStack, 4_000) } : {})
    })
  } catch {
    // A failing report must never become a second failure.
  }
}
