# External window capture audit

Read-only inspection of pinned upstream `08463e2c401ce87858aaaebcb70ed86fb002fb5f` at `/tmp/strata-t3-implementation-source`. No screenshots, window enumeration, accessibility reads, profile inspection, installation or repository changes were performed.

## Recommendation and actual host

Ship an explicit system/window picker with screenshot-only annotation first. Reuse Strata's existing staged-image VisualSession, marks, Hold, and Send. Treat direct foreground-window capture and native accessibility as separate capabilities, each with actual prerequisites.

Host metadata reports CachyOS (Arch family), KDE Plasma, Wayland, WAYLAND_DISPLAY=wayland-0, DISPLAY=:0. Read-only portal introspection reports Screenshot v2, GlobalShortcuts v2, ScreenCast v5. Upstream's direct portal capture requires Screenshot v3 and AvailableTargets bit 8, so that route is unavailable here. `kbuildsycoca6`, `gdbus`, Rust/cargo, pkg-config and xkbcommon 1.13.2 exist. `loginctl show-session self` could not identify a session; environment and portal evidence establish the usable session. Tool existence does not prove native helper build/capture success.

The official Electron [desktopCapturer documentation](https://www.electronjs.org/docs/latest/api/desktop-capturer) says PipeWire returns a single selected source. Do not build a Linux picker assuming getSources enumerates all windows. Use the system picker on Wayland and a Strata chooser where enumeration is actually supported. Empty/cancelled capture must exit without changing a draft. A screen selected by the user is a screenshot, not verified active-window metadata.

## Reuse in Strata

- `src/renderer/components/VisualSession.tsx` already accepts a capture, optional staged source, destination and onHold. Omit page/describe/onScroll/onAdjust for external screenshots. It then uses region marks instead of DOM targets and has no live-page adjustment behavior.
- `src/renderer/App.tsx:534` opens annotation over a staged image; staged-session rendering near line 572 wires Hold/cancel/close. Reuse this flow with source label identifying the captured window when known. Bind destination before opening capture and revalidate engine/project/thread identity before staging or holding after the asynchronous picker.
- `src/shared/contracts.ts` `stageConversationAttachment` and `src/main/engine/client.ts` stageAttachment already store PNG bytes durably; this is the shortest screenshot-only route. `VisualEvidenceStore` in `src/main/engine/visual-evidence.ts` retains immutable marked captures when held. No second screenshot store or alternate delivery mechanism is necessary.
- `src/main/visual-comment-image.ts`, `src/core/visual-comments.ts` and the existing visual-comment send path preserve marked screenshots and commentary. Reuse their attachment budget and restart retention.
- No current Strata desktopCapturer adapter was found. Add a bounded main-process capture boundary and a typed preload result. Do not expose arbitrary source ids that a renderer can reuse indefinitely; stale selection should fail or re-prompt.

## Upstream pieces and platform requirements

All following paths are relative to the pinned source directory.

| Capability | Exact reusable paths | Runtime/build requirement |
| --- | --- | --- |
| Capture orchestration/state | `apps/desktop/src/snapShot/DesktopSnapShot.ts`, `snapShot.ts` | T3-specific settings/Effect/notification/draft integrations need adaptation, not wholesale copy |
| Linux portal/picker fallback | `LinuxSnapShot.ts`, `linuxCaptureSession.ts` | dbus-next 0.10.2 for direct portal logic; Electron PipeWire system picker fallback; validate PNG signature, maximum 32 MB, positive dimensions; resize within 2560×1600 |
| KDE direct foreground window | `KdeSnapShot.ts`; `native/kde-snap-shot/` | Rust 2024 crate, Cargo.lock, zbus 5.19, png 0.18, serde/serde_json, async-channel. Install native executable plus desktop entry with `X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2`, refresh kbuildsycoca6. Keep Strata-specific app id/path/marker; upstream installer explicitly installs only on user action |
| GNOME direct foreground window | `GnomeCaptureSetup.ts`, `gnomeCaptureBundle.ts`, `apps/desktop/gnome-extension/` | GNOME Shell extension and version compatibility; explicit enable/install; do not claim desktopCapturer provides its window identity |
| Hyprland direct capture | `HyprlandSnapShot.ts`; `native/hyprland-snap-shot/` | Rust 2024, Wayland protocol crates, smithay-client-toolkit and protocol XML; compositor-specific bindings/helpers; no KDE reuse |
| Niri | `NiriSnapShot.ts`, `NiriCaptureShortcut.ts` | Niri IPC socket and configured key binding; upstream niriCaptureBinding default is Ctrl+Shift+2 via gdbus |
| macOS direct foreground window | `ActiveWindow.ts`, `MacSnapShot.ts` | System osascript/JXA identifies frontmost app's on-screen layer-zero CGWindowNumber; `/usr/sbin/screencapture -l ID -o -x -t png PATH`; Screen Recording consent. Existing Electron nativeImage handles output sizing. No Rust capture helper required |
| Accessibility context | `SnapShotAccessibility.ts`, `SnapShotAccessibilityProcess.ts`, `SnapShotAccessibilityWorker.ts` | @crowecawcaw/xa11y 0.13.0 native package in separate bounded process; macOS Accessibility permission distinct from Screen Recording; Linux identity/bounds may be missing or unreliable. Omit this capability for initial screenshot-only fallback |
| Global shortcuts | `PortalCaptureShortcut.ts`, `CaptureShortcutConfig.ts`, `GlobalShiftShortcutProcess.ts`, `MacModifierPairShortcutProcess.ts` | Wayland portal vs macOS/Windows native hooks differ. Avoid double-Shift hooks in first version; use ordinary configurable shortcut with conflict reporting |

`DesktopSnapShot.ts` upstream marks Linux X11 capture unavailable, even though Electron has generic source enumeration elsewhere. Do not report upstream X11 support it does not implement. A separate Strata screenshot-picker implementation can support X11 with actual verification.

`DesktopSnapShot.ts` tries platform-native routes, then falls back to Electron getSources with window+screen types and first selected source. Under PipeWire that first source is the system user's choice; outside PipeWire blindly selecting the first source would be incorrect.

## Packaging and licenses

Root upstream LICENSE and native crate manifests are MIT, Copyright (c) 2026 T3 Tools Inc. Preserve license and provenance for copied files and adapted native code. `scripts/build-desktop-artifact.ts:2170` uses cargo build --locked --release with explicit Linux architecture target, stages executable under resources/kde-capture or hyprland-capture, chmod 0755. It copies Hyprland protocol XML notices because those protocols have BSD notices required for distribution. Include exact Cargo.lock plus dependency license inventory if shipping binaries.

T3 desktop dependencies include @crowecawcaw/xa11y 0.13.0, dbus-next 0.10.2, ffi-rs 1.3.2. Do not add xa11y/ffi-rs just to use Electron screenshot selection. Native packages require architecture-specific unpacking and packaging checks; T3 engine npm package alone does not install the desktop behavior.

KDE setup source provides useful protections: regular-file/symlink checks, identity marker before overwrite, atomic staging, explicit install/remove state, bundle equality checks, setup states not-installed/update-required/ready/error. Reuse these if choosing helper installation; never write to T3's own helper installation paths or desktop id.

## Capability and interaction design

Expose screenshot selection, direct active-window capture, and accessible-text capture independently. Label outcomes in plain words: 'Choose a window', 'Capture active window', and 'Screenshot only' when metadata/text unavailable. Screenshot-only works with marks and notes; it must not advertise live editing, element targeting, scrolling, or agent browser control.

Capture button should always be usable without a global shortcut. Start from the chosen conversation, show system picker/chooser, open the existing annotation session, then Hold/Send through normal paths. Keep screenshot review visible before submission. No automatic send after capture. Bind shortcut only when enabled; failed registration shows why and leaves button available. Official [Electron globalShortcut documentation](https://www.electronjs.org/docs/latest/api/global-shortcut) describes Wayland GlobalShortcutsPortal support; configure before app-ready and preserve any existing feature flags when enabling it. Do not install compositor keybindings silently.

## Workable verification plan

1. Unit-test platform capability classification with recorded session metadata, permission-denied/cancel/empty PNG responses, disappearing source, positive dimension/size limits, and captured destination changing during picker wait. Test the adapter boundary, not duplicate Electron logic.
2. Add focused Electron flow under isolated Xvfb with a deliberately created fixture window. Verify selecting its source produces the fixture pixels, VisualSession region marking, Hold/reopen, and send with original and marked PNGs. Never enumerate the owner's desktop in the automatic suite.
3. For this Wayland host, ordinary Xvfb does not certify PipeWire/system-picker behavior. Use a separate nested compositor/isolated D-Bus session with disposable test windows and portal backend if available. Otherwise a supervised host test requires the user to select a synthetic fixture window in the real picker. Do not capture or record the owner's unrelated windows.
4. Direct KDE helper is an additional test track: build/stage in task directories, inspect executable and library dependencies, test setup under disposable XDG paths, and run inside isolated KDE session. Actual host helper installation is a concrete separate change and was not performed by this audit.
5. macOS Screen Recording denial/grant, direct CGWindow selection, and optional Accessibility permission need a macOS machine. Linux results cannot certify them. Keep capability unavailable or unverified accordingly.
6. Run the repository final gate after integration, with any platform exclusions stated. Screenshot-only picker success does not prove native accessibility or direct foreground capture.
