import { app, Menu, nativeImage, Tray } from 'electron'
import trayIconPath from '../../../resources/stratamd-tray.png?asset'

/** The app's chip icon, rasterized from stratamd-icon.svg at 64px for native trays. */
export function engineTray(reopen: () => void): Tray {
  const source = nativeImage.createFromPath(trayIconPath)
  const icon = source.resize({ width: 22, height: 22 })
  icon.addRepresentation({ scaleFactor: 2, buffer: source.resize({ width: 44, height: 44 }).toPNG() })
  const tray = new Tray(icon)
  tray.setToolTip('StrataMD')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Strata', click: reopen }, { type: 'separator' }, { label: 'Quit Strata', click: () => app.quit() }]))
  tray.on('click', reopen)
  return tray
}
