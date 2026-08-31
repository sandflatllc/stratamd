import nunito500Italic from '@fontsource/nunito/files/nunito-latin-500-italic.woff2?url'
import nunito600Italic from '@fontsource/nunito/files/nunito-latin-600-italic.woff2?url'
import nunito700Italic from '@fontsource/nunito/files/nunito-latin-700-italic.woff2?url'
import nunito800Italic from '@fontsource/nunito/files/nunito-latin-800-italic.woff2?url'

const italicFaces = [
  [500, nunito500Italic],
  [600, nunito600Italic],
  [700, nunito700Italic],
  [800, nunito800Italic]
] as const

// Baloo 2 has no italic. Register Nunito's real italic under the Baloo 2
// family so markdown emphasis does not fall back to a synthesized slant.
export function registerItalicFaces(): void {
  if (!('fonts' in document) || typeof FontFace === 'undefined') return
  for (const [weight, url] of italicFaces) {
    const face = new FontFace('Baloo 2', `url(${url})`, { style: 'italic', weight: String(weight), display: 'swap' })
    document.fonts.add(face)
    void face.load()
  }
}
