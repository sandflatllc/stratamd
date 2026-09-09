# Recent T3 additions ranked for Strata

September 8, 2026. Research only. No application changes.

The best opportunities are server-reported usage limits, native asynchronous questions, proper PDF and other binary attachments, and the recent engine performance and recovery work. These improve the work Strata already exists to support. Window capture and importing existing agent conversations are the most interesting larger additions.

## Scope and evidence

I reviewed the release notes for T3 0.0.33 through 0.0.40, covering releases from August 10 through September 8, with most attention on changes after Strata's bundled 0.0.38. I also reviewed the 72 commits between 0.0.40 and the captured upstream head, inspected 39 pull requests in detail, and read the relevant T3 and Strata source.

The latest stable release at inspection was [0.0.40](https://github.com/pingdotgg/t3code/releases/tag/v0.0.40). The large preceding release was [0.0.39](https://github.com/pingdotgg/t3code/releases/tag/v0.0.39). Upstream source was captured at [08463e2c](https://github.com/pingdotgg/t3code/tree/08463e2c401ce87858aaaebcb70ed86fb002fb5f), committed September 9 at 02:27 UTC, still September 8 in Arizona. “After stable” below means merged after the 0.0.40 tag, not necessarily included in a published nightly.

Strata was inspected at `f461fe9ff3daf018700df3caa4aefa985cac7de0` on master. Its [engine package](../../packaging/engine/package.json) pins T3 0.0.38. Its current source includes a connection wizard and recent conversation improvements that older design and review documents do not describe. The comparison uses current source when those disagree.

This is a source-based assessment, not a compatibility certification or a hands-on comparison of both running apps. Upstream validation and benchmarks are identified as upstream reports. I did not run product tests, restart either app, or change the engine. The [source manifest](t3-recent-additions-ranked-2026-09-08.sources.json) records the inspected revisions and detailed PR references.

## How the scores work

Each dimension runs from 1 to 5, with 5 best:

- **Codebase:** less duplicate responsibility, better correctness, lower resource use, or simpler maintenance in Strata and its bundled engine.
- **User:** improvement to Dillon's regular workflow in Strata.
- **Capability:** useful work Strata cannot currently support, or supports only partially.
- **Ease:** 5 is a small local change; 4 reuses established paths; 3 crosses several application layers; 2 requires substantial integration; 1 changes a foundational product assumption.

The overall score is the equal-weight average. Ties are ordered by fit with Strata's document and agent workflow. These are engineering judgments, not measured gains. Ease includes adaptation and relevant verification, but a shared engine upgrade is one prerequisite, not a separate upgrade for every row. Small score differences should not decide implementation order on their own.

## Ranked opportunities

| Rank | Addition to Strata | Codebase | User | Capability | Ease | Average | T3 availability |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | Server-reported usage limits and better quota display | 5 | 5 | 4 | 3 | 4.25 | 0.0.39 |
| 2 | Native async questions and dismiss without answering | 4 | 5 | 5 | 3 | 4.25 | 0.0.39 |
| 3 | Proper PDF, ZIP, and other binary attachments | 4 | 5 | 5 | 3 | 4.25 | Server 0.0.36; UI 0.0.37 |
| 4 | Engine streaming, replay, and terminal efficiency | 5 | 5 | 2 | 4 | 4.00 | 0.0.39; further fixes after stable |
| 5 | Continue active work after engine restart | 4 | 5 | 4 | 3 | 4.00 | 0.0.39; opt-in |
| 6 | Compact conversation context on demand | 3 | 5 | 4 | 4 | 4.00 | 0.0.39 |
| 7 | Attach screenshots and files to individual answers | 3 | 5 | 5 | 3 | 4.00 | After stable |
| 8 | More reliable browser evidence for agents | 4 | 4 | 4 | 3 | 3.75 | After stable |
| 9 | Searchable commands and skills in the composer | 2 | 5 | 4 | 4 | 3.75 | 0.0.34 |
| 10 | Shared project defaults with explicit overrides | 4 | 4 | 4 | 3 | 3.75 | 0.0.39 |
| 11 | Visible unsent-draft markers | 2 | 5 | 2 | 5 | 3.50 | 0.0.39 |
| 12 | Discover projects and import native agent history | 3 | 4 | 5 | 2 | 3.50 | 0.0.39; refined in 0.0.40 |
| 13 | Render PDF and HTML attachments in the app | 3 | 4 | 4 | 3 | 3.50 | 0.0.39 |
| 14 | Capture another app's window as agent context | 3 | 4 | 5 | 2 | 3.50 | After stable |
| 15 | Rich custom-model names and option controls | 4 | 3 | 4 | 3 | 3.50 | 0.0.39 |
| 16 | Drop files directly onto a conversation | 2 | 4 | 3 | 4 | 3.25 | After stable |
| 17 | Recall prompts and step through conversation turns | 1 | 4 | 3 | 5 | 3.25 | 0.0.39; navigation after stable |
| 18 | Upload while composing and accept HEIC photos | 3 | 4 | 3 | 3 | 3.25 | 0.0.34 |
| 19 | Browser profiles and optional cookie import | 3 | 4 | 4 | 2 | 3.25 | 0.0.39 |
| 20 | Explain provider failures with the recovery action | 3 | 4 | 2 | 4 | 3.25 | Claude 0.0.39; Codex after stable |
| 21 | Persist a manual order for active conversations | 2 | 4 | 3 | 3 | 3.00 | 0.0.39 |
| 22 | Reuse one layout for setup wizards | 5 | 3 | 1 | 3 | 3.00 | After stable |
| 23 | Keep composer controls and panels still | 2 | 4 | 1 | 5 | 3.00 | 0.0.39–0.0.40; further fixes after stable |
| 24 | Add Google Antigravity as another provider | 2 | 3 | 5 | 2 | 3.00 | 0.0.39 |
| 25 | Distribute new conversations across computers | 3 | 3 | 5 | 1 | 3.00 | 0.0.39; opt-in |
| 26 | Offer the completed turn's changes automatically | 2 | 3 | 3 | 3 | 2.75 | 0.0.39; refined after stable |
| 27 | Inline citations back to assistant passages | 2 | 3 | 2 | 3 | 2.50 | 0.0.39 |
| 28 | Full pull-request listing and review | 3 | 2 | 4 | 1 | 2.50 | 0.0.34 and later |
| 29 | Automatically pull a clean default branch | 2 | 2 | 2 | 3 | 2.25 | 0.0.39; opt-in |

## What each addition would mean

### 1. Let the engine own usage measurement

T3 now reports typed subscription windows for Codex and Claude through provider configuration. Its UI shows remaining quota, reset countdowns, and whether consumption is ahead of the window's elapsed time. Later additions combine the same account across environments, pool account windows, and support available reset credits. A pooled percentage is a convenience summary with equal account contributions, not a measured pool of interchangeable tokens. [Provider limits](https://github.com/pingdotgg/t3code/pull/9507), [remaining quota](https://github.com/pingdotgg/t3code/pull/9889), [pooling](https://github.com/pingdotgg/t3code/pull/10300).

Strata already has a useful Usage Limits dialog and account selection rules. The missing improvement is who collects the measurements. [local-usage.ts](../../src/main/engine/local-usage.ts) launches [usage.mjs](../../resources/engine-helpers/usage.mjs), while [accounts.ts](../../src/main/engine/accounts.ts) builds account views from those readings. Its current adapter does not consume the new `usageLimits` field.

I would map the upstream report into Strata's existing account model, preserve parking and account selection, and use the local helper only for older engines if compatibility requires it. That can remove provider-specific process management and make remote-engine limits possible. Quota remaining and spending pace are the first UI additions; pooling and reset redemption can follow separately.

### 2. Treat native async questions as their own workflow

T3 added support for questions emitted while Codex continues working. Answers become user messages during the run or resume the session later. Pending questions survive reconnects. A later command dismisses an async question without sending a message or starting a turn. Blocking provider questions cannot use that dismissal. [Async questions](https://github.com/pingdotgg/t3code/pull/9512), [dismissal](https://github.com/pingdotgg/t3code/pull/10431).

Strata already displays provider questions, holds answers for Send, and extracts questions from prose. Those are useful starting points. However, [UserInputCard](../../src/renderer/components/Conversation.tsx) does not distinguish the response mode, and the [engine contract](../../src/main/engine/t3-contract.ts) has no native dismissal command.

Add the native distinction to the existing question cards, preserve Hold and Send, and show Dismiss only when the engine permits it. Native questions should retain their engine identity so they do not create duplicate inferred items. This complements prose detection; it does not replace questions found in ordinary replies.

### 3. Preserve PDFs and other binary files as files

T3 added general uploads up to 50 MB and a composer path for PDFs, ZIP archives, and other files before Strata's pinned server release. The backend support is therefore already inside the bundled version. [Server uploads](https://github.com/pingdotgg/t3code/pull/8235), [composer support](https://github.com/pingdotgg/t3code/pull/8236).

Strata's [attachment classifier](../../src/core/composer-attachments.ts) currently has image and text paths. Non-image files go down the text path, and the [composer](../../src/renderer/components/ConversationComposer.tsx) reads those with `file.text()`. That is not a byte-preserving route for a PDF or ZIP. The normal picker is narrower, but widening its accepted extensions alone would be insufficient.

Add a binary attachment type with durable staging, original MIME type, byte-preserving upload, and appropriate limits. This would let Dillon hand over an actual report, export, or archive. Provider access to the saved file is distinct from whether that provider can interpret its contents. Keep Strata's generated context attachment in the attachment budget.

### 4. Take the engine's incremental processing improvements

T3 changed summary updates to avoid reading old message bodies, made activity appends incremental, restricted reconnect replay to the selected thread, and reduced terminal history rebuilding and retention. These are engine benefits Strata can inherit without adopting T3's React UI. [Incremental updates](https://github.com/pingdotgg/t3code/pull/9152), [summary queries](https://github.com/pingdotgg/t3code/pull/9662), [thread replay](https://github.com/pingdotgg/t3code/pull/9726), [terminal byte bounds](https://github.com/pingdotgg/t3code/pull/9748).

The thread-replay PR reports a fixture going from 600 decoded events to 6 and a median 21.6 ms to 0.9 ms. That is upstream benchmark evidence, not a Strata speed estimate.

Do not count T3's client-runtime optimizations as automatically inherited. Strata has its own [subscription handling](../../src/main/engine/client.ts), and it already closes unfollowed thread streams. Its [conversation renderer](../../src/renderer/components/ConversationMessage.tsx) also has its own retained-editor system. Port a frontend optimization only after finding the same remaining cost locally.

One later change fixes consumed replay pages staying in memory during startup cleanup. The reported failure concerned nightly 1400 and a very large event history. It does not establish that 0.0.40 has that same failure. [Replay-page fix](https://github.com/pingdotgg/t3code/pull/10777).

### 5. Resume work after a restart

T3's opt-in restart continuation restores supported sessions and otherwise starts a continuation message. Follow-up fixes preserve resumability when provider state has an older turn identifier. [Continuation](https://github.com/pingdotgg/t3code/pull/9167), [recovery fixes](https://github.com/pingdotgg/t3code/pull/10421).

Strata's [engine manager](../../src/main/engine/manager.ts) already backs up, stages, and recovers its managed engine, but its maintenance flow expects active conversations to finish. The new behavior would need an explicit preference and integration with that lifecycle. Merely updating the engine package does not enable it; upstream defaults the preference off.

The user benefit is returning to running work after an engine or computer restart. Verification must include held answers, pending document deliveries, completed turns, and interrupted tools so recovery does not duplicate a send. Native resume and a newly submitted continuation are different behaviors and should be visible as such.

### 6. Compact context deliberately

T3 added a shared Compact context action for supported providers, with progress, completion, and before/after token counts when available. Providers use their own compaction route. [Provider support](https://github.com/pingdotgg/t3code/pull/8808), [composer command](https://github.com/pingdotgg/t3code/pull/9293).

Strata already shows a context-fill ring and some automatic-compaction information. It lacks the explicit action. Add Compact beside that ring, use the engine's capability report, and display its result. This is useful during long document and research sessions, with relatively little new UI. It summarizes model context; it should not erase the visible conversation or Strata's document history.

### 7. Answer with a file or screenshot

The new question-answer flow accepts attachments per question, including attachment-only answers. It persists drafts and retains the submitted files in history. [Question attachments](https://github.com/pingdotgg/t3code/pull/9871).

This is especially relevant to Strata. An agent can ask which visual treatment to use, and Dillon can answer with a marked screenshot in that question. Today Strata's provider-answer form is text-only; images go through the general composer instead.

Reuse Strata's staged attachments and visual evidence, but preserve the question-to-file association through Hold, Send, retry, and history. This depends on newer server contracts and should follow the general binary attachment work. It was merged after stable 0.0.40.

### 8. Make agent browser evidence usable and reachable

T3 bounded textual browser snapshots, fixed non-object evaluate results, added screenshot saving, and transferred finished browser recordings to the agent's environment. Those changes address two concrete problems: oversized tool output losing its useful locators, and a remote agent receiving a path that exists only on the desktop. [Snapshot fixes](https://github.com/pingdotgg/t3code/pull/10501), [recording transfer](https://github.com/pingdotgg/t3code/pull/10572).

Strata already has browser automation and visual evidence. Its [preview host](../../src/main/preview/host.ts) implements the desktop side independently, so server updates do not provide every desktop feature. Adopt the bounded result and verified file-location behavior first. Recording would need its own host support. For a remote engine, a server-local screenshot path also needs a deliberate route back to Strata before its document renderer can display it.

### 9. Discover skills through the composer

T3's slash menu includes enabled skills as well as commands, while inserting the provider's canonical skill token. [Skill discovery](https://github.com/pingdotgg/t3code/pull/7737).

Strata's composer is a textarea with model, access, and attachment controls; it does not expose this discovery menu. The server already reports commands and skills, so a searchable menu can use authoritative names instead of maintaining another local catalog. This would make existing capabilities much easier to find. It also gives Compact context a discoverable home.

### 10. Set project behavior once, then override it explicitly

T3 now has machine defaults and scoped project or checkout overrides, with reset restoring inheritance. The work also consolidated repeated action-setting persistence. [Project defaults](https://github.com/pingdotgg/t3code/pull/9754).

Strata already has global engine settings and remembered project model choices. It does not expose the same inherited settings hierarchy. Borrow the effective-value and reset behavior for settings Strata actually uses. A full project-actions editor would be a separate expansion. Keep existing conflict-aware settings saves rather than replacing them with blind whole-object writes.

### 11. Make unfinished drafts visible

T3 marks background threads with unsent drafts and offers draft removal without opening the conversation. Its row subscribes to a boolean, so ordinary typing does not redraw every sidebar row. [Draft markers](https://github.com/pingdotgg/t3code/pull/9658).

Strata already persists drafts in [conversationDrafts.ts](../../src/renderer/conversationDrafts.ts), including delayed storage writes. [ProjectsPanel](../../src/renderer/components/ProjectsPanel.tsx) has no equivalent unsent-composer marker. Add a small marker without replacing Working or Needs input. This is the clearest small improvement in the list. If discarding is added, keep held document comments and visual comments separate from plain composer text.

### 12. Bring existing agent conversations into Strata

T3's first-run setup scans configured Codex and Claude homes, discovers projects, and imports recent native history without starting a provider turn. Retry skips previously completed imports. The 0.0.40 refinement groups project import by repository. [Welcome and import](https://github.com/pingdotgg/t3code/pull/5362), [repository grouping](https://github.com/pingdotgg/t3code/pull/10493).

Strata can already add projects and install or authenticate providers, but it has no comparable native-history import flow. The valuable addition is a bounded Import existing work action, with source and destination made clear. Upstream describes this as first-run import; continuing to synchronize outside conversations and safe handoff between writers remain separate work. Do not promise live sync or unrestricted continuation between accounts.

### 13. Read PDF and HTML outputs in Strata

T3 renders PDF and HTML through signed asset URLs. HTML uses an isolated frame and offers a source view; sent document attachments can open the viewer. [File rendering](https://github.com/pingdotgg/t3code/pull/9143), [attachment preview](https://github.com/pingdotgg/t3code/pull/9292).

Strata already has Markdown reading, local images, and a live browser. A read-only document viewer would cover PDFs and exported HTML without pretending they are editable Markdown. Reuse the existing tab and preview arrangements. HTML opened this way needs the isolation policy from the file-viewer design, not the ordinary Markdown renderer. This pairs naturally with binary attachments.

### 14. Capture an external app directly

T3's new window capture is opt-in, supports macOS, Windows, and Linux Wayland, and carries app/window identity plus accessibility text when available. Native extraction failures fall back to the screenshot. Wayland shortcuts and permission handling differ from macOS. [Window capture](https://github.com/pingdotgg/t3code/pull/8103).

Strata can annotate its own preview and imported images. It cannot initiate this cross-app capture. A capture could enter the existing markup-and-hold workflow, which makes this a strong product fit. The expensive work is native capture, shortcuts, permissions, and packaging on Strata's supported platforms. The upstream patch touches 207 files, which illustrates the breadth rather than predicting Strata's eventual patch size. Verify the actual Linux display session before choosing an implementation.

### 15. Keep custom-model configuration compatible

T3 added custom display names and editable option descriptors. Existing slug-only settings remain supported, and only options the provider understands affect turns. [Custom models](https://github.com/pingdotgg/t3code/pull/9807).

Strata already renders reported option descriptors, but its [custom-model editor](../../src/renderer/components/ProviderModels.tsx) preserves only string entries when adding another model. That needs attention before editing richer upstream configuration. Preserve structured entries first, then expose useful names and supported controls. Custom pricing, added separately in T3, is a lower-priority extension to Strata's existing estimates.

### 16. Drop a file onto the intended conversation

T3 now lets a file drop on a sidebar thread open that thread and stage its attachments. It does not send automatically. [Sidebar drops](https://github.com/pingdotgg/t3code/pull/7892).

Strata already has attachment staging and project navigation, so these can meet in a small interaction. Keep a dropped file bound to the selected destination through navigation and failure. Build this on the corrected attachment classifier, so dropping a PDF does not take the text path.

### 17. Reuse prompts and navigate by turn

T3 recalls earlier user prompts with Up in an empty composer and moves forward with Down. It derives history from messages and strips context the app added at send time. It also added previous/next controls to the conversation minimap. [Prompt recall](https://github.com/pingdotgg/t3code/pull/9173), [turn controls](https://github.com/pingdotgg/t3code/pull/8531).

Strata already has a conversation navigator with keyboard movement between markers. The useful delta is explicit previous/next activation and prompt recall. Preserve the text Dillon actually wrote, excluding generated document context and held-comment payloads. Normal multiline editing must keep its current arrow-key behavior.

### 18. Prepare uploads before Send

T3 uploads images while composing, preserves compatibility with older clients, and added HEIC-to-JPEG conversion. [Early uploads](https://github.com/pingdotgg/t3code/pull/8048), [HEIC support](https://github.com/pingdotgg/t3code/pull/8161).

Strata already stages images durably on the local machine, but uploads them while executing a prepared send. Early upload could make Send feel faster on remote engines. It also changes where an unsent file lives, so it must be reconciled with Strata's private-draft promise and use storage unavailable to agents until delivery. HEIC conversion is independently useful for iPhone images. Keep conversion, local staging, upload, and actual delivery distinct.

### 19. Use separate browser identities

T3 added persistent named browser profiles, an in-memory incognito profile, and optional cookie import from supported browsers. [Profiles](https://github.com/pingdotgg/t3code/pull/7254), [cookie import](https://github.com/pingdotgg/t3code/pull/7255).

Strata currently scopes browser storage by working folder in [tabs.ts](../../src/main/preview/tabs.ts). Named profiles would support reviewing the same site as different users or keeping a clean test session. Cookie import adds native credential-store and cleanup complexity. I would implement named and temporary profiles first, then evaluate importing login state separately.

### 20. Say which limit or login failed

Recent T3 fixes distinguish expired Claude login and usage limits, and give Codex limit failures a reset and next action when known. [Claude errors](https://github.com/pingdotgg/t3code/pull/10321), [Codex errors](https://github.com/pingdotgg/t3code/pull/10473).

Much of this benefit should arrive through the engine's normal error events. Strata's job is to preserve that explanation and connect it to account refresh, sign-in, or retry. Keep expandable diagnostic detail, while the first line answers what happened and what Dillon can do next. Avoid a second provider-error parser in Strata.

### 21. Arrange active conversations manually

T3 added persisted active-thread order keys without changing activity timestamps. Pinning and snoozing preserve the saved position; settling clears it. [Ordering contract](https://github.com/pingdotgg/t3code/pull/9729), [dragging UI](https://github.com/pingdotgg/t3code/pull/9731).

Strata reorders project folders, pins conversations, and sorts them by recent activity, age, or name. It lacks manual ordering inside the active conversation list. Reuse the server's command and advertised capability. Local-only ordering would disagree with the phone or another T3 client. Preserve the distinction between moving a row and moving its underlying work.

### 22. Share setup layout without merging setup behavior

T3 consolidated repeated wizard headers, progress steps, bodies, and footers into shared components. Each caller still owns validation and navigation. [Wizard consolidation](https://github.com/pingdotgg/t3code/pull/10832).

Strata has separate Add project, Provider setup, and Connect flows. A small shared layout could reduce repeated styling and make Back, Cancel, and Continue predictable. Keep it limited to patterns genuinely repeated in those dialogs. T3's components depend on its own UI stack, so borrow the responsibility split rather than transplanting the imports. The high codebase score describes the potential maintenance payoff, not a measured local deletion count.

### 23. Borrow the principle of controls staying put

T3 fixed controls shifting during composer transitions, stopped composer collapse on blur, and later reserved footer space while thread data loads. [Toolbar positioning](https://github.com/pingdotgg/t3code/pull/10478), [collapse behavior](https://github.com/pingdotgg/t3code/pull/10437), [footer loading](https://github.com/pingdotgg/t3code/pull/10768).

Strata does not use T3's collapsing composer. Do not import that machinery. Inspect its own loading states for moving targets and reserve space only where a real shift occurs. This is a set of useful UI acceptance criteria, not evidence that every reported T3 defect exists in Strata.

### 24. Add another provider only when it serves actual work

T3 added Google Antigravity through Google's ACP executable, with guided installation and authentication. It is disabled by default. [Antigravity integration](https://github.com/pingdotgg/t3code/pull/9348).

A newer engine supplies the adapter, but Strata's family selection and guided installation are built around its current providers. Supporting Antigravity requires deliberate installation, authentication, model-selection, and continuation behavior. It adds real capability; its user score depends on Dillon wanting to use that account. It should follow the provider-contract cleanup rather than lead it.

### 25. Route new work across computers

T3 can automatically choose a connected machine using CPU and available memory, with per-machine preferences. The option defaults off. Manually choosing a machine, branch, or worktree pins the draft, and existing threads keep their machine. This is host-load balancing, not subscription-quota balancing. [Machine balancing](https://github.com/pingdotgg/t3code/pull/9895).

Strata currently selects one engine. Supporting several simultaneously affects document paths, preview hosting, account identity, delivery, and thread ownership. Automatic routing would also need a clear answer for where a document lives. This is a product expansion with a much higher cost than adding the upstream toggle.

### 26. Offer the result of completed work

T3's opt-in proactive panels reveal linked pull requests and completed-turn diffs. [Proactive panels](https://github.com/pingdotgg/t3code/pull/9276).

Strata already has pending changes and document review. The useful adaptation is a relevant review invitation for a newly completed turn, not automatically replacing the document Dillon is editing. A later upstream change opens proactive panels on entering threads, so preserve Strata's own focus rules instead of relying on the first PR's behavior description. [Entry behavior](https://github.com/pingdotgg/t3code/pull/10610).

### 27. Make quoted passages navigable

T3 introduced inline citation chips that retain a connection to the selected assistant passage and navigate back to it. [Assistant citations](https://github.com/pingdotgg/t3code/pull/9146).

Strata already has anchored passage comments, held replies, and navigation back to their source. The remaining benefit is the inline composer presentation and clearer navigation from sent quotes. Integrate that with existing identities and anchors. A second citation-storage system would add more maintenance than capability.

### 28. A complete pull-request client is a larger product choice

T3 added multi-provider pull-request listing, review, line requests sent to agents, labels, and richer details. [PR review](https://github.com/pingdotgg/t3code/pull/4849), [line requests](https://github.com/pingdotgg/t3code/pull/6597).

Strata has read-only code diffs and is centered on documents. Selected ideas, such as sending a comment on a changed line to the responsible agent, fit that purpose. A full review and merge client brings much more account, repository, and Git state. I would adopt narrow review actions before a dedicated PR section.

### 29. Automatic Git updates are a weak fit here

T3 can optionally fast-forward clean default branches during startup and background refresh. It checks for local changes and local commits before pulling. [Automatic pull](https://github.com/pingdotgg/t3code/pull/9277).

This is useful in some coding workflows, but has lower value for Dillon's document-review workflow and changes files outside a deliberate review action. Leave it opt-in if Strata ever exposes it. It is separate from the owner's rule about keeping the main checkout on its existing branch.

## Features I would not count as new Strata work

| Recent T3 theme | What Strata already has | Remaining opportunity |
| --- | --- | --- |
| Guided connections | Current Connect setup has browser sign-in, code fallback, download consent, combined settings, computer name, and device handoff | Verify the hosted journey and simplify any remaining rough steps; do not build the old proposal again |
| Provider and model setup | Provider list/editor, installation, account controls, favorites, hidden models, option descriptors | Richer custom-model preservation and authoritative server limits |
| Durable composer drafts | Persisted text, settings, staged images, and coalesced writes | Make background drafts visible and extend staging to binary files |
| Working copies | Existing or new worktree selection and branch information | Shared defaults or manual thread order if useful |
| Subagent visibility | Agent activity, background liveness, and agent detail controls | Check new provider-event compatibility when upgrading |
| Usage insights | Token and cost views, stale-data handling, subscription limits, account choice | New measurement source, pace, optional pooling |
| Conversation navigation | Retained reading state, message markers, anchored comments | Prompt recall and small navigation controls |
| Visual review | Browser automation, screenshots, markup, held visual comments, before/after evidence | External-window capture, binary document preview, evidence transfer |

These conclusions come from the current [PRD](../PRD.md), [Connect setup](../../src/renderer/components/ConnectSetup.tsx), [composer drafts](../../src/renderer/conversationDrafts.ts), [account views](../../src/main/engine/accounts.ts), [agent activity](../../src/core/agent-activity.ts), and [preview host](../../src/main/preview/host.ts).

T3 also added offline iPhone voice input, mobile file sharing and previews, pending-message visibility, and notification improvements. They matter when using T3 mobile with Strata's engine, but do not create a Strata phone editor. Dillon's existing desktop dictation makes the iPhone-only implementation less useful as a direct desktop port. [Voice input](https://github.com/pingdotgg/t3code/pull/8614), [pending messages](https://github.com/pingdotgg/t3code/pull/10449), [waiting-agent notification priority](https://github.com/pingdotgg/t3code/pull/10848).

The normalized per-turn token work is also interesting, but its PR describes an analytics event rather than a ready-made local reporting API. Strata has an explicit no-telemetry requirement. Borrow the normalization only if a local feature needs it. [Turn usage measurement](https://github.com/pingdotgg/t3code/pull/9132).

## Recommended sequence

First, make the engine update and its contract adaptation concrete. Use a released version as the baseline, test snapshots and stream parsing, and check provider configuration, resume behavior, attachments, and preview automation against the real server. Two known adaptation points are the new usage-limit report and structured custom-model entries. Keep Strata's existing backup and rollback path. Later commits should be selected for a named need, with their dependencies understood.

Alongside that work, binary attachments and unsent-draft markers offer useful improvements on the existing engine. The server already supports general file uploads, and the draft marker uses existing local state.

Then build the owner-facing improvements around engine capabilities: usage reporting, async question handling, Compact context, and searchable skills. Add question attachments once that server contract is in the selected release. Preserve Strata's private Hold-and-Send behavior throughout.

After those changes, choose one larger addition. I recommend external-window capture if the priority is richer visual review, or native-history import if the priority is bringing existing work into Strata. Both have more direct value than multi-computer balancing or a full PR client.

For the individual dimensions, the strongest codebase opportunities are upstream usage ownership and engine efficiency. The strongest user improvements are async questions, real file attachments, and visible drafts. The largest new capabilities are native-history import and external-window capture. The easiest additions are draft markers, prompt recall, and explicit turn navigation.
