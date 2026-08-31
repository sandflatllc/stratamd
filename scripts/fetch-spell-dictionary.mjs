// Downloads the en-US Hunspell dictionary through Electron's own mechanism
// into ~/.config/Electron/Dictionaries, one of the locations the spellcheck
// e2e spec seeds from. CI runners start with no dictionary; Chromium computes
// the CDN URL itself, so nothing here pins a version. Run under the electron
// binary: `npx electron scripts/fetch-spell-dictionary.mjs` (with a display).
import { app, session } from 'electron'

const timeout = setTimeout(() => {
  console.error('Timed out waiting for the dictionary download.')
  app.exit(1)
}, 120_000)

app.whenReady().then(() => {
  const target = session.defaultSession
  target.on('spellcheck-dictionary-download-success', (_event, language) => {
    clearTimeout(timeout)
    console.log(`Downloaded the ${language} dictionary.`)
    app.exit(0)
  })
  target.on('spellcheck-dictionary-download-failure', (_event, language) => {
    clearTimeout(timeout)
    console.error(`The ${language} dictionary download failed.`)
    app.exit(1)
  })
  target.on('spellcheck-dictionary-initialized', (_event, language) => {
    clearTimeout(timeout)
    console.log(`The ${language} dictionary is already present.`)
    app.exit(0)
  })
  target.setSpellCheckerLanguages(['en-US'])
})
