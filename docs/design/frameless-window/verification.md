# Frameless window verification

Implemented September 4, 2026 from the owner's approved [mockup](./prototype.html).

The production header is 52 CSS pixels high. The logo menu contains Open file, Accounts while paired, Theme, and Reset zoom when needed. Linux window controls use a guarded preload bridge; Close flushes the pending editor buffer and enters the existing Save / Discard / Cancel flow. macOS retains native traffic lights.

## Screenshots

These captures come from isolated Electron instances with temporary profiles:

- [Logo menu with all actions and account attention](./captures/implementation/menu-all-actions.png)
- [Strata Vivid at 1440 pixels](./captures/implementation/strata-vivid-1440.png) and [960 pixels](./captures/implementation/strata-vivid-960.png)
- [Paper at 1440 pixels](./captures/implementation/paper-1440.png) and [960 pixels](./captures/implementation/paper-960.png) (Paper was retired on 2026-09-04; the captures stay as evidence for this verification)
- [Strata at 1440 pixels](./captures/implementation/strata-1440.png) and [960 pixels](./captures/implementation/strata-960.png)

The header fits at 1440, 1200, 1000, and 960 pixels without wrapping or horizontal overflow. Tests inspect the draggable spacer and the navigation's non-draggable region. The screenshot review includes the updated shell, Contents, and component-sampler baselines against the previous captures and the structured-reading prototype. The table-header baseline did not change.

To reproduce the theme and menu captures after building:

```sh
STRATAMD_FRAMELESS_CAPTURES=docs/design/frameless-window/captures/implementation \
  xvfb-run -a ./node_modules/.bin/playwright test test/e2e/frameless-window.spec.ts
```

## Desktop checks

Electron 44.0.0 was checked in an isolated KWin 6.7.4 virtual session with both native Wayland and XWayland, at scale 1. Actual window controls successfully minimized, maximized, and restored the window. Changes initiated outside the renderer updated the maximize/restore icon. Fullscreen hid the custom controls and restored them on exit. See [results](./captures/implementation/kwin-checks.json), [Wayland maximized](./captures/implementation/kwin-wayland-maximized.png), and [XWayland restored](./captures/implementation/kwin-x11-restored.png).

Pointer gestures remain unverified: the nested session did not respond to the XTest input-injection attempt. This includes edge/corner resizing, header dragging, double-click maximize, dragging to restore, tiling, modifier-drag, and the title-bar system menu. Alt+F4 and real macOS traffic-light placement also remain unverified. These limitations are not failures observed in the app.

The owner's profile was not used for verification. The owner confirmed Strata was closed before installation.

## Packaged build

The Linux x64 package was built with Electron 44.0.0 into `dist/frameless-staging/linux-unpacked`, using the native dependencies already exercised by the gate. Both packaged CLI tests passed. An isolated launch of `stratamd-app` confirmed `app.isPackaged`, loading from `resources/app.asar`, the 52-pixel header, visible window controls, and the logo menu, with no renderer errors. See the [packaged-build screenshot](./captures/implementation/packaged-launcher.png).

```sh
./node_modules/.bin/electron-builder --linux dir \
  --config.directories.output=dist/frameless-staging --config.npmRebuild=false
STRATAMD_PACKAGED_ROOT="$PWD/dist/frameless-staging/linux-unpacked" \
  ./node_modules/.bin/vitest run test/integration/packaged-cli.test.ts
```

The gate exposed two timing assumptions in an existing table test: it could open controls before row selection replaced the collapsed controls, and inject independent table state before the editor processed the acknowledgement of an optimistic sort. The test now waits for row selection, then the sort acknowledgement and render before injecting that state. Five consecutive runs passed with both waits. Its pointer also leaves the table through document content rather than the native drag region. A repeat unit run had one failure in the existing persistence test's fixed 150 ms wait; all nine tests in that file passed separately, then all 764 unit/integration tests passed on subsequent full runs. No persistence or table implementation code changed.

An initial parallel validation attempt collided in Xvfb's automatic display allocation. Another attempt used the machine's 640×480 default virtual screens and produced unreliable UI results. The final shards use explicit distinct display numbers and 1920×1200 screens, preserving serial pointer/hover tests within each display. The responsive component test now explicitly sets a 960-pixel viewport before asserting its stacked layout, instead of relying on the host display to produce a narrow initial window. All four conversation-comment checks also passed on recheck.

## Final results

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Unit/integration | 764 passed; one packaged-only test skipped in the ordinary gate |
| Electron build | Passed |
| End-to-end | 160 passed across four shards of 40; the fourth shard passed after the test synchronization and viewport fixes |
| Packaged CLI | Both tests passed, including the packaged-only test |
| Packaged GUI | Launch, window controls, 52-pixel header, and logo menu passed; no renderer errors |
| Package contents | All 85 compiled files match the final build byte for byte |

The final end-to-end runs used this command for shard numbers 1 through 4, with a distinct display number for each concurrent run:

```sh
xvfb-run --server-num=971 --server-args='-screen 0 1920x1200x24' \
  ./node_modules/.bin/playwright test --shard=1/4 --output=/tmp/strata-frameless-shard-1
```

The launcher target is `dist/linux-unpacked/stratamd`, as configured in `~/.local/share/applications/stratamd.desktop`. Installing this package does not require changing that desktop entry.

## Continuous background refinement

The owner requested a continuous background through the top bar. Removed its separate fill and bottom border so the shell gradient and ambient effects remain visible behind the controls. The implementation screenshots above and the shell baseline now show this refinement; the original mockup and KWin captures remain historical references.

All six focused window and visual checks passed, followed by a shell-baseline refresh and packaged GUI smoke check. Reviewed the dark, light, narrow, menu-open, and packaged screenshots. TypeScript and the ordinary unit/integration run had already passed before the owner requested narrower verification. The full end-to-end suite was not rerun for this styling change.
