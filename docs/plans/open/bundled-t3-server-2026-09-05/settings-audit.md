# T3 settings and their proposed Strata homes

Inspected September 5, 2026. Actual UI evidence is from the installed T3 Code 0.0.37 app and the existing Strata build, each running in a disposable profile. See the [implementation plan](plan.md) and [inspection record](references/README.md).

## The practical size of the change

No server preference needs to be a mandatory onboarding question. Existing provider accounts were detected automatically in the test. A clean machine still needs a supported provider installation/sign-in path, which the plan includes.

There are **seven groups of engine preferences** to expose beyond ordinary account management: workspace defaults, project starting folder, settling, generated text, background activity, provider update checks, and source control writing. Some groups have conditional fields, so counting schema keys or drawing a fixed number of switches would misrepresent the UI.

Account configuration and T3 Connect are separate groups. Strata already covers a substantial part of Accounts. T3 Connect adds the optional T3 account, remote access, activity publishing, and access management. Background operation and start-at-login are new Strata controls, not T3 server settings being copied.

“Include” below means part of the proposed bundled-server release. “Preserve” means retain behavior or stored values without adding an unrelated interface. Code was used after app inspection to check who owns a setting; it was not used as a substitute for opening its UI.

## General and background settings

| Actual user control | Where it lives in T3 today | What Strata has today | Proposed treatment |
| --- | --- | --- | --- |
| New threads: Local / New worktree | Settings → General → New threads. [Screenshot](references/t3-general-workspaces.png) | Per-conversation workspace controls. No equivalent global settings form in the inspected UI. | Include in General. Fresh default Local. Existing conversations keep their mode. |
| Start from origin | General, revealed after selecting New worktree. [Screenshot](references/t3-general-workspaces.png) | Worktree controls read the engine's origin default; global editing is missing. | Include conditionally below New conversations. Retain the per-conversation override. Fresh T3 default on. |
| Add project starts in | General, below New threads. [Screenshot](references/t3-general-workspaces.png) | Project browsing exists; no global preference form. | Include. Blank uses the home folder. Validate on the engine's computer, especially in external mode. |
| Auto-settle merged threads | General near the top. [Screenshot](references/t3-general-top.png) | Strata renders active and settled threads. No toggle in the inspected settings UI. | Include. Preserve the engine's behavior. T3's description says closed pull requests still settle automatically; do not promise this switch disables every automatic settlement. |
| Auto-settle inactive threads | General near the top. [Screenshot](references/t3-general-top.png) | Settlement can appear in Strata; control is missing. | Include. Off must map to disabled settling, not an arbitrary long timeout. |
| Days of inactivity before auto-settle | General, conditional on inactivity settling. [Screenshot](references/t3-general-top.png) | Missing global control. | Include under the switch. Observed fresh value 3 days. Preserve a migrated value. |
| Text generation model and effort | General → Text generation model. [Screenshot](references/t3-general-workspaces.png) | Conversation model selection exists; global generated-text selection is distinct. | Include the same model/options picker with T3's default. Decided September 5, 2026: no Automatic option; it works as T3 does now. T3 falls back only to an enabled provider, so a Claude-only machine must pick a Claude model here; Accounts points at this setting when the configured account is not ready. This affects titles and other generated text, not the conversation's main model. T3 showed a Codex model with Low effort. |
| Provider update checks | General → Provider update checks. [Screenshot](references/t3-general-top.png) | Provider status exists, but this setting is missing. | Include under Advanced. Observed on. Keep version checking separate from actually installing an update. |
| Background activity profile | General → Background activity. Options Balanced, Performance, Battery saver, Advanced. [Screenshot](references/t3-background-choices.png) | No profile editor. | Include under Advanced. Balanced is the fresh default. Advanced opens the tuning dialog; it is not a fourth fixed policy. |
| Shared policy | General → Background activity → Advanced. [Screenshot](references/t3-background-advanced.png) | Missing. | Include in the background dialog. Preserve the upstream distinction between a base profile and custom overrides. |
| Git fetch interval | Same dialog. [Screenshot](references/t3-background-advanced.png) | No control. | Include under Advanced. Observed 30 seconds. Validate against the selected server's supported bounds. |
| Provider health interval | Same dialog; also Providers → Advanced → Health check interval. [Screenshot](references/t3-provider-codex.png) | Account readiness is displayed, but refresh interval editing is missing. | One setting with one authority. Use the same background editor from Accounts if a shortcut is needed. Observed 300 seconds. |
| Active and idle host power polling intervals | Background activity → Advanced. [Screenshot](references/t3-background-advanced.png) | Missing. | Include together under Advanced. Observed 30 and 300 seconds respectively. |
| Pause when locked, host low power, client low power, or on battery | Four switches in the background dialog. [Screenshot](references/t3-background-advanced.png) | Missing controls and a host/client-signal integration needs checking. | Include. Observed on, on, on, off. Connect the runtime signals as well as the form. These gate background probes, not active turns. |

