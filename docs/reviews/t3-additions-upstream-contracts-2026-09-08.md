# T3 upstream implementation audit

Read-only audit, September 8 Arizona / September 9 UTC. Source extracted from official GitHub codeload at `/tmp/strata-t3-implementation-source`, revision `08463e2c401ce87858aaaebcb70ed86fb002fb5f`. No repository or app changes. AGENTS.md read; root MEMORY.md absent.

## Engine package conclusion

No currently published `t3` version contains all required changes. Official [npm metadata](https://registry.npmjs.org/t3) reports stable `0.0.40` and nightly `0.0.41-nightly.20260909.1426`. Neither published metadata entry includes `gitHead`; do not invent one. [Official nightly release](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260909.1426) identifies target commit `3e6f856f2359421958a3aa046f2c393e00f3dc6a`, published on npm at `2026-09-09T01:13:28.931Z`.

GitHub compare API confirms that target is a descendant of #8103, #9871, #10431, #10501, #10572. Captured source is exactly two commits ahead: #10859 relay notification routing and #10777 event replay memory fix. [Official comparison](https://github.com/pingdotgg/t3code/compare/3e6f856f2359421958a3aa046f2c393e00f3dc6a...08463e2c401ce87858aaaebcb70ed86fb002fb5f).

Recommended baseline is an EXACT pin to `t3@0.0.41-nightly.20260909.1426`, plus a deterministic source build/backport of #10777 if all requirements must ship now. A bare pin cannot be signed off as satisfying the replay fix. Prefer reproducible source build from captured commit over a brittle manual minified bundle edit. Alternative is a later published nightly whose ancestry is explicitly verified before adoption. Stable 0.0.40 lacks the other after-stable work. The source package.json still says 0.0.40 because release automation sets published versions; that value is not source provenance.

Saved evidence: `/tmp/strata-t3-npm-metadata.json`, `/tmp/strata-t3-nightly-release.json`, `/tmp/strata-t3-nightly-compare.json`, `/tmp/strata-t3-pr-ancestry.json`. These were fetched from registry.npmjs.org and api.github.com. No runtime compatibility certification has been performed.

## Exact feature contracts and adapter gaps

All upstream paths below are relative to extracted source. Local paths are relative to StrataMD.

### 1. Server usage limits

`packages/contracts/src/providerUsageLimits.ts` owns `ServerProviderUsageLimits`: required `checkedAt`, `windows`; optional `resetCredits`, `unavailable`. Window fields are `id`, `kind` (`session|weekly|monthly|other`), `label`, `usedPercent`, optional `resetsAt`, `windowDurationMins`. `unavailable.reason` is `unsupported|probeFailed`. `resetCredits` has `availableCount`, optional `nextExpiresAt`, `nextCreditId`.

`packages/contracts/src/server.ts` exposes provider `usageLimits` in `server.getConfig` and provider config stream updates; config optionally has `usageLimitSources`, with its own source update event. `server.refreshProviders` payload in `rpc.ts` permits `instanceId`, `cwd`, `refreshModels`. Provider runtime sparse updates merge windows by stable id; omitted windows remain unchanged.

Strata `t3-contract.ts` only types its older local `usage` shape (session/weekly, measuredAt/source); `accounts.ts` and `client.ts` call the helper. Map windows into account measurements but retain the complete reported window collection for UI. `probeFailed` should preserve last good readings; `unsupported` must clear applicability. Do not confuse checkedAt with reset time. Shared account view needs duration, per-window labels/ids, and unavailable status for accurate remaining/pace display. Preserve parking/routing independently of quota. One provider model can have several weekly windows; blindly selecting the first weekly window is lossy.

### 2. Native async questions

`packages/contracts/src/providerRuntime.ts` request payload has optional `responseMode: 'message'`. Missing means blocking native callback. `orchestration.ts` defines `thread.user-input.dismiss` with commandId/threadId/requestId/createdAt. `thread.user-input.respond` retains the same identities and answers.

`apps/server/src/orchestration/decider.ts` rejects dismissal of blocking requests. Successful dismissal appends `thread.activity-appended` containing kind `user-input.resolved`, payload `{requestId,responseMode:'message'}` and summary `User input dismissed`; there is no separate user-input.dismissed activity to wait for. Ingestion and projector retain async pending questions while a turn continues and across reconnect.

Strata `client.ts` has respondUserInput only. Add typed dismissal, carry responseMode from existing activity payload into card state, resolve by requestId, and avoid native/inferred duplicate items. Do not decide dismissibility from whether the thread currently runs. Held-answer persistence must remain request-identified.

### 5. Restart continuation

`packages/contracts/src/settings.ts` exact environment-owned preference is `continueThreadsAfterServerUpdate`, default false; patch has same key. Write via `server.updateSettings {patch:{continueThreadsAfterServerUpdate:boolean}}`. `server.ts` also permits `server.updateServer` self-update input `{targetVersion,continueRunningThreads?}`. These are different fields and lifecycles.

`apps/server/src/serverRuntimeStartup.ts` and `provider/Layers/ProviderService.ts` use the environment preference for opt-in restart recovery. Existing session resume and fallback continuation are server responsibilities. Strata manager owns its own maintenance lifecycle and must coordinate durable pending sends and held replies before allowing active-work shutdown. Merely adding a local preference or npm upgrade does not enable recovery. Do not call server self-update to replace Strata's managed package lifecycle.

### 6. Compact context

There is NO special public compact RPC or orchestration command. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:82` detects a user message whose trimmed/lowercased text is exactly `/compact` AND attachment count is zero. Submit normal `thread.turn.start` with empty attachments and current thread/model/runtime settings. It requires an existing conversation and no running provider turn. `provider/Services/ProviderAdapter.ts` optional `compactThread` is the provider capability; unsupported providers return a clear error rather than sending `/compact` as a normal prompt.

`ProviderRuntimeIngestion.ts` publishes `context-compaction` activities with optional `beforeTokens`, `afterTokens`; compaction state also drives the upstream UI. Read `apps/web/src/components/chat/MessagesTimeline.tsx` for progress/completion interpretation. The public capability signal used by upstream is a reported slash command named `compact`, in `apps/web/src/components/chat/ContextWindowMeter.logic.ts` (`providerSupportsManualCompaction`). Use that selected-provider signal rather than a hard-coded driver allowlist. Strata's normal delivery path appends its generated context attachment, so routing Compact through that path silently prevents compaction. Add a dedicated client operation that sends the plain command without document delivery, held feedback or attachment merging.

### 7. Per-answer attachments

`orchestration.ts` `UserInputAttachments` is a record from question id to arrays of `ChatImageAttachment|ChatFileAttachment`, each array capped at provider max attachments. `thread.user-input.respond` adds optional `attachmentsByQuestionId`. `UserInputAttachmentAnswerPayload` also carries requestId, answers, optional questionTextById. Use uploaded durable attachment refs, not data URLs in this field.

Strata `t3-contract.ts` answers is unknown-record and passthrough would retain an extra field, but `client.ts`/preload/shared `answerEngineUserInput` accept only answers and never construct it. Extend all layers plus persisted held question drafts, reconcile by stable question id and request id, and reuse binary staging. Blocking and async are both supported upstream. Check total budget across answers, generated context, and other staged attachments rather than assuming per-record limits authorize unlimited aggregate attachments.

### 9. Commands and skills

`server.ts` types `ServerProviderSlashCommand {name,description?,input?:{hint}}` and `ServerProviderSkill {name,description?,path,scope?,enabled,displayName?,shortDescription?,userInvocationOnly?,userInvocable?}`. Provider config has slashCommands, skills, optional workspaceSnapshots; snapshot is `{cwd,checkedAt,slashCommands,skills}`. Refresh via `server.refreshProviders {instanceId,cwd,refreshModels?}` and consume server config changes.

Use selected provider AND current cwd snapshot. Exclude disabled and `userInvocable:false` skills. `userInvocationOnly:true` requires slash invocation; inserting a bare name in ordinary prose does not invoke it. Strata provider passthrough retains fields only as unknown and its view mapper drops them. Add typed descriptors/view fields and searchable composer menu, not a second filesystem skill scanner.

### 10. Shared project defaults

`packages/contracts/src/t3ProjectFile.ts` is the exact checked-in `t3.json` schema: `$schema?`, `iconPath?`, `defaultThreadEnvMode?:'local'|'worktree'`, `scripts?`. Scripts have name,command, optional icon/runOnWorktreeCreate/previewUrl/autoOpenPreview. This is not a generic provider/model configuration file.

`orchestration.ts` project `defaultThreadEnvMode` is optional/null for inheritance. Global server settings also have defaultThreadEnvMode. Priority is explicit per-project override, t3.json, global. `project.meta.update` writes the project override. `apps/web/src/lib/t3ProjectFileDefaults.ts` reads file through project.readFile; `hooks/useT3ProjectFileScripts.ts` distinguishes valid/invalid/missing. `apps/server/src/project/T3ProjectFileLoader.ts` loads for server consumers. Shared scripts are offered for import; do not auto-run arbitrary new repository scripts.

Strata project contract is passthrough but mapper has no defaults/source explanation. Add explicit fields and reset-to-inherit state. Keep checked-in file, environment global settings, per-project metadata and Strata-local UI settings separate. Shared defaults must not override explicit new-thread choices or introduce autoPull.

### 12. Discover/import history

`packages/contracts/src/rpc.ts` exact methods `agentSessions.scan` and `agentSessions.import`; schemas in `agentSessions.ts`. Scan payload `{}`. Result `{candidates,scannedAt,truncated?}`; candidate `{path,title,projectId?,sources:['claudeAgent'|'codex'],threadCount,lastActiveAt,alreadyImported,git?}`; git null or `{remoteKey,repository}`. Import payload `{projectId,expectedWorkspaceRoot?}` and result `{importedCount,skippedCount}`. Create/select a project first, then import with expectedWorkspaceRoot to guard directory changes.

Server owns provider-home discovery and native resume metadata. Source identity includes provider instance/session id, file path, size, mtime, device/inode/birthtime. Imported message ids start `import:` and retries skip unchanged history. Do not manually convert transcripts or create an app-local import provenance substitute. Strata needs scan/import methods through engine/preload/UI, bounded loading/errors, and count results. Existing engine shell subscription can receive imported threads. Respect private-data boundary by excluding prohibited candidate paths in Strata and never initiating import of that state.

### 15. Custom models/options

`packages/contracts/src/model.ts` `CustomModelSetting = string | {slug,name?,capabilities?:{optionDescriptors?}}`. Descriptor union is select or boolean. Common fields id,label,description?; select has options [{id,label,description?,isDefault?}], currentValue?, promptInjectedValues?; boolean has currentValue?. `ModelSelection.options` uses [{id,value:string|boolean}], with legacy object decode compatibility.

Strata already supports server model names and option controls in client.ts/models view. Gaps: `src/shared/engine-settings.ts` provider instance config customModels strictly accepts strings only, so rich object settings can fail the full settings decode. `t3-contract.ts` descriptor parser strips description and promptInjectedValues; shared ModelOptionDescriptor omits both. Preserve optional metadata in typed contracts and replace comma-split model settings editor with durable object editing. Preserve legacy string entries on load. Model capability metadata must survive read-edit-save; do not overwrite unknown model fields when only changing a name.

## Integration risks to settle before signoff

1. No unmodified published package currently meets all PR requirements.
2. The npm package contains engine/web code, not Electron host implementation. #8103 and preview capture changes require Strata host adaptations even when commits are included in engine ancestry.
3. Missing rich-model schemas can make readSettings reject valid upstream settings immediately after upgrade.
4. Compact must bypass Strata-generated context attachments and ordinary pending delivery consumption.
5. Async dismissal uses existing resolved activity; an invented dismissed event leaves questions stuck.
6. Usage must retain last good limits during probe failure and cannot be reduced losslessly to one session plus one weekly window.
7. This audit confirms source contracts and release ancestry only. Full Strata gate and isolated real-engine smoke verification are still required.

## Published artifact and patchability follow-up

Downloaded official tgz to `/tmp/strata-t3-nightly-package.tgz`, extracted `/tmp/strata-t3-nightly-package/package`. SHA-512 matched npm integrity exactly. Registry SLSA provenance at `/tmp/strata-t3-nightly-provenance.json` explicitly resolves GitHub source `3e6f856f2359421958a3aa046f2c393e00f3dc6a` and workflow `.github/workflows/release.yml`, invocation `https://github.com/pingdotgg/t3code/actions/runs/34297062529/attempts/1`. This is stronger source identity evidence than release target alone, although no independent Sigstore signature-chain validation was run.

Both replay methods are readable emitted JS in `dist/bin.mjs:55703` and `:55730`. Bundle SHA256 is `6e7a9fe68158c677f5d671eaa5267d21af020b38861309c614820d785a1f591a`. Exact official commit patch is `/tmp/strata-t3-replay-10777.patch`, SHA256 `ad7a145885a95f64672602b09d8ef0e89c01def2a58d98d34da0e551ad07a4c8`.

A tightly scoped deterministic bundle backport is feasible because the two function blocks remain identifiable, but upstream Stream.paginate appears tree-shaken out of the bundle. Do not introduce an undefined paginate symbol. Need either compatible external Effect stream import from the same package version or the exact pinned implementation with dependencies, verified against upstream retained-page test. Relevant emitted aliases: map$5 is Effect.map, flatMap$1 Effect.flatMap, flatMap$3 Stream.flatMap, empty$15 Stream.empty.

A patch installer should reject unrecognized bundle hash or replacement counts, preserve MIT LICENSE (`Copyright (c) 2026 T3 Tools Inc.`), and record npm integrity, upstream PR/commit, exact before/after digests and intentional modifications. Keep the source patch attribution with the shipped change. Installing the unmodified upstream package and later mutating dist without including that modification in engine identity/verification would make rollback/reuse evidence misleading. Prefer the deterministic backport if source rebuilding adds unrelated release tooling complexity, but it still needs the retention regression test against actual patched code.
