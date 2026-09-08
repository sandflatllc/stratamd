/// <reference lib="webworker" />

self.onmessage = async (event: MessageEvent<ImageBitmap>) => {
  const image = event.data
  try {
    const canvas = new OffscreenCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The marked image could not be drawn')
    context.drawImage(image, 0, 0)
    const bytes = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    self.postMessage({ bytes }, [bytes])
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'The marked image could not be saved' })
  } finally { image.close() }
}
