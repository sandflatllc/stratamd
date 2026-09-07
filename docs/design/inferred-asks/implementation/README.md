# Inferred asks implementation

Question tags identify the original requests in agent replies. Tags open the existing floating answer popup. Navigation markers reveal folded or offscreen passages through the transcript coordinator. Unqueued text survives dismissal; Queue reply replaces one keyed pending answer, and Send acknowledgment changes Drafted to Answered. The existing Items menu can dismiss an unwanted inferred question.

The [approved mockup](../inline-mockup/README.md) specifies the interaction. These captures show the actual Electron application with its default test theme, not the owner's custom theme. Example thread content comes from the fake engine fixture. Other visible engine requests are existing controls, not generated ask duplicates.

| Layout | Normal scale | 120% text scale |
|---|---|---|
| Center | [Popup](center-popup.png) | [Popup](center-popup-zoom.png) |
| Side | [Popup](side-popup.png) | [Popup](side-popup-zoom.png) |

The focused Electron checks cover popup geometry, no transcript reflow on opening, Escape/Cancel/outside dismissal, immediate draft retention, queued-edit isolation, keyed delivery and acknowledgment, persisted dismissal, and navigation. A controlled decoration-height change above an interior reading passage verifies that mounted-editor annotation updates preserve that passage. Existing turn-folding and transcript-stability tests also passed after the navigation fix.

The short-reply navigation regression was a retained bottom-follow intent after a jump that remained at scrollTop zero. The queued resize moved the transcript to its new bottom after rich-editor publication. Completed navigation now records the reading row explicitly. The trace and failed attempts remain in the `inferred-asks` verification task under `~/.cache/stratamd-verification/`; passing focused evidence is run `2026-09-07T18-55-34-443Z-ba25d212`. Required final full/stress results are recorded in that same task and the working plan.

The [quote-only evaluation](../experiment/quote-only-2026-09-07/RESULTS.md) explains accuracy, measured generation time, and limitations. This release uses the managed engine's selected enabled/authenticated Codex text-generation account; external engines and custom launch/environment settings are explicitly unsupported. No owner's running app or installed skills were changed.
