# UI inventory for the 15 T3 additions

Status: revision 2, awaiting Dillon’s design review. Product implementation has not started.

The [new benchmark guide](v2/benchmark-guide.md) documents real Strata component exports, the default Strata theme, and clean versus highlighted screenshots. Revision 1 is superseded.

The 15 accepted additions fit into 12 connected flows. Strata can reuse its conversation, Projects list, composer, settings dialogs, document tabs, and visual markup. Most of the visible work is extending those parts. The engine performance changes need no new controls.

[Open the interactive gallery](http://127.0.0.1:43871/) · [Read the screenshot guide](review-guide.md) · [Read the original findings](../../reviews/t3-recent-additions-ranked-2026-09-08.md)

The feature numbers below match the first 15 rows of the ranked report. Flow numbers in the gallery identify groups of related screens, so they are a separate sequence.

## What each addition needs

| Feature | Existing Strata parts to reuse | New or changed UI | Mockup flow |
| --- | --- | --- | --- |
| 1. Engine usage reports and quota display | Usage Limits dialog, provider groups, account choice, parking | Remaining quota and reset time, spending pace marker, freshness/error labels, optional combined view, reset-credit confirmation when available | [03 · Usage limits](http://127.0.0.1:43871/?flow=usage&state=accounts) |
| 2. Native async questions and dismissal | Question cards, held answers, Send | “Agent is still working” or “Agent is waiting”; optional-question Dismiss; held, sent, and dismissed history states | [01 · Questions](http://127.0.0.1:43871/?flow=questions&state=asking) |
| 3. Binary attachments | Composer attachment tray, saved drafts, file picker | File cards with type, name, size, local state, remove, preview where supported, and retry | [02 · Files and previews](http://127.0.0.1:43871/?flow=files&state=attached) |
| 4. Engine streaming and replay efficiency | Conversation history, work log, engine status | No performance setting. Preserve the visible conversation and draft during reconnect. Faster replay is behavior to measure during implementation. | [11 · Connection and recovery](http://127.0.0.1:43871/?flow=recovery&state=reconnecting) |
| 5. Continue after engine restart | Engine settings and connection status | Opt-in preference, reconnect banner, confirmed native resume, distinct continuation-message notice, recovery action | [11 · Connection and recovery](http://127.0.0.1:43871/?flow=recovery&state=setting) |
| 6. Compact context on demand | Context meter and work log | Context popover, Compact action, pending state, result divider, retry, unsupported state | [04 · Compact context](http://127.0.0.1:43871/?flow=compact&state=ready) |
| 7. Attach a file to an individual answer | Staged attachments, visual evidence, held answers | Attachment area inside each question, association retained through Hold and Send, attachment error/retry | [01 · Questions](http://127.0.0.1:43871/?flow=questions&state=held) |
| 8. Reliable browser evidence | Transcript attachments, browser preview, markup | Saved screenshot card, recording transfer state, named transfer failure, retry, preview details | [09 · Browser evidence](http://127.0.0.1:43871/?flow=evidence&state=saved) |
| 9. Searchable commands and skills | Composer and provider-reported capabilities | Slash menu, grouped results, descriptions, keyboard selection, empty result, inserted skill token | [05 · Commands and skills](http://127.0.0.1:43871/?flow=skills&state=menu) |
| 10. Shared project defaults and overrides | Settings dialog, existing conversation options, conflict-aware saves | Computer/project selector, effective value with its origin, project override, reset to inheritance, conflict notice | [07 · Project defaults](http://127.0.0.1:43871/?flow=defaults&state=project) |
| 11. Unsent draft markers | Saved composer drafts and Projects rows | Small pen marker independent of work status, return to saved draft, scoped discard confirmation | [06 · Draft markers](http://127.0.0.1:43871/?flow=drafts&state=markers) |
| 12. Import native conversations | Project navigation, account identities, setup-dialog layout | Import entry point, source selection, grouped conversation selection, review, progress, partial retry, completion | [08 · Import conversations](http://127.0.0.1:43871/?flow=import&state=sources) |
| 13. PDF and HTML previews | Document tabs, preview frame, attachment cards | Read-only viewer, PDF page/zoom controls, HTML Preview/Source, file metadata and missing-file recovery | [02 · Files and previews](http://127.0.0.1:43871/?flow=files&state=pdf) |
| 14. External-window capture | Visual markup, held comments, image attachments | Opt-in settings, shortcut assignment, platform permission explanation, native picker handoff, capture identity, mark/review/hold, screenshot-only fallback | [10 · Window capture](http://127.0.0.1:43871/?flow=capture&state=review) |
| 15. Custom model names and options | Provider Models dialog, favorites/visibility, composer controls | Name and provider-ID fields, live name preview, supported option controls, validation, preserved-settings disclosure | [12 · Custom models](http://127.0.0.1:43871/?flow=models&state=edit) |

## Shared component decisions

These are the visual and interaction decisions proposed for approval. They are not implementation instructions yet.

### One private staging pattern

Questions, message attachments, visual comments, and external captures all use the same progression. Prepare the item, hold it, then deliver it with Send. A compact summary above the composer tells you what will go with the message.

An answer’s files stay attached to that answer. Removing a message draft does not remove separate held comments or answers. Attachment-only answers should be allowed when supported, even though the primary mockup uses a written answer and an image together.

The attachment card needs one shared layout for name, file type, size, local preparation, transfer failure, and preview. The displayed names and sizes are sample content. Actual count and size limits must come from Strata’s attachment policy and the connected engine, with generated document context included in the count.

### Question status belongs beside the question

An optional async question says the agent is still working and has Dismiss. A blocking question says the agent is waiting and has no Dismiss. Hold answer keeps the existing Strata workflow, and Send delivers it.

A dismissed question remains understandable in history. It does not look like an answered question, and it must not start a new turn. Native questions retain their identity so prose detection does not duplicate them.

### File viewers use the current tab arrangement

PDF and HTML open as read-only documents with a return path to the conversation draft. PDF has page and zoom controls. HTML has Preview and Source. Markdown retains its existing editing behavior.

The proposed HTML document preview is static. The mockup specifies scripts disabled and external requests blocked. A live website continues to use the browser. This policy is a design proposal for approval, not a claim that the current viewer already implements it.

The PDF page is a layout fixture. The HTML and saved browser image use the same local sample page loaded by the isolated Strata app. These demonstrate proposed controls; they do not exercise a production PDF implementation or HTML isolation policy.

### Usage starts with individual accounts

Keep account choice and parking in the existing dialog. Show remaining quota more prominently than used quota. Reset time and freshness belong beside the data. A failed refresh keeps the previous reading with an explicit age; absent provider data says “not reported.”

Combined quota is an optional average of account percentages. It must not imply that account limits are interchangeable tokens. Reset credits appear only when reported as available and require an explicit redemption confirmation.

The latest pooling and credit behaviors have their own upstream dependencies. Including their designs now does not imply that every part is in Strata’s bundled engine.

### Defaults show what wins

Each setting shows both its current value and where it comes from. A project exception is labeled as an override and has a reset action. Changes affect new conversations; existing conversations retain their choices.

The mockup covers model, reasoning effort, and working copy because those affect Strata work today. It does not add a project automation editor. A save conflict keeps the proposed changes available and offers a review of current settings.

### Import is an explicit, bounded action

“Import existing work” lives in Projects. The flow shows which local account homes will be read, which conversations were found, where they will appear, and the result for each one.

Import copies history without starting an agent. Already imported conversations are skipped on retry. Continuing an imported conversation is a later deliberate action, subject to account and provider support. Continuous synchronization with another agent app is outside this addition.

### Captures arrive in review

Capture starts off. The user selects a window through the platform’s picker, reviews the resulting screenshot, adds a note or markup, and holds it for Send. Optional app text has its own setting and can fail without losing the image.

The window-choice mockup represents the native picker handoff. It is not a proposed replacement for macOS, Windows, or Linux system UI. The macOS permission screen is one platform-specific example. Linux and Windows need their own capability and permission handling during implementation. Shortcut availability must follow the actual desktop environment.

### Recovery describes what actually happened

Restart continuation starts off. A reconnect state keeps history and the draft in place. Success appears only after engine confirmation.

The two successful outcomes are separate. A native session resumes, or Strata sends a continuation message that starts another provider turn. The latter appears in history with its origin. A failed resume leaves an explicit Continue action. Engine efficiency changes add no configuration panel.

### Models preserve compatibility

Display name and provider model ID are separate fields. Supported options come from the provider. Strata must keep structured settings and unknown options that another client saved, even when Strata cannot edit them.

The model IDs and options in the mockup are illustrative. The implementation must populate the editor from actual provider capabilities.

## Screen-state coverage

| Flow | States available in the gallery | Review status |
| --- | --- | --- |
| 01. Questions | Working while asked; answer held; answer sent; dismissed; blocking; attachment failed | Pending |
| 02. Files and previews | Draft attachments; PDF; HTML preview; HTML source; missing file; send failed | Pending |
| 03. Usage limits | Individual accounts; combined; stale data; unavailable data; credit confirmation | Pending |
| 04. Compact context | Ready; compacting; completed; failed; unsupported | Pending |
| 05. Commands and skills | Menu; filtered results; inserted token; no match | Pending |
| 06. Draft markers | Sidebar markers; reopened draft; discard confirmation | Pending |
| 07. Project defaults | Computer; inherited project; override; concurrent change conflict | Pending |
| 08. Import conversations | Sources; selection; confirmation; progress; partial failure; complete | Pending |
| 09. Browser evidence | Saved screenshot; recording transfer; transfer failure; preview | Pending |
| 10. Window capture | Settings; macOS permission; picker handoff; marked review; image-only fallback; held | Pending |
| 11. Connection and recovery | Preference; reconnecting; native resume; continuation message; failed resume | Pending |
| 12. Custom models | Model list; details; supported options; invalid value | Pending |

All 58 screen states can be selected directly. Waiting states stay still so they can be reviewed. Use the state buttons to inspect the corresponding success or failure outcome. Forms and key actions simulate the connected flow; no engine, provider, native capture, or project data is touched.

## Basis and boundaries

The source basis is the [September 8 research report](../../reviews/t3-recent-additions-ranked-2026-09-08.md) and its linked T3 changes. The visual basis is current Strata at `f461fe9ff3daf018700df3caa4aefa985cac7de0`, including its bundled themes, fonts, frameless window layout, composer, provider question cards, Provider Models dialog, and preview arrangements.

The main reuse points are [Conversation](../../../src/renderer/components/Conversation.tsx), [ConversationComposer](../../../src/renderer/components/ConversationComposer.tsx), [ProjectsPanel](../../../src/renderer/components/ProjectsPanel.tsx), [ProviderModels](../../../src/renderer/components/ProviderModels.tsx), [ConnectSetup](../../../src/renderer/components/ConnectSetup.tsx), and [PreviewWindow](../../../src/renderer/components/PreviewWindow.tsx). The gallery copies fonts, brand assets, and color values into its own folder. It does not import or alter the running application.

This review approves appearance and behavior. Implementation sequencing, engine version selection, native platform work, data migration, and product verification follow after all mockups are approved. Features 7, 8, and 14, plus some refinements under 1 and 2, depend on work after the stable release inspected in the report.
