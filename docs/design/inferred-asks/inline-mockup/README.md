# Questions in the original passage

Interactive mockup for Dillon's 2026-09-07 correction: identify requests and place tags on the original text and the conversation navigation rail. Do not restate the questions or collect duplicates at the end of the reply.

Open [mockup.html](mockup.html). It is a self-contained local HTML file. Click a Question tag or an amber navigation marker, write an answer in the floating popup, and choose Queue reply. The question's tag becomes Drafted; the answer joins Pending context in the existing composer. Send only changes local preview state. It never contacts an agent or changes Strata data.

The mockup imports the actual `src/renderer/styles.css`, Baloo 2 and JetBrains Mono fonts, Strata icon, and `AmbientDecor` component with its real sky renderer and texture worker. `theme.json` is a copy of the owner's current Copy of Strata Night theme. Shell markup is recreated for the preview; the existing annotation, discussion, button, and reply-field styles are reused. The Question pills, question navigation markers, are proposed additions. The answer popup uses the existing passage discussion placement and styles from ConversationWorkspace, at the lower right of the reading area. Opening it does not reflow the transcript or repeat the question. Escape, click outside, Cancel, and the close button dismiss the popup.

The assistant prose is the real earlier two-question reply saved in `../experiment/review-2026-09-07/cases.json`, case `real-two-decisions`. It is example historical content, not a renewed request for those decisions. The user bubble is illustrative. The filled answer in the screenshot is sample text.

- [Reading view](reading.png)
- [Answer popup](answer-popup.png)
- [Queued reply](queued.png)

Build from the repository root with `./node_modules/.bin/vite build --config docs/design/inferred-asks/inline-mockup/vite.config.mjs`, then run `python3 docs/design/inferred-asks/inline-mockup/pack.py`. The local preview contains no backend connection. Source files and packaged output live only in this design directory; no application implementation changed.

Browser checks cover opening a tag, typing and queuing an answer, navigating to the second question from the rail, closing the popup through Escape, click outside, Cancel, and its close button, draft retention, unchanged passage positions, and the local Send simulation. Screenshots use a 1600 × 1000 viewport. The actual renderer build succeeds; application test suites are not part of this design-only mockup.
