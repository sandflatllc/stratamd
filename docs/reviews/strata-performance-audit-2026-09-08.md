# Strata performance audit

September 8, 2026. Audited checkout `00fbeeae16d5327a9ef9c0c1b973e30699f7243e`.

Strata has several independent performance problems. The strongest findings are unnecessary comment rendering, conversation updates that carry and redraw too much history, expensive table updates, repeated startup verification, and work that grows with accumulated annotations and cached messages. These offer substantial room for improvement without removing features or changing the appearance.

I recommend starting with comment rendering, table invalidation, and conversation update delivery. They affect ordinary interaction and have measured evidence. Startup and annotation processing should follow in the same optimization effort. Memory, background work, and a repaired performance lab complete the work; fixing the example symptoms alone would leave those problems behind.

The owner's checkout and installed app were not changed. Two small experiments ran in a disposable copy, then that copy's product source and build were restored. They demonstrate opportunities, not finished fixes.

## What was measured

| Workload | Result | What it establishes |
|---|---|---|
| Long comment draft, no earlier replies | 23 ms median input-to-frame estimate | The text field can respond promptly |
| Same draft, 20 earlier formatted replies | 54 ms median, 75 ms p95 | Discussion size affects typing |
| Same draft, 80 earlier formatted replies | 192 ms median, 202 ms p95 | A large discussion causes sustained input stalls |
| Arrow repeat in a 100-exchange conversation | 32 ms median without server updates; 74 ms with updates | Background conversation work delays cursor feedback |
| Mixed 100 KB document, 40 traced keystrokes | 40 ms median estimated keydown-to-paint; 51 ms p95; 116 ms maximum | Document typing also has spikes |
| Table-heavy 100 KB document, workflow test | 2.2 s measured typing action; 9.5 s external edit-to-review | Table-heavy documents are a separate serious bottleneck |
| Switch to a 100 KB document with five or ten documents open | About 1.3 s | Document switching needs attention too |
| Bundled server, fresh disposable installation | Editor usable in 0.85 s; connected in 5.80 s | Window readiness and server readiness are different delays |
| Bundled server, relaunch of that installation | Editor usable in 0.92 s; connected in 3.94 s | Ordinary relaunch still pays several seconds |
| Runtime verification alone | 1.04–1.20 s for 19,196 files | Verification is a measurable part of launch |
| Relocate 1,000 annotations after an unrelated one-character edit | 208 ms median, Node benchmark | Annotation processing can block main-process work |
| Cache 500 formatted messages of roughly 2 KB each | 69 MB additional retained heap after garbage collection, Node benchmark | Parsed history has a substantial retained-memory cost |

Input-to-frame estimates use two animation-frame callbacks after an input event. They include the opportunity to paint, but are not hardware keyboard-to-screen measurements. The Chromium traces use a different, approximate keydown-to-paint method. Compare each method with itself.

Electron measurements used Linux Xvfb, synthetic content, and isolated application stores. Other desktop applications remained running. GPU costs and frame cadence here cannot calibrate desktop performance budgets. Most scenarios have one measured run; the experiments are directional comparisons, not statistically established release gains. [Measurements and methodology](strata-performance-audit-2026-09-08.evidence/manifest.json), [input summaries](strata-performance-audit-2026-09-08.evidence/metrics-summary.json).

## Ranked findings

### 1. Comment typing rebuilds the existing discussion

**Priority: first. Confidence: measured and experimentally supported.**

`ItemPanel` owns the draft state and renders all earlier replies. Every character updates that parent. Each `InlineMarkdown` then parses its existing text again. The history component also takes a reading-position snapshot during its update.

The test kept the draft at roughly 13 KB and varied only the number of earlier replies. With 80 formatted replies, each of the 25 measured inputs produced a long task. A separate parser benchmark rose from 16 ms for ten replies to 149 ms for 100 replies.

An isolated experiment that reused unchanged `InlineMarkdown` renders reduced the 20-reply median from 54 to 25 ms and the 80-reply median from 192 to 64 ms. The 80-reply case still produced long tasks. That is evidence for a broader repair than adding one memoization wrapper.

