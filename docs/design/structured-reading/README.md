# Structured-reading design references

These prototypes are the approved visual targets for StrataMD's structured-document reading experience. They were copied from the working plan folder on 2026-09-02 so the renderer work has one tracked authority.

| File | Authority for |
|---|---|
| `dense-review-faithful-shell.html` | The shell, Contents, walkthrough card and center-bottom walkthrough bar, review tabs, Pin Changes, the persistent Agents window, table header and table views, section hierarchy, and the overall reading experience. When prose and this file disagree about appearance, this file wins. |
| `dense-review-walkthrough.html` | Supporting evidence for dense-document hierarchy and interaction. |
| `widget-vivid-showcase.html` | The visual quality of registered components: Callout, Verdict, MetricStrip, PhaseBoard, BeforeAfter, and the shared card grammar. |
| `high-value-visual-candidates.html` | DecisionMatrix, BeforeAfter, Chart, EvidenceChain, and AnnotatedScreenshot. |

`../StrataMD App v2.dc.html` remains the authority for shell behavior these prototypes did not replace.

Every prototype ships a "Prototype choices" drawer or page switch. Those are test harnesses, not product chrome.

## Captures

`captures/prototype/` holds screenshots of the prototypes at the viewports the real app is captured at. Regenerate them with:

```sh
node scripts/capture-design-references.mjs
```

`captures/app/` holds the matching captures of the real application, produced by `test/e2e/visual-recovery.spec.ts` when `STRATAMD_VISUAL_CAPTURES` names that directory:

```sh
./node_modules/.bin/electron-vite build && STRATAMD_VISUAL_CAPTURES=docs/design/structured-reading/captures/app xvfb-run -a ./node_modules/.bin/playwright test test/e2e/visual-recovery.spec.ts
```

| App capture | Prototype capture it reproduces |
|---|---|
| `shell-walkthrough-annotations.png` | `shell-walkthrough-annotations.png` |
| `shell-changes-tab.png` | `shell-changes-tab.png` |
| `shell-pinned-changes.png` | `shell-pinned-changes.png` |
| `table-default.png` | `table-default.png` |
| `table-focus-row.png` | `table-focus-row.png` |
| `table-compare.png` | `table-compare.png` |
| `phase-board.png` | `phase-board.png` |
| `components-sampler.png` | `components-sheet-1.png`, `components-sheet-2.png`, `candidates-evidence-screenshot.png`, `candidates-matrix-impact.png` |

Both sets use fixed data and disabled motion. The same spec keeps pixel baselines under `test/e2e/visual-recovery.spec.ts-snapshots/` for the shell, Contents, the table header, and the component sampler.
