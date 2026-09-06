import { app, Menu, nativeImage, Tray } from 'electron'

/** A small S drawn as pixels stays legible on light and dark system panels. */
export function engineTray(reopen: () => void): Tray {
  const size = 22, pixels = Buffer.alloc(size * size * 4)
  for (let y = 3; y < 19; y++) for (let x = 3; x < 19; x++) {
    const ink = y < 6 || (y >= 9 && y < 13) || y >= 16 || (x < 6 && y < 11) || (x >= 16 && y >= 11)
    if (!ink) continue
    const offset = (y * size + x) * 4
    pixels[offset] = 180; pixels[offset + 1] = 160; pixels[offset + 2] = 250; pixels[offset + 3] = 255
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: size, height: size })
  const tray = new Tray(icon)
  tray.setToolTip('StrataMD')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Strata', click: reopen }, { type: 'separator' }, { label: 'Quit Strata', click: () => app.quit() }]))
  tray.on('click', reopen)
  return tray
}
