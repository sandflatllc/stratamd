/**
 * The primary shortcut modifier: Command on macOS, Control elsewhere
 * (docs/plans/open/mac-plan.md §4.6). Renderer-side code detects the platform
 * from the navigator; tests inject the answer. Pure — no Node imports.
 */
export interface ModifierEventLike {
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

export function isMacLike(
  platformHint: string = globalThis.navigator?.platform ?? '',
): boolean {
  return /mac/i.test(platformHint)
}

export function hasPrimaryModifier(event: ModifierEventLike, mac: boolean = isMacLike()): boolean {
  return mac ? event.metaKey : event.ctrlKey
}

/** True when the primary modifier is down and the other platform's is not. */
export function hasOnlyPrimaryModifier(event: ModifierEventLike, mac: boolean = isMacLike()): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function primaryModifierLabel(mac: boolean = isMacLike()): 'Cmd' | 'Ctrl' {
  return mac ? 'Cmd' : 'Ctrl'
}
