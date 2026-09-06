import type { Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

/**
 * Review captures for docs/design/t3-parity/README.md. They are a record of
 * what was reviewed, so an ordinary test run never rewrites them: set
 * STRATA_CAPTURES=1 to regenerate them on purpose.
 */
export async function parityCapture(page: Page, name: string): Promise<void> {
  if (!process.env.STRATA_CAPTURES) return
  await mkdir('docs/design/t3-parity/captures', { recursive: true })
  await page.screenshot({ animations: 'disabled', path: `docs/design/t3-parity/captures/${name}.png` })
}
