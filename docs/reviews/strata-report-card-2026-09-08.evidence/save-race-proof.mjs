// Run from the repository root using its TypeScript loader:
// node --disable-warning=ExperimentalWarning --experimental-strip-types --experimental-transform-types --experimental-loader ./src/cli/typescript-loader.ts docs/reviews/strata-report-card-2026-09-08.evidence/save-race-proof.mjs
// This controls one disk-write ordering in a disposable directory; it is not a full-app recovery test.
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const directory = await fs.mkdtemp(join(tmpdir(), 'strata-save-proof-'))
const target = join(directory, 'plan.md')
const originalRead = fs.readFile
const originalWrite = fs.writeFile
await originalWrite(target, 'original\n')
let targetReads = 0
let injected = false
fs.readFile = async function(path, ...args) {
  const result = await originalRead(path, ...args)
  if (String(path) === target && ++targetReads === 2) {
    await originalWrite(target, 'external agent update\n')
    injected = true
  }
  return result
}
syncBuiltinESMExports()
try {
  const { saveDocumentWithHashCheck } = await import(new URL('../../../src/main/files.ts', import.meta.url).href)
  const { sha256 } = await import(new URL('../../../src/main/storage.ts', import.meta.url).href)
  const result = await saveDocumentWithHashCheck(target, 'owner save\n', sha256('original\n'))
  const final = await originalRead(target, 'utf8')
  console.log(JSON.stringify({fixture: target, interleaving: 'external writer finishes after final read and before replacement rename', injected, status: result.status, final, externalUpdatePreserved: final.includes('external agent update')}, null, 2))
} finally {
  fs.readFile = originalRead
  syncBuiltinESMExports()
  await fs.rm(directory, { recursive: true, force: true })
}
