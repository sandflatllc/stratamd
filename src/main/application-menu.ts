import { Menu } from 'electron'
import { isDarwin } from '../platform/runtime.js'

/**
 * Linux keeps no application menu. macOS gets the minimal native menu the
 * system expects: the app menu, Edit, and Window — with no Reload, developer
 * tools, or window-zoom roles, because zoom is per pane in the renderer
 * (PRD §6.9, docs/plans/open/mac-plan.md §4.5).
 */
export function buildApplicationMenu(darwin: boolean = isDarwin()): Menu | null {
  if (!darwin) return null
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ])
}
