import { App } from '@crowecawcaw/xa11y'
import { accessibleText, selectedAccessibleWindow } from './accessibility'
process.once('message', async (request: { pid: number; title: string; bounds: { x: number; y: number; width: number; height: number } }) => {
  try {
    const app = await App.byPid(request.pid, { timeout: 0 })
    const windows = await app.children()
    // Never read a tree for a different or ambiguously named window.
    const selected = selectedAccessibleWindow(windows, request.title, request.bounds)
    const text = selected ? accessibleText(await selected.tree(32)) : ''
    process.send?.({ text, app: app.name })
  } catch { process.send?.({ text: '', app: null }) }
  finally { process.disconnect?.() }
})