Move draft state into a small reply editor that updates independently of discussion history. Reuse unchanged reply rendering and avoid reading-position/layout work when the history itself did not change. Keep all replies, formatting, keyboard behavior, and scroll restoration.

Sources: [ItemPanel](/home/dillonc/Projects/StrataMD/src/renderer/components/ItemPanel.tsx:55), [InlineMarkdown](/home/dillonc/Projects/StrataMD/src/renderer/inlineMarkdown.tsx:93), [history snapshots](/home/dillonc/Projects/StrataMD/src/renderer/components/ConversationHistory.tsx:198).

### 2. Conversation updates resend unchanged history and defeat rendering reuse

**Priority: first. Confidence: measured amplification; exact division of runtime cost still needs profiling.**

Document updates already use section patches and content splices. Engine updates replace the entire engine section. A small status change therefore carries loaded messages, their text, parsed block descriptions, activities, accounts, and other engine information.

Using the actual encoder with synthetic completed messages, a status-only update was 137 KB for 20 messages, 1.36 MB for 200, and 6.80 MB for 1,000. A Node structured clone of the largest patch took 13.3 ms median before any renderer work. These are serialized-size and clone benchmarks, not measured network throughput.

Inside the UI, `ConversationMessage` is memoized, but its parent supplies newly filtered comment and ask arrays, newly parsed fold arrays, and new callbacks. Those fresh values defeat its ordinary shallow comparison. The conversation's one-second activity clocks can also revisit the message tree.

The cursor test used a 33,000-character draft and 100 earlier exchanges. All 60 repeated left-arrow movements arrived correctly in each condition. Adding fake server updates at an 80 ms requested interval increased the frame estimate from 32 to 74 ms median and produced 59 long tasks. The quiet condition also had one unexplained 107 ms long task, which remains an open profiling question.

Extend the existing sequence-checked update protocol with changes keyed by project, thread, and message ID. Preserve unchanged object identities through the renderer. Give history rows stable inputs and put ticking elapsed-time labels in small independent components. Keep every streamed update and the existing full-resync recovery path.

Sources: [view protocol](/home/dillonc/Projects/StrataMD/src/shared/view-sync.ts:68), [engine projection](/home/dillonc/Projects/StrataMD/src/main/engine/client.ts:533), [message props](/home/dillonc/Projects/StrataMD/src/renderer/components/Conversation.tsx:413), [activity clock](/home/dillonc/Projects/StrataMD/src/renderer/components/Conversation.tsx:261).

### 3. Table updates repeatedly invalidate document styles

**Priority: first. Confidence: measured, with a partial experimental improvement.**

The table manager refreshes all table views when review ranges change. Each table render rewrites attributes and stylesheet text before its toolbar's change check. Replacing identical stylesheet text still gives the browser work to do.

In the mixed-document trace, style recalculation consumed about 20.4 ms per typed character across the measured trace window. Avoiding identical stylesheet assignments reduced that to 2.3 ms. Estimated keydown-to-paint p95 fell from 51 to 37 ms, although the maximum still exceeded 100 ms.

The table-heavy document contained 165 tables and 9,075 cells. Its baseline trace attributed about 147 ms of style work per keystroke. In the broader workflow, the experiment reduced the measured typing action from 2,197 to 225 ms. However, external edit-to-review still took 8,963 ms, and the source-mode round trip worsened in that run. The change is not a complete or release-ready solution.

First eliminate unchanged DOM and stylesheet writes. Then refresh only tables whose data, location, display settings, or intersecting review ranges changed. Trace the external-update and source-mode paths separately, especially editor reconstruction and full-document layout. Preserve every table view, review indicator, edit control, and cell.

Sources: [table rendering](/home/dillonc/Projects/StrataMD/src/editor/tables.ts:362), [all-table refresh](/home/dillonc/Projects/StrataMD/src/editor/tables.ts:524), [editor transaction](/home/dillonc/Projects/StrataMD/src/editor/index.ts:836). [Experimental patches](strata-performance-audit-2026-09-08.evidence/diagnostics/tables.ts.patch).