The visible intervals above are values observed in the disposable app, not constants to hard-code permanently. Prefer the server's defaults and validation metadata when available. Preserve custom settings during migration and upgrades.

## Accounts and provider configuration

| Actual user control | T3 location and evidence | Strata coverage | Proposed treatment |
| --- | --- | --- | --- |
| Add provider, select instance, enabled state, display name | Settings → Providers. [T3 screenshot](references/t3-providers.png), [current Strata screenshot](references/strata-provider.png) | Already present. | Reuse. Make first-use discovery and account readiness clearer. |
| Account sign-in and repair | Readiness is shown in Providers. Authenticated accounts were detected without entering a T3 login. [Screenshot](references/t3-providers.png) | Accounts shows ready/not-set-up status. | Add a guided official provider setup/sign-in flow where needed. Its clean-machine operation was not demonstrated in this audit. Do not present a proposed button as an observed T3 control. |
| Accent color | Providers → instance → Configuration. [Screenshot](references/t3-providers.png) | Not exposed in the inspected Strata form. | Include beside the instance name. Use the value consistently in account/model UI where it helps distinguish instances. |
| Environment variables | Same Configuration tab → Add. T3 explains that sensitive values are stored separately and not returned after saving. [Screenshot](references/t3-providers.png) | Missing. | Include under Advanced. Support name, value, secret status, add, replace, remove, and unsaved changes. Never display a stored secret as an empty value to save. |
| Binary path | Each provider's Configuration tab. [Codex](references/t3-provider-codex.png), [Strata](references/strata-provider.png) | Present. | Retain under Advanced. Blank means automatic detection. Package startup must supply a useful executable search path. |
| Codex home and shadow home | Codex → Configuration. [Screenshot](references/t3-provider-codex.png) | Supported by Strata's provider model and configuration form. | Retain. Explain ordinary configuration home versus isolated account home. Do not move account credentials during routine startup. |
| Claude account home and launch arguments | Claude → Configuration. [Screenshot](references/t3-provider-claude.png) | Present. | Retain under Advanced. |
| Codex launch arguments | Codex → Configuration. [Screenshot](references/t3-provider-codex.png) | Present. | Retain. Validate and pass arguments without shell string interpolation. |
| Claude Auto-compact after | Claude → Configuration. [Screenshot](references/t3-provider-claude.png) | Missing. | Include only for a supporting Claude instance. Blank keeps provider default. T3 describes a supported 100k–1m range in the inspected build; use the distribution's actual validator. |
| Cursor API endpoint | Cursor → Configuration. [Screenshot](references/t3-provider-cursor.png) | Missing. | Include for Cursor under Advanced. Do not enable the provider as a side effect of opening its form. |
| OpenCode server URL and password | OpenCode → Configuration. [Screenshot](references/t3-provider-opencode.png) | Missing. | Include for OpenCode under Advanced. A blank URL lets T3 start it when needed. Preserve the explicit plain-text-storage caveat on the optional password; do not call it an encrypted secret. |
| Favorite and hide models | Instance → Models. [Screenshot](references/t3-provider-models.png) | Existing favorites/visibility behavior. | Preserve Strata's current authority; do not reset it when adding engine settings. |
| Model ordering and custom models | Instance → Models. [Screenshot](references/t3-provider-models.png) | No equivalent complete ordering/custom-model management in the inspected form/model. | Add supported order controls and custom model ID entry. Use current engine model metadata for names and options. |
| Account parking, Auto selection, terminal defaults | Existing Strata Accounts UI. [Screenshot](references/strata-accounts.png) | Present and owned by Strata's account store. | Preserve. They are not missing settings to reimplement. The local T3 fork has some related fields, so avoid competing write authorities. |
| Subscription usage meters (Session, Weekly, reset time, plan label) | Not a T3 setting. The captured values come from a fork-only server field; the official package does not send it. [Screenshot](references/strata-accounts.png) | Present in Accounts, with the last reading persisted per instance. | Measure in Strata's main process for Claude and Codex, per the plan's usage measurement section. Existing readings carry over on the switch. |

Grok was also opened. Its Configuration tab showed the common name, accent color, environment-variable controls, and a binary path, with an Early Access label. It needs the same conditional provider form, not another setup page. [Actual Grok configuration](references/t3-provider-grok.png).

