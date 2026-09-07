import type { NativeImage, Rectangle, WebContents } from 'electron'

/** Chromium can reject or return an empty image before a new guest submits its first compositor frame. */
export async function captureWhenPainted(
  contents: Pick<WebContents, 'capturePage' | 'executeJavaScript' | 'isDestroyed'>,
  label: string,
  now: () => number,
  rect?: Rectangle,
): Promise<NativeImage> {
  const deadline = now() + 5000
  for (;;) {
    try {
      const image = await contents.capturePage(rect)
      if (!image.isEmpty()) return image
    } catch (error) {
      // Only this missing-frame outcome is recoverable. Permission, destroyed
      // contents, and other capture failures keep their original error.
      if (!(error instanceof Error) || error.message !== 'UnknownVizError') throw error
    }
    if (now() >= deadline || contents.isDestroyed()) throw new Error(`${label} has not produced a capturable frame`)
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true)
  }
}