### 4. Startup waits on verification and sequential connection work

**Priority: high. Confidence: measured total delays and verification cost; remaining stage costs not isolated.**

The owner's saved configuration uses the managed server. A fresh isolated installation connected in 5.80 seconds; its next launch connected in 3.94 seconds. The editor was usable in under one second in both cases.

Before adopting or starting a server, the manager stages and verifies the bundled runtime. Even an already staged runtime gets its files hashed and native dependencies exercised. That verification took about 1.0–1.2 seconds on the bundled files. A selected runtime can introduce another verification path; whether it duplicates work depends on the saved selection.

The client then performs shell loading, followed-thread loading, socket subscriptions, preview registration, and provider configuration in a largely sequential connection path. External-engine initialization awaits connection before application initialization finishes. Evidence cleanup also runs during initialization.

Add timings for each stage first. Deduplicate identical runtime verification within a launch, move hashing off the main process, and investigate a verification strategy that preserves the current integrity guarantees. Separate usable transport readiness from nonessential account/configuration refresh. Fetch independent followed threads with bounded concurrency and move independent cleanup off the launch path. Do not weaken authentication, runtime validation, or delivery recovery.

The fresh fixture had no populated server history. These totals do not establish the cause of every second in the owner's launch.

Sources: [managed startup](/home/dillonc/Projects/StrataMD/src/main/engine/manager.ts:68), [runtime verification](/home/dillonc/Projects/StrataMD/src/main/engine/managed-runtime.ts:38), [client initialization](/home/dillonc/Projects/StrataMD/src/main/engine/client.ts:462), [reconnect](/home/dillonc/Projects/StrataMD/src/main/engine/client.ts:778), [application initialization](/home/dillonc/Projects/StrataMD/src/main/application.ts:463).

### 5. Annotation processing scans and copies too much

**Priority: high for annotated documents. Confidence: measured.**

After an edit, Strata maps annotations through the change and then relocates every unresolved annotation. Relocation searches the document and builds a replacement annotation map. Repeating that map copy for every annotation adds quadratic copying on top of repeated text searches.

For an unrelated character appended to a 108 KB document, the actual mapping/relocation functions took 1.6 ms with 20 annotations, 8.6 ms with 100, 56.7 ms with 500, and 208 ms with 1,000. This is main-process computation before persistence and UI updates.

Retain mapped anchors when their exact text and context remain valid, search only when needed, and commit a batch of annotation changes with one map copy. Index reusable search/line information for the document version. Preserve ambiguous-quote handling, orphan recovery, events, and undo semantics.

Sources: [updateBuffer](/home/dillonc/Projects/StrataMD/src/main/application.ts:1911), [mapping](/home/dillonc/Projects/StrataMD/src/core/annotations.ts:873), [relocation](/home/dillonc/Projects/StrataMD/src/core/annotations.ts:900). [Growth measurements](strata-performance-audit-2026-09-08.evidence/growth.json).

### 6. Parsed-message caches survive editor eviction

**Priority: high for long sessions. Confidence: code-confirmed retention and measured heap growth.**

The transcript coordinator normally limits rich editors to 11, while protecting selections and active targets. That is useful, but the renderer's `conversationParse` map has no eviction policy. The main-process message cache also has no pruning calls. Removing a rich editor therefore does not necessarily release its parsed message data.

A Node experiment retained about 6.8 MB for 50 messages, 27.7 MB for 200, and 69.5 MB for 500, after garbage collection. Each source message was only about 1,950 characters. This demonstrates retention cost, not a measured hours-long leak in the owner's app.

Introduce byte-aware cache budgets tied to active and recently visited threads. Pin data needed for active selection and navigation, evict reproducible inactive parses, and recreate them when needed. Keep source text and saved conversations intact. The existing bounded geometry cache and document editor cache are useful patterns.

