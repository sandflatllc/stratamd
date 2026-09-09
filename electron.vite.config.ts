import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

import { execFileSync } from 'node:child_process'
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
    plugins: [externalizeDepsPlugin(), {
      name: 'selected-x11-window-helper',
      closeBundle() {
        if (process.platform !== 'linux') return
        mkdirSync('out/main', { recursive: true })
        execFileSync('cc', ['-D_POSIX_C_SOURCE=200809L', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'native/window-capture/x11-window.c', '-ldl', '-o', 'out/main/capture-x11'])
      },
    }],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          cli: 'src/cli/index.ts',
          'accessibility-worker': 'src/main/capture/accessibility-worker.ts',
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
