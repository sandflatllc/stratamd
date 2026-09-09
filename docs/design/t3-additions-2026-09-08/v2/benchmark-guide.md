# Strata mockup benchmarks, revision 2

All 15 accepted additions are covered by 12 flows and 58 visual states. The [saved owner review](owner-review.md) records nine approved flows, one needing changes, and two without a saved decision. Approved flows with comments require only the named corrections. Dillon subsequently authorized implementation of all 15 features. The question states now apply his requested modal correction; the historical review remains unchanged.

Open the [interactive gallery](http://127.0.0.1:43871/v2/) to compare current Strata, the proposal, and numbered change highlights. The first gallery is superseded and must not be used as an implementation benchmark.

## What is real

The app frame is an export of the running Strata renderer, built from `37678211593ce0f43341e591d70b8c67dad093bb`. Its DOM, compiled CSS, local fonts, logo, provider icons, theme values, question form, composer, project rows, dialogs, preview toolbar, and image markup controls come from Strata. The sample projects, conversation, account reports, files, and outcomes are fixtures.

The theme is **Strata**. Its current storage ID is `strata-night`; that legacy ID does not mean a different theme. [The bundled theme definitions](../../../../src/shared/bundled-themes.ts) are the authority. Strata Vivid is not used. The test fixture normally selects Vivid, so the capture setup explicitly overrides it.

New controls use Strata's existing classes and theme variables. Additional styles are restricted to the proposed controls. There is no replacement app shell or invented brand treatment.

## How to review

1. Choose a flow and state. Use **Current Strata** to see the existing component that the proposal extends.
2. Use **Proposed** to judge the finished appearance. Use **Highlight changes** to identify the numbered elements the feature changes.
3. Review the failure and unavailable states as well as the normal state. The gallery's buttons move between sample states; they do not call an engine or provider.
4. Write notes or mark the flow approved. These decisions are saved only in this browser. Copy the review notes into chat to communicate them to the implementation agent.

The surrounding gallery controls and yellow highlights are review aids. They are excluded from the clean app screenshot. Existing exported app controls that are outside the proposed flow are present for fidelity; they do not run the live app.

## Feature coverage

| Feature | Existing Strata components | Proposed change | Review |
| --- | --- | --- | --- |
| 1. Engine usage and quota | AccountsDialog | Reported windows, remaining bars, pace, freshness, combined view, supported reset confirmation | [Usage limits](http://127.0.0.1:43871/v2/?flow=usage) |
| 2. Async questions and dismissal | Conversation | Working/waiting status, optional dismissal, held and sent states | [Questions](http://127.0.0.1:43871/v2/?flow=questions) |
| 3. Binary attachments | ConversationComposer, attachment tray | Original-file cards, type/size, missing-file and send recovery | [Files](http://127.0.0.1:43871/v2/?flow=files) |
| 4. Streaming and replay efficiency | Existing conversation and engine state | No new visible control. The current UI is the unchanged benchmark; performance needs runtime verification | [Nonvisual specification](specifications/engine-efficiency.json) |
| 5. Restart continuation | EngineDialog, Conversation | Opt-in preference, reconnect, confirmed resume, continuation-message notice, retry | [Recovery](http://127.0.0.1:43871/v2/?flow=recovery) |
| 6. Manual compaction | Context meter and Conversation | Context action, progress, result, failure, unsupported state | [Compact context](http://127.0.0.1:43871/v2/?flow=compact) |
| 7. Per-answer files | Native question form and attachment preview | Files associated with a specific answer through Hold and Send | [Answer files](http://127.0.0.1:43871/v2/?flow=questions&state=held) |
| 8. Browser evidence | ConversationMessage, PreviewWindow | Saved media, copying, retry with destination, evidence preview | [Evidence](http://127.0.0.1:43871/v2/?flow=evidence) |
| 9. Commands and skills | ConversationComposer and existing popup styling | Search, groups, descriptions, insertion into the draft, empty results | [Commands and skills](http://127.0.0.1:43871/v2/?flow=skills) |
| 10. Project defaults | SettingsDialog, SetupDialog | Scope, effective values, inheritance, overrides, conflicting save | [Defaults](http://127.0.0.1:43871/v2/?flow=defaults) |
| 11. Draft markers | ProjectsPanel, ConversationComposer | Separate pen marker, restored draft, scoped discard | [Drafts](http://127.0.0.1:43871/v2/?flow=drafts) |
| 12. Conversation import | SetupDialog, project navigation | Sources, selection, confirmation, progress, partial failure, completion | [Import](http://127.0.0.1:43871/v2/?flow=import) |
| 13. PDF and HTML previews | PreviewWindow | Read-only document controls, PDF pages/zoom, HTML preview/source, missing file | [Previews](http://127.0.0.1:43871/v2/?flow=files&state=pdf) |
| 14. External window capture | Existing full-window VisualSession, held attachments | Setup, system-picker handoff, window identity, target conversation, screenshot-only fallback | [Window capture](http://127.0.0.1:43871/v2/?flow=capture) |
| 15. Custom models | ProviderModels, ProviderSetup | Display name separate from provider ID, supported options, validation | [Models](http://127.0.0.1:43871/v2/?flow=models) |

## Instructions for implementation agents

Use each state’s `captures/<flow>-<state>-proposed.png` as the visual target. Its `-annotated.png` identifies the changed elements. The gallery links both images and the state's JSON specification. That specification lists the actual source components, change selectors and bounds, scroll positions, affected layout areas, and behavior checks.

Keep the existing app frame, fonts, theme, component spacing, icons, and unrelated controls. Questions use the exported SetupDialog frame at 640 × 560 with its existing answer controls. The modal backdrop intentionally dims the app; this affects the whole viewport in those states. Extend the named product components. Do not copy the exported HTML into the product: this folder is a design fixture, not a new component architecture.

Match the capture conditions before comparing screenshots:

- Content viewport 1440 × 1000, device scale factor 1, app zoom 1.
- Default Strata theme, with the same pane and dialog sizes shown in the reference.
- Fixture conversation and file content from `reference/`, with clock held at September 3, 2026, 12:02 UTC.
- CSS animation and caret paused. The canvas is paused through Strata's existing typing-pause mechanism. Full background frames are exported where a taller composer exposes more of the background.
- Scroll to the position recorded in the state specification. Some errors require a small conversation scroll; the model option editor uses the existing dialog scroll area.

Yellow numbers describe edited elements. `layoutImpactSelectors` describes the larger area that can move when content grows or scrolls. For example, a draft status row makes the composer taller and the conversation shorter. That layout effect is intentional; the sidebar and top bar must remain unchanged. The comparison check allows 36 pixels around these areas for existing shadows and rounded borders.

Visual agreement does not prove behavior. Run the state's behavior checks and the repository's required product verification after implementation. Usage percentages, provider options, progress, PDF contents, transfer results, and operating-system permission text here are proposed fixtures, not claims that a current engine supports them. Only expose capability-dependent actions when the connected engine reports support.

The native operating-system picker is represented by a handoff state, not a fabricated OS dialog. The PDF page is a layout fixture; pagination and zoom still need implementation. Gallery controls simulate state transitions and do not demonstrate those backends.

## Evidence and limits

[verification.json](verification.json) records the capture inputs, hashes, baseline comparisons, 58 state render checks, and differences outside the declared layout areas. [The original Electron captures](reference/) preserve the current app for reference. Each source snapshot also stores its full active theme and original DOM.

Browser preview has a native child view that the parent renderer's CDP screenshot omits. The gallery puts the same fixture page into that exact slot. Its chrome is compared separately from the page content. The page interior matches the real saved browser frame; the bottom rounded clipping is excluded from that content comparison. Image-markup captures have small raster differences between Electron and browser rendering, recorded in the verification file.

These checks cover the design exports at the fixed benchmark size. They do not claim production feature behavior, a responsive product implementation, or approval. No product source, owner profile, installed app, or active skill was changed. The current product assets were built in an isolated temporary directory; the product test gate was not run for these design files.

## Files and reproduction

- `screen.html`, `screen.js`: load an actual renderer export and restore its local assets.
- `proposals.js`, `proposals.css`: only the feature-specific DOM changes and review overlays.
- `reference/`: original renderer snapshots, actual app captures, compiled assets, and sample media.
- `captures/`: seven current baselines, 58 clean proposals, and 58 annotated proposals.
- `specifications/`: one review specification per visual state, plus the unchanged-UI specification for feature 4.
- `tools/start-baseline.ts`, `tools/snapshot.py`: isolated app launch and actual renderer export.
- `tools/capture-benchmarks.py`: repeatable capture and comparison using agent-browser.

The existing gallery service serves this directory tree at port 43871. Re-running static captures needs that service, agent-browser, Python, Pillow, and NumPy. It does not need the isolated app to remain open. Recreating original renderer exports needs a matching build, the repository's isolated Electron fixture, and the explicit Strata theme override. Never use the owner's running app or profile as a fixture.

## Model option contract correction

The numeric maximum-output example was replaced with T3-supported select and boolean controls: Reasoning effort and Fast mode. The invalid state shows an unsupported stored value and prevents saving. The model editor retains the approved layout and uses Strata's existing Switch. This corrects the fixture to the actual provider contract; it does not add a numeric option type or change the saved owner approval.

## Import contract correction

T3 discovers and imports by project folder. The import fixtures now select repository-grouped projects and show explicit destinations. They do not offer unsupported individual-conversation or provider-home filters. Progress counts completed projects and stays indeterminate within a project. The approved Strata dialog and row styling remain the benchmark.

## Defaults and transfer contract corrections

The engine saves the account/model and thinking options together. Defaults retain the approved rows, but the model action now explicitly overrides or resets both; working-copy inheritance remains independent. This avoids presenting a reasoning-only save that the engine does not support.

Browser evidence transfers from Strata's retained local copy to the agent environment. The transfer and failure fixtures now name that direction and use indeterminate progress because the transfer contract reports completion, not a byte percentage. The original local copy remains viewable.

The import confirmation describes bounded recent history: up to 100 conversations per selected project and 200 messages per conversation, subject to the engine's byte limit. Discovered conversation counts are upper estimates, not a promise to import every historical message.

## Skill insertion contract correction

The menu keeps its approved `/name` labels. Selecting a skill inserts T3’s canonical `$name` mention into the draft; the provider adapter resolves that mention to the native invocation when sent. The inserted-state fixture now shows `$agent-browser`, matching the actual contract. Selection still sends nothing.

The actual bundled-engine import smoke confirmed that `importedCount` includes already-present conversations. Completion now says “imported or already present.” Skipped history can be unreadable or unsupported; it is not an unchanged count. Retry preserves conversation identity.