The actual T3 source and the local fork can differ in account behavior. No local-only field should become a requirement that forces users onto that fork.

## T3 Connect and direct connections

| Actual control | T3 location and evidence | Strata treatment |
| --- | --- | --- |
| Sign in to T3 Connect | Settings navigation footer. Opens “Sign in to T3 Code” with Apple, GitHub, Google, Microsoft, and email options in the inspected app. [Real login screen](references/t3-connect-signin.png) | Add T3 Connect section and “Sign in to T3” action. Pass through to official T3 authorization. Do not reproduce a Strata-branded credential form. |
| T3 Connect access switch | Settings → Connections → This environment. Disabled while signed out. [Screenshot](references/t3-connections.png) | Include. Distinguish signed out, authorizing, linked, connecting, connected, unavailable, and reauthentication required. Link completion alone is insufficient evidence of a working tunnel. |
| Publish agent activity | Same section. Disabled while signed out. Description names mobile push and Live Activities and says the tunnel is not required. [Screenshot](references/t3-connections.png) | Include as a separate optional choice. Explain data leaves for T3 notifications. Do not turn it on merely because an account was discovered. Platform notification support must match the actual mobile app. |
| Network access | Connections → This environment. Off with “Limited to this machine.” [Screenshot](references/t3-connections.png) | Keep loopback-only for normal local use. Put direct LAN access under Advanced, with explicit restart and exposure feedback. Do not switch it on to make T3 Connect work without evidence it is required. |
| Tailscale HTTPS | Connections → This environment. The test displayed a prompt to start Tailscale. [Screenshot](references/t3-connections.png) | Advanced optional path. Detect availability and show the real requirement. Tailscale configuration and actual connection were not tested. |
| Pairing links, endpoint selection, scopes, session revocation | Not exposed in the audited signed-out/loopback state. Documented by upstream; authenticated branch needs further UI inspection. [Remote-access documentation](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md) | Preserve external pairing; add advanced management using upstream APIs. Inspect and capture these conditional controls in phase 1. Do not claim a screenshot of a hidden flow was obtained. |
| Add environment | Connections → Remote environments. Visible in the audited app. [Screenshot](references/t3-connections.png) | Keep Strata's existing external-server option. Managing several simultaneous environments and SSH-launch UX are separate work, not required for the bundled local server. |

## Source control and generated text

| Actual control | T3 location and evidence | Strata treatment |
| --- | --- | --- |
| Git and source-control provider readiness | Settings → Source Control. Git available; GitHub unauthenticated; GitLab/Azure missing in this test. [Screenshot](references/t3-source-control.png) | Report actual tool/account status. Most visible switches in this state are disabled status indicators, not settings the user needs to copy. T3 sign-in does not authenticate GitHub. |
| Source control writing style | Source Control → Text generation. Repository conventions, Conventional Commits, Custom instructions. [Screenshot](references/t3-source-control-writing.png) | Include in General → Advanced → Source control writing. Preserve for engine operations and mobile use without adding an unrelated PR interface. |
| Custom writing instructions | Revealed after choosing Custom instructions. [Screenshot](references/t3-source-control-writing.png) | Include conditionally. Preserve text when temporarily choosing another mode. |
| Follow change request templates | Same section. [Screenshot](references/t3-source-control-writing.png) | Include. Observed on. |
| Separate source control writer model | Same section. Off uses the General model. [Screenshot](references/t3-source-control-writing.png) | Include switch and a conditional model/options picker. Enabling the switch revealed the writer-model button. Reuse the validated model-selection interface. [Enabled state](references/t3-source-control-model.png). |

## Settings that should not become extra setup

