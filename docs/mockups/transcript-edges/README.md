# Transcript edge study

Interactive HTML/CSS comparison of six transcript boundaries. The transcript and composer are cropped from Dillon's supplied screenshot without redrawing the text. The backdrop uses Strata's existing nebula renderer, bundled locally with its texture worker. Its framing and palette approximate the supplied capture.

Open `index.html` directly in Strata or a browser. It is self-contained, including the screenshot, styles, renderer, and a worker created from an embedded script. No server is required. It can also be served over HTTP:

```sh
python3 -m http.server 4387 --bind 127.0.0.1 --directory docs/mockups/transcript-edges
```

Visit http://localhost:4387. Choose a treatment, adjust its width and strength, or switch to a corner/bottom close-up. The comparison button temporarily restores the hard edge. Motion can be paused and starts paused when reduced motion is requested.

To rebuild the bundled renderer after changing the study or its source modules, run from the repository root:

```sh
node docs/mockups/transcript-edges/build.mjs
```

This is a visual prototype. It does not alter Strata's transcript styles. The screenshot content is fixed; the boundary effects and nebula are rendered by the browser. Widths use the original screenshot's 1932 × 966 coordinate system; strength scales feather reach, shadow opacity, or glass rim visibility depending on the selected treatment.
