import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'

/** Temporarily suppress Strata markup; keep page CSS and requested-image captures intact. */
export async function withCleanPage<T>(contents: WebContents, capture: () => Promise<T>, restore: () => boolean = () => true): Promise<T> {
  const key = `__strataCapture_${randomUUID().replaceAll('-', '')}`
  const property = JSON.stringify(key)
  await contents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('[data-strata-visual]')].map(node => ({ node, css: node.getAttribute('style'), media: node.getAttribute('media') }));
    window[${property}] = nodes;
    for (const {node} of nodes) { if (node.tagName === 'STYLE') node.setAttribute('media', 'not all'); else node.style.setProperty('visibility', 'hidden', 'important'); }
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`, true)
  try { return await capture() }
  finally {
    if (!contents.isDestroyed()) await contents.executeJavaScript(`(() => {
      const nodes = window[${property}] || []; delete window[${property}];
      for (const {node, css, media} of nodes) {
        if (!node.isConnected) continue;
        if (!${restore()}) { node.remove(); continue; }
        if (node.tagName === 'STYLE') { if (node.getAttribute('media') === 'not all') media === null ? node.removeAttribute('media') : node.setAttribute('media', media); }
        else if (node.style.visibility === 'hidden') css === null ? node.removeAttribute('style') : node.setAttribute('style', css);
      }
    })()`, true).catch(() => undefined)
  }
}
