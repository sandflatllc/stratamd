import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** PDF worker is bundled by Vite; fonts, CMaps and image decoders stay local with their license. */
function pdfAssets(): Plugin {
  const files: Array<{ name: string; path: string }> = []
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const name of readdirSync(join('node_modules/pdfjs-dist', directory))) files.push({ name: `${directory}/${name}`, path: join('node_modules/pdfjs-dist', directory, name) })
  }
  files.push({ name: 'LICENSE', path: 'node_modules/pdfjs-dist/LICENSE' })
  return { name: 'local-pdf-assets',
    generateBundle() { for (const file of files) this.emitFile({ type: 'asset', fileName: `pdf/${file.name}`, source: readFileSync(file.path) }) },
    configureServer(server) { server.middlewares.use((request, response, next) => { const file = files.find(file => request.url === `/pdf/${file.name}`); if (!file) return next(); response.end(readFileSync(file.path)) }) },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          cli: 'src/cli/index.ts',
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), pdfAssets()],
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    }
  }
})
