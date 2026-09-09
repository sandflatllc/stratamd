# Composer commands and skills contract

Feature 9 follows T3 PR 7737 and the pinned upstream source `08463e2c401ce87858aaaebcb70ed86fb002fb5f`. The audit used the extracted source at `/tmp/strata-t3-implementation-source`.

## Catalog and scope

`packages/contracts/src/server.ts` defines provider slash commands and skills, including `name`, `description`, `path`, `scope`, `enabled`, `displayName`, `shortDescription`, `userInvocationOnly`, and `userInvocable`. Strata's existing `src/main/engine/t3-contract.ts` decodes those fields and the instance/workspace command snapshots. `src/shared/provider-commands.ts` supplies the one catalog selector used by the context meter and command menu.

The selected instance's exact current working directory snapshot overrides its instance catalog, even when the workspace snapshot is empty. A thread's worktree path takes precedence over the project root. The menu does no filesystem discovery, remote path reads, or additional provider requests.

`packages/client-runtime/src/providerSkills.ts` supplies upstream eligibility and deduplication semantics. A skill is selectable when enabled and `userInvocable` is not false. `userInvocationOnly: true` remains selectable because the user is explicitly choosing it. Duplicate skill names are suppressed case-insensitively, and a selectable skill wins over a slash command with the same name. Strata filters names, display names and descriptions without altering the provider's canonical name.

## Invocation

`apps/web/src/components/chat/ChatComposer.tsx`, around lines 2913 and 2931, inserts `/command-name ` for provider commands and `$skill-name ` for skills. This is the contract for every provider, including explicit-invocation-only skills. Displayed `/name` menu labels do not determine the inserted token.

`apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts` and `provider/Layers/ClaudeAdapter.ts` convert known `$skill` mentions into Claude's actual slash invocation in the final text block. Codex handles `$name` natively. Strata sends the canonical token unchanged; it does not substitute a display name, skill file path or prose instruction. The illustrative original `/agent-browser` inserted-state benchmark required correction to `$agent-browser` to match this engine contract.

Choosing a skill or ordinary command only replaces the token at the caret and persists the draft. Enter or Tab chooses the highlighted entry. An empty search consumes Enter without starting a turn. Escape dismisses the menu. After insertion, the user submits the message separately.

Compact is the sole immediate menu action. It calls feature 6's existing `useContextCompaction` action, including its capability, connection, active-turn and in-flight guards. It consumes the search token but preserves the rest of the draft and all staged/held work. Unsupported compaction is not synthesized as a chat prompt.

## Verification boundary

`test/unit/composer-commands.test.ts` checks safe token replacement, filtering and explicit-only eligibility. `test/e2e/composer-commands.spec.ts` feeds the real provider config decoder through the fake engine, exercises keyboard search/selection and reload, verifies exact outgoing `$agent-browser` text only after explicit submission, checks an empty workspace override, and proves the compact menu calls the existing command path while retaining draft prose. Screenshots come from the isolated Electron app in default Strata at 1440 × 1000.

These checks establish Strata's real renderer, persistence, IPC and outbound request behavior. They do not execute a paid native Codex or Claude skill; the provider-specific expansion is supported by the pinned engine source audit above.
