import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'vite'
await mkdir('out/ask-eval', { recursive: true })
await writeFile('out/ask-eval/entry.ts', `export { askArguments, scanAsks } from '../../src/main/engine/ask-scan'; export { askPrompt, askSource, ASK_JSON_SCHEMA, anchorAsks } from '../../src/core/asks'; export { parseStrataBlock } from '../../src/core/blocks';`)
await build({ configFile: false, build: { ssr: 'out/ask-eval/entry.ts', outDir: 'out/ask-eval/bundle', minify: false }, ssr: { noExternal: true } })
