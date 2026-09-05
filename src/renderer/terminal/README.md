# Terminal adapter

Vendored from t3code revision `4e7359b07bcbed9a8adbea6451f4178e098a0201`.
`ghostty/` comes from `apps/web/src/terminal/ghostty/`, byte-identical except the three imports in surface.ts. `terminal-links.ts` changes only its helper import. `helpers.ts` extracts the platform and font-probe helpers. `buffer.ts` extracts the bounded buffer reducer from `packages/client-runtime/src/state/terminalSession.ts` with local contract types.

T3 code is MIT licensed (LICENSE-T3). The Ghostty build revision and license accompany the WASM in ghostty/vendor. The symbols font license is in ghostty/fonts.
