# T3 parity verification

The reference gallery is [t3-feature-comparison](../t3-feature-comparison/index.html). Captures use the shipped Strata Night theme and a 1440 by 1000 window. Sample project names, credentials, paths and accounts differ from the gallery. Controls use the existing Strata theme tokens and Lucide icons.

| Flow | Built app | Gallery reference |
| --- | --- | --- |
| Engine details | ![Engine details](captures/engine-details.png) | ![Reference](captures/reference-engine-details.png) |
| Pair again | ![Pair again](captures/engine-pair.png) | ![Reference](captures/reference-engine-pair.png) |

Engine facts use the gallery's order and right alignment. A nonrenewing credential needs a longer Session explanation. The expanded form scrolls inside short windows. The existing shell and modal type scale are retained.

## Add project

Back links sit in the header as the plan requests. Folder paths can be typed and opened with Browse or Enter. This additional Browse action makes path navigation explicit. The source picker retains the gallery's row order; each later step retains Cancel and its named primary action.

| Step | Built app | Gallery reference |
| --- | --- | --- |
| sources | ![Built app](captures/project-sources.png) | ![Reference](captures/reference-project-sources.png) |
| local | ![Built app](captures/project-local.png) | ![Reference](captures/reference-project-local.png) |
| new-folder | ![Built app](captures/project-new-folder.png) | ![Reference](captures/reference-project-new-folder.png) |
| url | ![Built app](captures/project-url.png) | ![Reference](captures/reference-project-url.png) |
| github | ![Built app](captures/project-github.png) | ![Reference](captures/reference-project-github.png) |
| destination | ![Built app](captures/project-destination.png) | ![Reference](captures/reference-project-destination.png) |

## Provider setup

Configuration and Models use the gallery's 800-pixel frame. Codex has both account and shadow home paths, as requested in the plan. Enabled uses a switch. Model preferences save immediately, so that tab uses Done and explains the behavior. The gallery's model names and account counts are examples; the built app renders the server report.

| Step | Built app | Gallery reference |
| --- | --- | --- |
| overview | ![Built app](captures/provider-overview.png) | ![Reference](captures/reference-provider-overview.png) |
| config | ![Built app](captures/provider-config.png) | ![Reference](captures/reference-provider-config.png) |
| models | ![Built app](captures/provider-models.png) | ![Reference](captures/reference-provider-models.png) |
| pick | ![Built app](captures/provider-pick.png) | ![Reference](captures/reference-provider-pick.png) |
| identity | ![Built app](captures/provider-identity.png) | ![Reference](captures/reference-provider-identity.png) |
| new-config | ![Built app](captures/provider-new-config.png) | ![Reference](captures/reference-provider-new-config.png) |

## Working copies

The workspace menu offers only previous worktrees reported by this project. Local refs are read-only. New worktrees select their base and origin preference before sending. The existing composer layout is retained.

| Step | Built app | Gallery reference |
| --- | --- | --- |
| start | ![Built app](captures/workspace-start.png) | ![Reference](captures/reference-workspace-start.png) |
| choices | ![Built app](captures/workspace-choices.png) | ![Reference](captures/reference-workspace-choices.png) |
| base | ![Built app](captures/workspace-base.png) | ![Reference](captures/reference-workspace-base.png) |
| new | ![Built app](captures/workspace-new.png) | ![Reference](captures/reference-workspace-new.png) |

## Terminal

The drawer sits below the center pane and leaves the existing right rail visible. The built capture uses real Ghostty WASM with an engine fixture echoing input. The header displays the server shell label and cwd.

| Built app | Gallery reference |
| --- | --- |
| ![Terminal](captures/terminal-open.png) | ![Reference](captures/reference-terminal-open.png) |

## Usage

Usage uses the gallery's header, toolbar, metrics, provider chart and breakdown inside the requested modal. Its fixture has two providers and two models. The 24-hour chart retains empty hours; daily windows include every day. The footer distinguishes the API estimate from subscription bills. Accounts now fits Add provider and each row's Manage action on one line.

| Built app | Gallery reference |
| --- | --- |
| ![Usage tokens](captures/usage-tokens.png) | ![Reference](captures/reference-usage.png) |
| ![API estimate](captures/usage-cost.png) | ![Reference](captures/reference-usage.png) |

Ghostty receives foreground, background, cursor and selection colors from the active Strata theme. ANSI colors inside shell output remain terminal content. The theme source-literal scan excludes the unchanged vendor adapter.
