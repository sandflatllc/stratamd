import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
/** Fail closed: only the authenticated, exact release can receive this upstream backport. */
export async function applyEngineBackport(root, destination, source) {
  const backport = source.backport
  const patchBytes = await readFile(join(root, 'packaging/engine', backport.bundlePatch))
  const upstreamBytes = await readFile(join(root, 'packaging/engine', backport.upstreamPatch))
  if (sha256(patchBytes) !== backport.bundlePatchSHA256 || sha256(upstreamBytes) !== backport.upstreamPatchSHA256) throw new Error('Engine backport source checksum failed')
  const patch = JSON.parse(patchBytes)
  const path = join(destination, patch.file)
  let text = await readFile(path, 'utf8')
  if (sha256(text) !== patch.beforeSHA256) throw new Error('Engine backport input checksum failed')
  text = text.replace('\n\nimport ', '\n\n' + patch.import + 'import ')
  for (const replacement of patch.replacements) {
    if (text.split(replacement.before).length !== 2) throw new Error('Engine backport expected exactly one matching function')
    text = text.replace(replacement.before, replacement.after)
  }
  if (sha256(text) !== patch.afterSHA256) throw new Error('Engine backport output checksum failed')
  await writeFile(path, text)
  return { ...backport, file: patch.file, beforeSHA256: patch.beforeSHA256, afterSHA256: patch.afterSHA256 }
}
