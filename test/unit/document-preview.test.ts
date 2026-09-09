import { mkdtemp, writeFile, symlink, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, WebContentsView: class {}, session: {}, shell: {} }))
import { readLocalDocument } from '../../src/main/document-preview'
import { MAX_DOCUMENT_BYTES } from '../../src/shared/documents'

it('reads an explicit local document byte-for-byte and rejects oversized or non-document targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-document-read-'))
  try {
    const bytes = Buffer.from([37, 80, 68, 70, 45, 49, 46, 55, 0, 128, 255])
    const original = join(directory, 'report.pdf'), alias = join(directory, 'alias.pdf')
    await writeFile(original, bytes); await symlink(original, alias)
    const result = await readLocalDocument(alias)
    expect(result.path).toBe(original); expect(result.bytes).toEqual(bytes)
    const oversized = await open(join(directory, 'large.pdf'), 'w'); await oversized.truncate(MAX_DOCUMENT_BYTES + 1); await oversized.close()
    await expect(readLocalDocument(join(directory, 'large.pdf'))).rejects.toThrow('50 MB')
    await writeFile(join(directory, 'secret.txt'), 'private')
    await symlink(join(directory, 'secret.txt'), join(directory, 'disguised.pdf'))
    await expect(readLocalDocument(join(directory, 'disguised.pdf'))).rejects.toThrow('not a PDF or HTML')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