Sources: [renderer parse cache](/home/dillonc/Projects/StrataMD/src/renderer/conversationReading.ts:7), [main message cache](/home/dillonc/Projects/StrataMD/src/main/engine/client.ts:404), [rich-editor budget](/home/dillonc/Projects/StrataMD/src/renderer/transcriptAllocator.ts:11).

### 7. Transcript layout and background preparation revisit entire histories

**Priority: high alongside conversation delivery. Confidence: code-confirmed work; isolated timing still needed.**

The history mutation observer re-queries all history rows whenever children change. Reading-position capture searches rows and reads their bounds. The transcript coordinator's allocation passes measure and inspect the registered rows, while idle preparation can build rich editors for previously unmeasured messages. Completed-message components also each install a document selection listener.

These mechanisms preserve reading position and rich content, but their work can grow with the conversation. New input can arrive after an idle task starts, so starting work in an idle callback alone does not bound its duration.

Maintain row registration incrementally, share selection observation, reuse valid geometry, and divide preparation into bounded work units. Keep the same rich rendering, cross-message selection, navigation, and scroll anchoring. Profile this together with server updates before changing allocation behavior.

Sources: [history observation](/home/dillonc/Projects/StrataMD/src/renderer/components/ConversationHistory.tsx:168), [coordinator passes](/home/dillonc/Projects/StrataMD/src/renderer/transcriptCoordinator.ts:338), [selection listeners](/home/dillonc/Projects/StrataMD/src/renderer/components/ConversationMessage.tsx:58).

### 8. Main-process publications trigger repeated reconciliation

**Priority: medium to high under multiple active conversations. Confidence: code-confirmed amplification.**

Each engine publication publishes application state and schedules document reconciliation. Reconciliation visits open documents and available messages, then publishes again even when nothing changed. Some inner checks call the engine's full view projection again. Engine publication separately schedules conversation reconciliation.

Warm engine projection itself was inexpensive in the simple synthetic fixture: about 0.4 ms for 1,000 messages. It should not be treated as the dominant bottleneck merely because the function is large. The concerns are repeated passes, extra publications, queue growth during bursts, and richer item/annotation workloads.

Track changed thread/message versions and reconcile only affected documents and comments. Coalesce superseded state publications while preserving ordered commands and acknowledgments. Avoid publishing an identical result. Measure queue depth and main-process event-loop delay.

Sources: [engine subscriber](/home/dillonc/Projects/StrataMD/src/main/application.ts:463), [document reconciliation](/home/dillonc/Projects/StrataMD/src/main/application.ts:1437), [engine publication](/home/dillonc/Projects/StrataMD/src/main/engine/client.ts:2512).

### 9. Terminal output repeatedly copies its full retained buffer

**Priority: medium for busy terminals. Confidence: measured isolated cost.**

Each output chunk concatenates the retained buffer, UTF-8 encodes it, trims it, and decodes the retained tail. Once the buffer reaches 512 KB, a 1 KB output chunk still processes roughly the entire buffer. The terminal renderer also maintains its own content.

The buffer function cost about 0.53 ms median per 1 KB chunk at capacity. At high event rates, this becomes avoidable CPU and allocation pressure. This benchmark excludes terminal drawing and IPC.

Use a byte-counted chunk buffer, or retain the extra buffer only while the terminal is being created if the lifecycle permits it. Preserve scrollback, multibyte characters, reconnect behavior, and pending output. Terminal drawing already coalesces through animation frames.

Sources: [terminal buffer](/home/dillonc/Projects/StrataMD/src/renderer/terminal/buffer.ts:23), [drawer output handler](/home/dillonc/Projects/StrataMD/src/renderer/components/TerminalDrawer.tsx:42).

### 10. Draft storage is synchronous, but it did not explain the measured stalls

**Priority: medium resilience improvement. Confidence: mechanism confirmed; severe latency not reproduced.**

Conversation typing writes the complete draft to local storage on each character, including inline text attachments. That is a scaling risk, especially with large attachments or a busy storage backend.

