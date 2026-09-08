# Document background mockup

Open `index.html` directly in a browser or Strata's web preview. Everything is embedded; no server or network access is needed.

The recommendation is an opaque document reading panel with an optional shadow. Its width follows the document measure, it starts 12px below the existing toolbar, and all four corners have the transcript wrapper's 14px radius. It fills the remaining reading viewport and scrolls internally. The toolbar uses its existing product CSS inside the existing rounded, bordered editor container; the mockup no longer adds a toolbar fill, changes its padding, or removes its divider. The ambient background remains visible in the margins. Open removes the panel without moving the text.

The controls mirror the transcript options: layout, background, border, shadow style, shadow color, and shadow strength from 0–300%. Reading width is included to demonstrate how the document panel adapts. The selected shadow is a proposed preview setting, not a change to stock theme defaults. These settings are local to the mockup and do not save to Strata.

## Actual Strata assets

- The TopBar (including Logo), Toolbar, Contents, and RailTabs components are imported from `src/renderer/components/`.
- Colors use `DEFAULT_THEME_VALUES` through `rendererThemeStyle`; layout and document typography use `src/renderer/styles.css`.
- Baloo 2 and JetBrains Mono font files are embedded from the installed product dependencies.
- The backdrop uses Strata's `skyRenderer`, Canvas fallback, and cloud texture worker. Its palette matches the earlier transcript edge study. It starts paused and can be played.
- The sample document and controls are mockup content. The existing application shell controls are shown for context; they do not operate a real document or connect to an engine.

No product files or saved settings were changed.

## Verification

Viewed at 1600 × 1000 in Chromium. Confirmed no horizontal page overflow, opaque/open transitions preserve text geometry, Open disables panel-only controls, background and border colors update, 200% shadow produces a 16px offset / 48px blur / 4px spread, reading width updates, Reset restores the defaults, and Contents scrolls to a section. No browser errors were reported. The full application gate was not run because this is a standalone visual prototype.

Rebuild from the repository root with `node docs/mockups/document-background/build.mjs`.

Current captures: `opaque-panel-v2.png`, `open-layout-v2.png`, and `scrolled-v2.png`. The original captures remain for comparison.

Revision 2 addresses both visual comments: restored the existing editor frame and toolbar styling, added a 12px gap before the document wrapper and scroll boundary, and rounded all four wrapper corners to 14px. Verified the gap and corner radii before and after scrolling; the toolbar remains fixed.
