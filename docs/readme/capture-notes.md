# README capture notes

Captured September 8, 2026, on Linux at 1600 × 1060. All three images show the real built Strata Electron application in an isolated Xvfb display. No interface mockup, image generation, compositing, or retouching was used.

The app uses the Strata Vivid theme, with conversation text zoom set to 90%. The app still displays StrataMD in its menu. The screenshots preserve the current interface; the README drafts introduce the Strata name.

## Test data

The repository's existing fake T3 engine supplies fictional threads through HTTP and WebSocket connections. These are synthetic messages, not outputs from a live model. The app renders and interacts with them through its normal production code.

The browser loads [test-board.html](test-board.html) from a temporary local HTTP server. Fieldnotes, its tasks, and its team initials are fictional. That HTML is the website inside the real Strata browser, not a replacement for Strata's interface.

The app profile, documents, credentials, and browser state are temporary test data. The owner's running app and saved data were not used. No real provider was contacted.

| Image | Actual app state |
| --- | --- |
| [Agent workspace](images/agent-workspace.png) | A center conversation rendering a Verdict and DecisionMatrix in an assistant reply. |
| [Passage comment](images/passage-comment.png) | The comment composer opened on a selected sentence, with a draft response. |
| [Browser annotation](images/browser-annotation.png) | The built-in browser's annotation mode, with an arrow drawn in Strata and a draft visual comment. |

The comment drafts were not sent. The images demonstrate the interaction and rendering, not a live agent completing the fictional task.

The images now live in `images/` beneath the drafts. The original sibling-folder paths existed on disk but fell outside a standalone document's allowed image directory. After relocation, all three images loaded in each of the three drafts in an isolated Strata window with no explorer folders or paired engine. Viewer evidence is at `/tmp/strata-readme-images-fixed.png`.

## Build and checks

The screenshots use the production output from `~/.cache/stratamd-verification/runs/2026-09-08T08-05-53-379Z-5ebedd61/candidate/out`, copied into `/tmp/strata-readme-app` with its native helper and resources. That verification run passed TypeScript, the production build, and both side and center passage-comment scenarios selected by `test/e2e/conversation-comments.spec.ts:7`. No tests in that selection were skipped. A full product gate was not run for these documentation and screenshot additions.

An earlier selection at line 8 found no tests. A queued selection at line 9 was canceled before execution and replaced with the declaration at line 7. Those were selection errors, not failing product assertions. An initial capture launch directly from retained verification output could not open a window because verification had already removed that candidate's dependency directory. The separate capture app copy supplied the existing checkout dependencies and launched successfully.

## Recreate the capture session

From the repository root, use a current production build and the existing installed dependencies. The preparation script starts the fake engine, local website, and isolated Strata window. It prints the local website address and exposes CDP on port 19381. For a separate built app, set `STRATA_CAPTURE_MAIN` to its main entry.

```bash
TMPDIR=/tmp xvfb-run -a -s '-screen 0 1600x1060x24' node \
  --experimental-strip-types --experimental-transform-types \
  --experimental-loader ./src/cli/typescript-loader.ts \
  docs/readme/capture.mjs
```

Use agent-browser with the exact Strata page target from `http://127.0.0.1:19381/json/list`. The browser adds a second target, so match the `app://stratamd/` URL. Read the installed agent-browser skill before running its commands.

1. Set the editor zoom to 90% through Strata's settings API and scroll the conversation to its beginning. Capture the agent workspace.
2. Select “Save a view automatically whenever a filter changes.” Choose Comment and enter “Make saving explicit. Let me try filters first.” Capture the open composer, then cancel it.
3. Open the project's browser and navigate to the local website address printed by the script. Collapse the right rail with its resize handle's Enter action. Open Annotate, select Arrow, and draw toward Save view. Enter “Make this easier to find. Use the same green as New task, and call it Save current view.” Capture the annotation mode.

The local control endpoint writes a full window PNG when requested at `/agent-workspace`, `/passage-comment`, or `/browser-annotation` on port 19382. It uses Electron's `BrowserWindow.capturePage()`. Capture the browser in annotation mode: the live embedded WebContentsView is omitted from a window capture, while annotation mode renders Strata's saved page capture and marks together.

Call `http://127.0.0.1:19382/stop` to close only the capture app and its test servers and remove the temporary profile. Images remain in `docs/readme/images/`.
