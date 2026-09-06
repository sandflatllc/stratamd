/** 64M pixels = at most 256 MiB decoded RGBA, before Chromium overhead (from Outcrop's capture budget). */
export const MAX_SCREENSHOT_PIXELS = 64_000_000
export const MAX_SCREENSHOT_DIMENSION = 16_384

export interface ScreenshotPlan {
  /** Whether the whole extent fits the budget; "complete" describes captured extent, not rendered content. */
  complete: boolean
  pixelSize: { width: number; height: number }
  decodedBytes: number
}

export function screenshotPlan(cssWidth: number, cssHeight: number, deviceScale: number): ScreenshotPlan {
  const scale = Math.max(1, Number.isFinite(deviceScale) ? deviceScale : 1)
  const pixelSize = { width: Math.ceil(cssWidth * scale), height: Math.ceil(cssHeight * scale) }
  const pixels = pixelSize.width * pixelSize.height
  return {
    complete: cssWidth > 0 && cssHeight > 0 && pixels <= MAX_SCREENSHOT_PIXELS
      && pixelSize.width <= MAX_SCREENSHOT_DIMENSION && pixelSize.height <= MAX_SCREENSHOT_DIMENSION,
    pixelSize,
    decodedBytes: pixels * 4,
  }
}
