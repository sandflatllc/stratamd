import { engineStorage } from './engineStorage'
/** Placement exists even before the first conversation is selected. */
export interface WorkspaceState {
  conversationCentered: boolean
  conversationTabs: string[]
  /** Projects whose preview window is open, one pill each (docs/plans/open/visual-review, phase 2). */
  previews: string[]
  /** The project whose preview holds the center, when one does. */
  previewCentered: string | null
}

export const WORKSPACE_KEY = 'stratamd.workspace.v1'

export function readWorkspace(): WorkspaceState {
  let state: WorkspaceState = { conversationCentered: true, conversationTabs: [], previews: [], previewCentered: null }
  try {
    const value = JSON.parse(engineStorage.getItem(WORKSPACE_KEY) ?? 'null') as Partial<WorkspaceState> | null
    if (value && typeof value.conversationCentered === 'boolean' && Array.isArray(value.conversationTabs) && value.conversationTabs.every((id) => typeof id === 'string')) {
      const previews = Array.isArray(value.previews) ? [...new Set(value.previews.filter((id): id is string => typeof id === 'string'))] : []
      state = { conversationCentered: value.conversationCentered, conversationTabs: [...new Set(value.conversationTabs)], previews, previewCentered: typeof value.previewCentered === 'string' && previews.includes(value.previewCentered) ? value.previewCentered : null }
    }
  } catch { /* Missing or invalid state uses the conversation-first default. */ }
  // Explicit file launches take the center; ordinary launches restore placement.
  if (new URL(window.location.href).searchParams.has('openDocument')) { state.conversationCentered = false; state.previewCentered = null }
  return state
}

/** Consume the launch intent after mounting, so reading initial state stays repeatable. */
export function consumeDocumentLaunch(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('openDocument')) return
  url.searchParams.delete('openDocument')
  window.history.replaceState(null, '', url)
}

export function writeWorkspace(state: WorkspaceState): void {
  try { engineStorage.setItem(WORKSPACE_KEY, JSON.stringify(state)) } catch { /* Storage may be unavailable. */ }
}
