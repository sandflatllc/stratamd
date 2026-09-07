import { BrowserWindow } from 'electron'
import { paintCommentSheet, type CommentSheetInput } from '../shared/visual-comment-sheet'

export type ComposeCommentImage = (bytes: Uint8Array, note: Omit<CommentSheetInput, 'image'>) => Promise<{ bytes: Uint8Array; width: number; height: number }>

/** One short-lived, offline renderer per image. Never opens or focuses a window. */
export const composeCommentImage: ComposeCommentImage = async (bytes, note) => {
  const window = new BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  try {
    await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">')
    const input: CommentSheetInput = { ...note, image: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` }
    const result = await window.webContents.executeJavaScript(`(${paintCommentSheet.toString()})(${JSON.stringify(input)})`) as { dataUrl: string; width: number; height: number }
    return { bytes: Buffer.from(result.dataUrl.slice('data:image/png;base64,'.length), 'base64'), width: result.width, height: result.height }
  } finally {
    window.destroy()
  }
}