| Control or category | Evidence and ownership | Decision |
| --- | --- | --- |
| Project grouping, time format, hide whitespace, show skills, confirmation preferences, hold to quit | Visible in General. [Top](references/t3-general-top.png), [lower section](references/t3-general-workspaces.png). These drive T3 client behavior. | Preserve Strata's existing interaction choices. Bundling a server does not require copying T3's frontend preferences. |
| Appearance and Keybindings | Present in the actual settings navigation. These pages were not audited field by field. | Keep Strata's design and shortcuts. Do not import a remote theme into Strata unexpectedly; preserve unused server theme fields. |
| Browser viewport, zoom, appearance, recording rate, floating preview | Settings → Integrations → Browser. [Screenshot](references/t3-integrations.png) | These belong to T3's browser UI, not a general server setup checklist. No replacement UI in this bundling release. |
| Allow agent browser access | Same Browser section. On in the inspected app. The server injects the preview tools and routes each call to the client registered as automation host. [Screenshot](references/t3-integrations.png) | Decided September 5, 2026: stays on. Strata's own browser registers as the automation host and executes T3's native preview tools; that browser is a separate plan in progress. Until it lands, calls fail the same way T3 fails with no desktop attached. |
| Plan mode and Sidebar legacy switches | General → Legacy features. [Screenshot](references/t3-general-legacy.png) | T3 interface preferences. Do not add them to Strata just for server bundling. |
| Stream token by token (legacy) | General → Legacy features. [Screenshot](references/t3-general-legacy.png) | Server-controlled compatibility setting. Keep the normal buffered default. Preserve imported values; no prominent new control. Reassess only if Strata's rendering needs an explicit compatibility override. |
| Update track and Check for Updates | General → About. [Screenshot](references/t3-general-workspaces.png) | T3 desktop update controls. Replace operational ownership with Strata's updater. Do not expose a T3 desktop update action that could replace the wrong application. |
| Diagnostics | General → About → View diagnostics. [Screenshot](references/t3-general-workspaces.png) | Link local, sanitized engine diagnostics from This computer → Engine details. |
| Continue threads after restarts | Found in newer upstream material, not in the inspected 0.0.37 UI. | Not counted as a verified missing control. Reinspect the packaged release. If supported, define explicit behavior for active threads and expose a matching optional control. Do not promise automatic resumption based only on a newer source field. |

## Finish the conditional audit during implementation

Before treating this mapping as the release checklist for a newer distribution, inspect that actual build. Complete the authenticated T3 Connect/device-management branch, clean-machine provider login and installation, and any newly added provider fields. Capture differences and update this file rather than assuming the installed 0.0.37 UI is permanent.

These remaining checks qualify the unvisited branches. The screens and defaults explicitly marked observed above were obtained by using the running apps and viewing the captures.

## Upstream setting keys

The server setting each Include control reads and writes, from the contracts in upstream 0.0.38. Keys are on the server settings object unless a path is shown. Two provider-instance keys were not found by name and are marked to confirm.

| Control | Upstream key |
| --- | --- |
| New threads: Local / New worktree | `defaultThreadEnvMode` |
| Start from origin | `newWorktreesStartFromOrigin` |
| Add project starts in | `addProjectBaseDirectory` |
| Auto-settle merged threads | `sidebarAutoSettleOnMerge` |
| Auto-settle inactive threads and days | `sidebarAutoSettleAfterDays` (off maps to disabled, not a large number) |
| Text generation model and effort | `textGenerationModelSelection` (`instanceId`, `model`, options) |
| Provider update checks | `enableProviderUpdateChecks` |
| Background activity profile | `backgroundActivityProfile` and `backgroundActivity.profile` / `baseProfile` / `overrides` |
| Git fetch interval | `backgroundActivity.overrides.automaticGitFetchInterval` |
| Provider health interval | `backgroundActivity.overrides.providerHealthRefreshInterval` |
| Active and idle host power intervals | `backgroundActivity.overrides.hostPowerMonitorActiveInterval`, `hostPowerMonitorIdleInterval` |
| Pause when locked, host low power, client low power, on battery | `backgroundActivity.overrides.pauseWhenHostLocked`, `pauseWhenHostLowPower`, `pauseWhenClientLowPower`, `pauseWhenOnBattery` |
| Source control writing style, custom instructions, templates | `sourceControlWritingStyle` (confirm its sub-keys in phase 3) |
| Separate writer model | `sourceControlWriterModelSelection` |
| Allow agent browser access | `enableAgentBrowserAccess` |
| Stream token by token (legacy, preserved only) | `enableLegacyTokenStreaming` |
| Provider enabled, display name | `providerInstances.<id>.enabled`, `displayName` |
| Binary path, account home, shadow home, launch arguments | `providerInstances.<id>.config.binaryPath`, `homePath`, `shadowHomePath`, `launchArgs` |
| Claude Auto-compact after | `providerInstances.<id>.config.autoCompactWindow` |
| Cursor API endpoint | `providerInstances.<id>.config.apiEndpoint` |
| OpenCode server URL and password | `providerInstances.<id>.config.serverUrl`, `serverPassword` |
| Model ordering, hidden models, custom models | `providerInstances.<id>.config.modelOrder`, `hiddenModels`, `customModels` |
| Accent color | `providerInstances.<id>` — confirm the key name in phase 3 |
| Environment variables and secrets | `providerInstances.<id>` — confirm the key name and the secret reference shape in phase 3 |
| Terminal defaults, parking, Auto (fork-only on the server) | Not written. Strata's own store is the authority. |
| T3 Connect sign-in, link, publish | Not server settings. The `t3 connect` subcommands and the upstream credential store. |
