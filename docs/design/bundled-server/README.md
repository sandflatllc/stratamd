# Bundled T3 server: proposed dialogs

Review captures for [the bundled server plan](../../plans/open/bundled-t3-server-2026-09-05/plan.md). Each screen is one Include group from that plan's settings audit, drawn as an extension of the dialogs Strata already has rather than a new settings surface.

These are captures of the real app: the built main process, the fake T3 engine the e2e suite uses, the shipped Strata Vivid theme, and the proposed dialogs injected with the renderer's own classes. Nothing here is product code, and the app is not changed by running it. `dialogs.ts` holds the markup; `capture.spec.ts` injects and screenshots it.

## Screens

| Capture | Audit rows it covers | What is new |
| --- | --- | --- |
| [Accounts](captures/accounts.png) | Add provider, enabled state, parking, terminal defaults, usage meters | Nothing but the footer: Engine becomes This computer. This is the real dialog. A machine with nothing signed in shows the same dialog with Sign in or Install in the account row. |
| [Manage an account](captures/provider-claude.png) | Accent color, environment variables, binary path, account home, launch arguments, Auto-compact after; also the OpenCode server fields and the Models tab's order and custom model controls | The existing Manage view from the account's menu, with accent swatches, the variable list with Saved · hidden for secrets, and the compaction field under Advanced. OpenCode shows its server URL and password here with T3's plain-text caveat; the Models tab adds up and down beside the star and Hide plus a custom model id. |
| [Settings](captures/general.png) | New threads, Start from origin, Add project starts in, auto-settle switches and days, text generation model | A single dialog from the logo menu. Start from origin shows because New worktree is chosen. |
| [Settings, Advanced open](captures/general-advanced.png) | Provider update checks, background profile, source control writing style, custom instructions, templates, separate writer model | The Advanced disclosure. Custom instructions and the writer model row show because their switches are on. |
| [Background activity](captures/background.png) | Shared policy, four intervals, four pause switches | T3's tuning dialog as a Strata dialog, reached from Tune… beside the profile. |
| [This computer](captures/this-computer.png) | Engine status, T3 Connect sign-in, publish activity, close behavior, start at login | Replaces the Engine dialog for the managed engine. Sign in to T3 is the only T3-branded action. |
| [This computer, connected](captures/t3-connected.png) | T3 Connect access, publish activity, network access, Tailscale, pairing links, session revocation | The signed-in section and the Advanced connections disclosure open. |
| [Engine stopped](captures/recovery.png) | Recovery | The real shell shows Disconnected behind the dialog; the dialog names the failure and offers Restart. |

Sample data throughout. The signed-in T3 Connect state is the intended result, not a tested one.

## Prototype-only styling

`PROTOTYPE_STYLE` in `dialogs.ts` adds a select that matches the existing input, a two-column setting row, a section heading inside a dialog, swatches, and the variable and device lists. Everything else is the renderer's stylesheet. Implementation replaces those few classes with real ones and keeps the rest.

## Capture

From the repository root, after `./node_modules/.bin/electron-vite build`:

```sh
xvfb-run -a ./node_modules/.bin/playwright test -c docs/design/bundled-server/playwright.config.ts
```

It runs one serial Playwright test on the inherited display and writes `captures/*.png` at 1440 × 1000. It is not part of the test gate.
