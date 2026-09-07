import type { PreviewViewportRequest, PreviewViewportView } from './contracts'

/**
 * Preview windows (docs/plans/open/visual-review, phase 2): the device sizes
 * the size pill offers, every size an agent may name, and the address rules.
 * Labels are plain words; a device size is described as a narrowed viewport,
 * never as a phone.
 */
export interface PreviewPreset { id: string; label: string; width: number; height: number }

/** The sizes the size pill offers, in the order shown. */
export const PREVIEW_PRESETS: readonly PreviewPreset[] = [
  { id: 'iphone-se', label: 'Small phone', width: 375, height: 667 },
  { id: 'iphone-12-pro', label: 'Phone', width: 390, height: 844 },
  { id: 'iphone-14-pro-max', label: 'Large phone', width: 430, height: 932 },
  { id: 'ipad-mini', label: 'Small tablet', width: 768, height: 1024 },
  { id: 'ipad-pro', label: 'Tablet', width: 1024, height: 1366 },
  { id: 'nest-hub-max', label: 'Small laptop', width: 1280, height: 800 },
]

/** Every size T3's tools may name, with the sizes T3 uses, so an agent's request lands at the same width. */
export const KNOWN_PRESETS: readonly PreviewPreset[] = [
  ...PREVIEW_PRESETS,
  { id: 'iphone-xr', label: 'Phone', width: 414, height: 896 },
  { id: 'pixel-7', label: 'Phone', width: 412, height: 915 },
  { id: 'samsung-galaxy-s8-plus', label: 'Phone', width: 360, height: 740 },
  { id: 'samsung-galaxy-s20-ultra', label: 'Phone', width: 412, height: 915 },
  { id: 'ipad-air', label: 'Tablet', width: 820, height: 1180 },
  { id: 'surface-pro-7', label: 'Tablet', width: 912, height: 1368 },
  { id: 'surface-duo', label: 'Small tablet', width: 540, height: 720 },
  { id: 'galaxy-z-fold-5', label: 'Narrow phone', width: 344, height: 882 },
  { id: 'asus-zenbook-fold', label: 'Tablet', width: 853, height: 1280 },
  { id: 'samsung-galaxy-a51-71', label: 'Phone', width: 412, height: 914 },
  { id: 'nest-hub', label: 'Small laptop', width: 1024, height: 600 },
  { id: 'desktop-1920x1080', label: 'Desktop', width: 1920, height: 1080 },
  { id: 'desktop-1440x900', label: 'Desktop', width: 1440, height: 900 },
  { id: 'laptop-1366x768', label: 'Laptop', width: 1366, height: 768 },
  { id: 'laptop-1280x800', label: 'Laptop', width: 1280, height: 800 },
]

export const PREVIEW_MIN_DIMENSION = 240
export const PREVIEW_MAX_DIMENSION = 3840
export const PREVIEW_MAX_AREA = 3840 * 2160

export function presetById(id: string): PreviewPreset | null {
  return KNOWN_PRESETS.find((preset) => preset.id === id) ?? null
}

export function resolveViewport(request: PreviewViewportRequest): { viewport: PreviewViewportView } | { error: string } {
  if (request.mode === 'fill') return { viewport: { mode: 'fill' } }
  if (request.mode === 'preset') {
    const preset = presetById(request.preset)
    if (!preset) return { error: `There is no size called ${request.preset}` }
    return { viewport: { mode: 'preset', preset: preset.id, label: preset.label, width: preset.width, height: preset.height } }
  }
  const width = Math.round(request.width)
  const height = Math.round(request.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < PREVIEW_MIN_DIMENSION || height < PREVIEW_MIN_DIMENSION || width > PREVIEW_MAX_DIMENSION || height > PREVIEW_MAX_DIMENSION) return { error: `A custom size needs a width and height between ${PREVIEW_MIN_DIMENSION} and ${PREVIEW_MAX_DIMENSION}` }
  if (width * height > PREVIEW_MAX_AREA) return { error: 'That size is larger than a preview can draw' }
  return { viewport: { mode: 'freeform', width, height } }
}

/** The size pill's text. */
export function viewportLabel(viewport: PreviewViewportView): string {
  if (viewport.mode === 'fill') return 'Fit window'
  if (viewport.mode === 'preset') return viewport.label
  return `${viewport.width} × ${viewport.height}`
}

/** The caption under a framed page: a narrowed viewport, never a phone. */
export function viewportCaption(viewport: PreviewViewportView): string | null {
  if (viewport.mode === 'fill') return null
  return `Narrowed viewport · ${viewport.mode === 'preset' ? viewport.label + ' · ' : ''}${viewport.width} × ${viewport.height}`
}

/** The size in T3's own words, for the resize result. */
export function viewportSetting(viewport: PreviewViewportView): { _tag: 'fill' } | { _tag: 'freeform'; width: number; height: number } | { _tag: 'preset'; presetId: string; width: number; height: number } {
  if (viewport.mode === 'fill') return { _tag: 'fill' }
  if (viewport.mode === 'preset') return { _tag: 'preset', presetId: viewport.preset, width: viewport.width, height: viewport.height }
  return { _tag: 'freeform', width: viewport.width, height: viewport.height }
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|[a-z0-9-]+\.local)$/i

/**
 * A typed address is a supplied address: only http and https pages can be
 * previewed, a schemeless loopback host gets http and any other host https,
 * and the machine running Strata decides what is reachable.
 */
export function resolvePreviewAddress(input: string): { url: string } | { error: string } {
  const raw = input.trim()
  if (!raw) return { error: 'Type an address to open' }
  // A host with a port ("localhost:5173") is not a scheme; only "scheme://" and the schemes that never take slashes count.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(javascript|data|mailto|about|blob|tel):/i.test(raw)
  const withScheme = hasScheme ? raw : (() => {
    const host = raw.split(/[/?#]/, 1)[0]!.replace(/:\d+$/, '')
    return `${LOOPBACK.test(host) ? 'http' : 'https'}://${raw}`
  })()
  let url: URL
  try { url = new URL(withScheme) } catch { return { error: `${raw} is not an address a page can have` } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http and https pages can be previewed' }
  if (!url.hostname) return { error: `${raw} names no host` }
  return { url: url.toString() }
}

/** A page's name for tabs and pills: its title, else its host and path. */
export function pageName(url: string, title: string): string {
  const clean = title.trim()
  if (clean) return clean
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}` || 'New tab'
  } catch { return url || 'New tab' }
}

/** The top bar pill for a preview window: the project and the page it shows. */
export function previewPillName(projectTitle: string, page: { url: string; title: string } | null): string {
  return page ? `${projectTitle} · ${pageName(page.url, page.title)}` : `${projectTitle} · Preview`
}

/** The address bar splits the host from the rest so the path reads at a glance. */
export function splitAddress(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url)
    return { host: parsed.host, rest: `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/^\/$/, '') }
  } catch { return { host: url, rest: '' } }
}
