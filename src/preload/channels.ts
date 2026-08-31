export const IPC = {
  state: 'strata:state',
  stateChanged: 'strata:state-changed',
  spelling: 'strata:spelling',
  addDictionaryWord: 'strata:add-dictionary-word',
  openDocument: 'strata:open-document',
  closeDocument: 'strata:close-document',
  updateBuffer: 'strata:update-buffer',
  undo: 'strata:undo',
  redo: 'strata:redo',
  save: 'strata:save',
  setSourceMode: 'strata:set-source-mode',
  keepHunk: 'strata:keep-hunk',
  revertHunk: 'strata:revert-hunk',
  markReviewed: 'strata:mark-reviewed',
  saveRound: 'strata:save-round',
  addAnnotation: 'strata:add-annotation',
  requoteAnnotation: 'strata:requote-annotation',
  reply: 'strata:reply',
  resolveAnnotation: 'strata:resolve-annotation',
  acceptSuggestion: 'strata:accept-suggestion',
  rejectSuggestion: 'strata:reject-suggestion',
  acceptAllSuggestions: 'strata:accept-all-suggestions',
  rejectAllSuggestions: 'strata:reject-all-suggestions',
  clearResolvedAnnotations: 'strata:clear-resolved-annotations',
  resolveRecovery: 'strata:resolve-recovery',
  resolveConflict: 'strata:resolve-conflict',
  previewSend: 'strata:preview-send',
  send: 'strata:send',
  copyForAgent: 'strata:copy-for-agent',
  copyText: 'strata:copy-text',
  nudge: 'strata:nudge',
  setLead: 'strata:set-lead',
  disconnectAgent: 'strata:disconnect-agent',
  addFolder: 'strata:add-folder',
  scanFolder: 'strata:scan-folder',
  refreshExplorer: 'strata:refresh-explorer',
  forgetDocument: 'strata:forget-document',
  updateSettings: 'strata:update-settings',
  selectTheme: 'strata:select-theme',
  createTheme: 'strata:create-theme',
  setThemeValue: 'strata:set-theme-value',
  renameTheme: 'strata:rename-theme',
  revertTheme: 'strata:revert-theme',
  deleteTheme: 'strata:delete-theme',
  listFonts: 'strata:list-fonts',
  openThemeSample: 'strata:open-theme-sample',
  resolveLocalImage: 'strata:resolve-local-image',
  openExternal: 'strata:open-external',
  reportError: 'strata:report-error'
} as const

/** Renderer→main fire-and-forget; a failure report must not await a reply. */
export type SendChannel = typeof IPC.reportError

/** Main→renderer pushes; everything else is a renderer invoke. */
export type PushChannel = typeof IPC.stateChanged | typeof IPC.spelling

export type InvokeChannel = Exclude<(typeof IPC)[keyof typeof IPC], PushChannel | SendChannel>
