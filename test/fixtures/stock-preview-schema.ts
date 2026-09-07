import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Executes the pinned stock declarations rather than a permissive duplicate schema. */
export async function stockSnapshotEncoder(bundle: string, temporary: string): Promise<(value: unknown) => unknown> {
  const directory = join(bundle, 'node_modules/t3/dist')
  const code = await readFile(join(directory, 'bin.mjs'), 'utf8')
  const imports = code.split('\n').find(line => line.startsWith('import {') && /\.\/Schema-[^\"]+\.mjs/.test(line))!
  const start = code.indexOf('const PreviewAutomationElement = Struct(')
  const end = code.indexOf('const PreviewAutomationRecordingStatus = Struct(', start)
  if (!imports || start < 0 || end < 0) throw new Error('Pinned stock preview declarations were not found')
  const module = join(temporary, 'stock-preview-schema.mjs')
  await writeFile(module, imports.replace(/"\.\/(Schema-[^\"]+\.mjs)"/, (_, file) => JSON.stringify(pathToFileURL(join(directory, file)).href)) + '\n' + code.slice(start, end) + '\nexport {PreviewAutomationSnapshot, encodeSync};\n')
  const { PreviewAutomationSnapshot, encodeSync } = await import(pathToFileURL(module).href)
  return encodeSync(PreviewAutomationSnapshot)
}
