import { engineStorage } from './engineStorage'
/** Placement exists even before the first conversation is selected. */
export interface WorkspaceState {
  conversationCentered: boolean
  conversationTabs: string[]
}

export const WORKSPACE_KEY = 'stratamd.workspace.v1'

export function readWorkspace(): WorkspaceState {
  let state: WorkspaceState = { conversationCentered: true, conversationTabs: [] }
  try {
    const value = JSON.parse(engineStorage.getItem(WORKSPACE_KEY) ?? 'null') as WorkspaceState | null
    if (value && typeof value.conversationCentered === 'boolean' && Array.isArray(value.conversationTabs) && value.conversationTabs.every((id) => typeof id === 'string')) {
      state = { conversationCentered: value.conversationCentered, conversationTabs: [...new Set(value.conversationTabs)] }
    }
  } catch { /* Missing or invalid state uses the conversation-first default. */ }
  // Explicit file launches take the center; ordinary launches restore placement.
  if (new URL(window.location.href).searchParams.has('openDocument')) state.conversationCentered = false
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