However, the measured 100, 20,000, and 100,000-character drafts had medians between 18 and 22 ms. Storage calls for the largest draft were generally 0.1–0.4 ms. It would be misleading to blame the reported lag on local storage based on these results.

Keep immediate in-memory draft state and investigate coalesced durable writes with explicit flushes on send, navigation, and shutdown. Preserve crash recovery and visible unsaved-state reporting. Prioritize the measured rendering problems first.

Sources: [composer persistence](/home/dillonc/Projects/StrataMD/src/renderer/components/ConversationComposer.tsx:114), [draft storage](/home/dillonc/Projects/StrataMD/src/renderer/conversationDrafts.ts:38).

### 11. Browser previews and ambient rendering need desktop-specific follow-up

**Priority: profile before changing behavior. Confidence: architectural exposure, not a measured root cause here.**

Preview tabs stay alive, are parked in a native window, and explicitly disable background throttling so automation and captures work while the owner looks elsewhere. Restoring saved preview tabs loads all of them. Their resource cost can accumulate, but the owner's saved state had zero preview tabs, so this does not explain that observed configuration.

Ambient rendering already has GPU batching, a texture worker, and visibility/reduced-motion handling in the clustered sky. The CSS animation ticker still enumerates document animations on a 30 Hz interval. Its typing flag is set by document edits, not ordinary comment/composer input. The short default idle sample had no long tasks; this was not a desktop GPU comparison or a long soak.

Profile actual themes, display scale, multiple preview pages, and capture bursts on the desktop. Optimize redundant drawing, texture reuse, repeated layout, and capture/decoding work. Preserve the current appearance, animation cadence, working background pages, and browser automation. Disabling effects or suspending useful page behavior is not an acceptable shortcut.

Sources: [preview lifecycle](/home/dillonc/Projects/StrataMD/src/main/preview/host.ts:217), [background throttling](/home/dillonc/Projects/StrataMD/src/main/preview/host.ts:287), [preview restore](/home/dillonc/Projects/StrataMD/src/main/preview/host.ts:459), [ambient ticker](/home/dillonc/Projects/StrataMD/src/renderer/ambientTicker.ts:28), [typing flag](/home/dillonc/Projects/StrataMD/src/renderer/App.tsx:793).

### 12. The performance lab does not currently protect all these workloads

**Priority: repair alongside the first fixes. Confidence: reproduced.**

The tabs and broad workflow profiles failed because they still selected the removed tab bar. Updating their selectors in the isolated copy allowed all three cases to complete. Both broad workflow cases then reported degraded performance, while their tests passed because budget enforcement is opt-in.

The existing Send composer test measures a small note change against a checklist. It does not cover long comment discussions, streaming interference, or large conversation drafts. The keystroke profiler also writes fixed artifact names, so a later experiment overwrote its original raw trace; the original summary remains in the log.

Repair current UI selectors, preserve unique run artifacts, and add representative input, streaming, startup, annotation-growth, and retained-memory profiles. Calibrate budgets on a reference desktop. Keep correctness failures separate from performance budget failures, and report both.

Sources: [tab profile](/home/dillonc/Projects/StrataMD/test/performance/tabs.spec.ts:89), [workflow profile](/home/dillonc/Projects/StrataMD/test/performance/stress.spec.ts:74), [Send profile](/home/dillonc/Projects/StrataMD/test/performance/send-composer.spec.ts:14), [trace output](/home/dillonc/Projects/StrataMD/test/performance/keystroke-trace.spec.ts:120).

## Coverage beyond the primary findings

| Area reviewed | Assessment |
|---|---|
| Document parsing and serialization | Incremental reparse exists, and the hidden source mirror already skips DOM reconstruction. Traces still show offset shifting, node cloning, serialization, and table work. Preserve byte-exact round trips; do not replace this with source-only editing |
| Document switching | Measured roughly 1.3 s when returning to the first rich document at five/ten open files. Warm/cold editor caching exists. Profile remount, parse restoration, and first layout before expanding the cache and increasing memory |
| Save, recovery, and disk persistence | Saves in the two 100 KB workflow fixtures took about 350–375 ms. Mirror and metadata writes already debounce, and persisted content is cached. Full metadata/history serialization remains a growth risk. Preserve fsync and recovery guarantees |
| Explorer | Startup folder discovery is already asynchronous and cancels superseded scans. Folder walking and stored-document metadata reads are sequential. Bounded concurrency or incremental indexing is worth measuring on large trees |
| Search and selection | Conversation Find scans messages synchronously as the query changes; uncached messages require parsing. Visual selection maps source ranges and reads coordinates. Reuse indexes and discard superseded search work while retaining exact results |
| Images | Header-based dimension reads avoid full decoding in common cases. Local image authorization obtains application state, which can invoke broad projection. A small cached roots view could avoid that coupling. Large-image/capture stress was not run |
| Mermaid, charts, rich components | Mermaid and charts already load lazily; charts disable animation and use prepared data. These are not candidates for removal. Large diagrams and repeated remounts still need their own profiles |
| Providers and inferred asks | Configuration refresh, usage probes, and ask scanning have scheduling and cancellation controls. No provider work was disabled. The effect of several simultaneous real accounts/jobs was not measured |
| Long-lived resource cleanup | Editor, watcher, terminal, and transcript lifecycles have explicit cleanup. The parse caches above are the clearest retention finding. Preview and worker lifecycle behavior needs an hours-long soak |

## Recommended repair sequence and acceptance

1. Repair benchmark selectors/artifact isolation, then isolate comment draft rendering and eliminate identical table style writes. Capture before/after traces and preserve visual/interaction checks.
2. Implement engine updates by changed IDs, stable history inputs, bounded transcript work, and targeted reconciliation. Verify typing and held arrows while several threads stream, not only while idle.
3. Batch annotation relocation and bound reproducible parse caches. Verify annotated documents, navigation through old messages, undo, and retained heap after repeated open/close cycles.
4. Instrument and shorten startup while preserving integrity/authentication. Optimize terminal buffering, explorer scans, and storage only against measured workloads.
5. Run desktop theme/GPU, preview/terminal concurrency, and long-session soak profiles. The Linux diagnostic results do not replace macOS or desktop-display checks.

Proposed reference-machine targets are p95 input-to-paint below 50 ms, no repeatable input stall over 100 ms, editor usability within one second on ordinary launch, and a substantially shorter warm server connection than the current roughly four-second fixture. Calibrate these before treating them as release gates. Also require retained memory to plateau under repeated navigation and require all existing features, visuals, save/recovery semantics, and streamed information to remain intact.

## Verification and evidence

The repository verification runner passed TypeScript, a production build, 30 selected unit tests, and four conversation Electron tests. No selected checks skipped. That baseline run took 39 seconds. Fourteen diagnostic test cases subsequently completed successfully, including the isolated experiments. The full release gate was not run because no production change is being delivered.

Five diagnostic attempts failed for understood test setup issues: three obsolete tab-selector cases, one incorrect synthetic thread title, and one incorrect launch-helper argument. Each was corrected in the isolated copy and the affected case passed. The quiet-arrow 107 ms long task and the remaining table-heavy stalls remain performance findings, not resolved flakes.

The audit includes source review across the whole application and focused runtime measurements. It does not claim exhaustive profiling of every theme, platform, document shape, provider, or multi-hour session. The experiments have not passed the full correctness/visual gate and are not installed fixes.

[Evidence manifest](strata-performance-audit-2026-09-08.evidence/manifest.json) · [input measurements](strata-performance-audit-2026-09-08.evidence/metrics-summary.json) · [engine, terminal, and runtime benchmarks](strata-performance-audit-2026-09-08.evidence/micro.json) · [annotation and memory growth](strata-performance-audit-2026-09-08.evidence/growth.json) · [baseline verification](strata-performance-audit-2026-09-08.evidence/verification-summary.txt).
