# StrataMD — Ambient animation handoff

Spec for the ambient animation system prototyped in `StrataMD App v2.dc.html`. Two independent settings, one master toggle. All values below are final as tuned in the mockup.

## Settings model

- `animatedBackground: boolean` (default `true`) — master gate; when false, no ambient animation renders anywhere.
- `backgroundStyle: enum` (default `"Rising motes"`) — full-app background layer.
- `windowStyle: enum` (default `"Glow orbs"`) — decoration inside each panel/island (explorer, editor, changes, annotations, agents).

Both enums share the same 8 options: `Rising motes | Aurora drift | Starfield | Grid drift | Glow orbs | Shimmer sweep | Breathing tint | None`. Same visual language at two scales — page-scale for background, card-scale for windows.

## Layer contracts

**Background layer**: one absolutely-positioned container directly inside the app root, behind all content: `position:absolute; inset:0; overflow:hidden; pointer-events:none`. App root background (always on, static): `#0a0810` with `radial-gradient(1400px 900px at 30% -10%, #141026, #0a0810 60%)`.

**Window layer**: each panel has `position:relative; isolation:isolate; overflow:hidden` (cards are `background:#241e3b; border:1px solid #463c6e; border-radius:22-24px`). Decoration container per panel: `position:absolute; inset:0; pointer-events:none; z-index:-1; overflow:hidden`. `isolation:isolate` is required so `z-index:-1` stays inside the card instead of dropping behind it.

## Palette (rgba used by animations)

pink `255,92,138` · tangerine `255,176,58` · mint `61,201,124` · sky `79,141,255` · grape `155,92,255` · near-white `#f4f3f6` / lavender `#d5beff` / ice `#b0ccff` / rose `#ff9dbb` / peach `#ffd9a1` / mint-lt `#a7e8c4`. All opacities ≤ .14 on page scale, ≤ .35 for dots — ambient, never louder than content.

## Keyframes (verbatim)

```css
@keyframes bgShift{0%,100%{background-position:0% 0%}50%{background-position:100% 100%}}
@keyframes rise{0%{transform:translateY(20px);opacity:0}12%{opacity:.7}88%{opacity:.7}100%{transform:translateY(-105vh);opacity:0}}
@keyframes glow1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(120px,-70px) scale(1.25)}}
@keyframes glow2{0%,100%{transform:translate(0,0) scale(1.1)}50%{transform:translate(-90px,60px) scale(0.9)}}
@keyframes glow3{0%,100%{transform:translate(0,0)}50%{transform:translate(60px,90px)}}
@keyframes innerA{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(34px,-24px) scale(1.18)}}
@keyframes innerB{0%,100%{transform:translate(0,0) scale(1.08)}50%{transform:translate(-28px,20px) scale(0.9)}}
@keyframes moteWander{0%,100%{transform:translate(0,0)}25%{transform:translate(16px,-20px)}50%{transform:translate(-10px,-34px)}75%{transform:translate(-18px,-12px)}}
@keyframes auroraA{0%,100%{transform:translate(-6%,0) rotate(0deg)}50%{transform:translate(7%,5%) rotate(7deg)}}
@keyframes auroraB{0%,100%{transform:translate(5%,0) rotate(0deg)}50%{transform:translate(-6%,-5%) rotate(-6deg)}}
@keyframes twinkle{0%,100%{opacity:.12;transform:scale(.85)}50%{opacity:.85;transform:scale(1.15)}}
@keyframes gridDrift{0%{background-position:0 0}100%{background-position:56px 56px}}
@keyframes sweep{0%{transform:translateX(-170%) skewX(-16deg)}60%,100%{transform:translateX(350%) skewX(-16deg)}}
@keyframes breathe{0%,100%{opacity:.3}50%{opacity:1}}
```

Note on `rise`: travel distance is `-105vh` — correct for the page background. For window-scale motes reuse it as-is (they exit the card via `overflow:hidden` long before 105vh; cheap and fine) or clamp to `-110%` of card height if you prefer.

## Variants — background scale

### Rising motes (default)
1. Gradient wash, `inset:0`: `linear-gradient(120deg, rgba(155,92,255,.08), rgba(255,92,138,.05) 30%, rgba(79,141,255,.07) 60%, rgba(61,201,124,.05))`, `background-size:300% 300%`, `bgShift 34s ease-in-out infinite`.
2. 9 dots, `border-radius:50%`, `bottom:-20px`, each `rise <dur>s linear <delay>s infinite`:

| x | size | color | dur | delay |
|---|---|---|---|---|
| left:9px | 9px | pink .4 | 26s | 0 |
| left:11px | 6px | tang .35 | 33s | 11s |
| left:247px | 8px | mint .35 | 29s | 5s |
| left:243px | 5px | grape .4 | 24s | 16s |
| left:52% | 7px | sky .35 | 31s | 8s |
| left:70% | 10px | tang .28 | 27s | 19s |
| right:330px | 7px | pink .32 | 30s | 3s |
| right:10px | 9px | grape .38 | 25s | 14s |
| right:13px | 6px | mint .32 | 35s | 7s |

Pixel offsets hug the app edges/panel seams; % offsets fill the middle. Staggered delays mean the field is mid-flight on first paint.

### Aurora drift
3 blurred ellipses (`background:radial-gradient(ellipse, <color>, transparent 65%)`):
- top:-30%, left:-12%, 70%×85%, grape .13, blur(60px), `auroraA 26s ease-in-out infinite`
- top:-22%, right:-15%, 65%×80%, sky .11, blur(60px), `auroraB 31s ease-in-out 4s infinite`
- bottom:-38%, left:18%, 62%×85%, pink .09, blur(70px), `auroraA 36s ease-in-out 9s infinite reverse`

### Starfield
14 dots, 2–3px, `border-radius:50%`, `twinkle <3.4–5.2>s ease-in-out <0–3.1>s infinite`. Positions/colors (top/left %): 8/6 3px `#d5beff` · 14/38 2px `#f4f3f6` · 5/62 3px `#b0ccff` · 20/84 2px `#f4f3f6` · 34/14 2px `#ff9dbb` · 42/52 3px `#f4f3f6` · 38/93 2px `#d5beff` · 58/8 3px `#b0ccff` · 66/34 2px `#f4f3f6` · 72/68 3px `#ffd9a1` · 84/22 2px `#f4f3f6` · 88/78 2px `#d5beff` · 52/76 2px `#a7e8c4` · 26/26 2px `#f4f3f6`. Vary duration AND delay per star so no two blink in sync.

### Grid drift
One `inset:0` div: `background-image: linear-gradient(rgba(155,92,255,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(155,92,255,.055) 1px, transparent 1px)`; `background-size:56px 56px`; `gridDrift 14s linear infinite`; fade at edges with `mask-image: radial-gradient(1000px 640px at 50% 38%, #000, transparent 82%)` (+ `-webkit-mask-image`). Drift distance must equal one cell (56px) for a seamless loop; grid pans down-right.

### Glow orbs
- top:-120px, right:4%, 560px circle, grape .10, blur(40px), `glow1 24s`
- bottom:-160px, left:2%, 620px circle, pink .08, blur(46px), `glow2 29s / 3s delay`
- top:38%, left:40%, 380px circle, sky .07, blur(40px), `glow3 33s / 6s delay`
- 2 wander motes: 7px tang .2 at 22%/10% (`moteWander 19s`); 8px mint .16 at 68%/right:14% (`moteWander 23s 5s reverse`)

### Shimmer sweep
One band: `top:0; bottom:0; left:0; width:40%`, `linear-gradient(105deg, transparent, rgba(155,92,255,.05) 45%, rgba(244,240,254,.04) 50%, rgba(155,92,255,.05) 55%, transparent)`, `sweep 16s ease-in-out infinite`. The keyframes hold at the end (`60%,100%` same pose) so each pass is followed by a ~6s rest.

### Breathing tint
One `inset:0` div: `radial-gradient(120% 90% at 50% -15%, rgba(155,92,255,.09), transparent 60%)`, `breathe 8s ease-in-out infinite`. Glow hangs from the top edge.

### None
Static root gradient only.

## Variants — window (per-panel) scale

Same recipes, miniaturized. When a variant repeats across the 5 panels, vary durations/delays per panel so islands never move in lockstep (mockup uses 14–18s + 0/2/4/5s delays for orbs).

### Glow orbs (default) — per-panel placements from the mockup
- Explorer: 200px mint .12 orb bottom:-60px/left:-50px blur(22px) `innerA 14s`; 150px grape .10 orb top:30%/right:-40px blur(20px) `innerB 18s 2s`; 5px tang .3 mote at top:58%/left:24px `moteWander 16s`.
- Editor (bigger canvas, bigger orbs): 460px grape .09 top:-100px/right:-80px blur(34px) `glow1 22s`; 520px pink .07 bottom:-140px/left:-90px blur(40px) `glow2 27s 3s`; 300px sky .06 top:44%/left:34% blur(34px) `glow3 31s 6s`; 3 wander motes 5–8px (tang .18 `19s`, mint .15 `23s 5s reverse`, pink .18 `17s 9s`).
- Changes: 190px grape .12 top:-50px/right:-60px blur(20px) `innerB 15s`; 5px pink .28 mote `moteWander 18s 4s`.
- Annotations: 180px tang .10 bottom:-60px/left:-50px blur(20px) `innerA 17s 2s`; 5px sky .3 mote `moteWander 20s reverse`.
- Agents: 170px sky .11 top:-40px/left:-50px blur(18px) `innerB 16s 5s`; 6px mint .28 mote `moteWander 21s 7s`.

### Shimmer sweep
Band `width:46%`, gradient stops grape .06 / near-white(`244,240,254`) .05 / grape .06, `sweep 11s ease-in-out infinite`.

### Breathing tint
`radial-gradient(130% 100% at 50% -10%, rgba(155,92,255,.1), transparent 62%)`, `breathe 7s ease-in-out infinite`.

### Rising motes
5 dots, 3–5px, bottom:-12px, `rise` 14–18s, delays 0/5/9/2/12s, at left 12/34/58/78/90%; colors pink .35, tang .3, grape .35, sky .3, mint .3.

### Aurora drift
2 blobs, blur(28px): grape .14 top:-40%/left:-15% 75%×90% `auroraA 18s`; sky .11 bottom:-40%/right:-15% 70%×90% `auroraB 23s 3s`.

### Starfield
7 stars, 2–3px, twinkle 3.4–5s, delays 0–2.6s: (top/left) 12/10 `#d5beff` · 22/68 `#f4f3f6` · 44/30 `#b0ccff` · 60/82 `#f4f3f6` · 76/18 `#ff9dbb` · 86/58 `#d5beff` · 34/90 `#ffd9a1`.

### Grid drift
`background-size:36px 36px`, line color grape .06, `gridDrift 12s linear infinite`, mask `radial-gradient(80% 70% at 50% 40%, #000, transparent 90%)`.

## Implementation notes for the repo

- Pure CSS: only `transform`, `opacity`, and `background-position` animate — all compositable; blurs are static. No JS ticking, no rAF.
- Every decoration container: `pointer-events:none`; window containers additionally `z-index:-1` inside an `isolation:isolate` panel.
- One shared keyframes block; variants differ only in element trees. A single `renderAmbient(style, scale)` factory covers both settings (scale = 'page' | 'card').
- Respect `prefers-reduced-motion: reduce` → treat as master toggle off (mockup gates by setting only; add the media query in production).
- Changing a variant may remount its elements; delays are all negative-free, so use staggered `animation-delay`s (already specced) to avoid a synchronized first cycle. If you want fields mid-flight instantly on style-switch, negate the delays (e.g. `-11s`).
- Settings gating: `animatedBackground === false` → render neither layer. `"None"` → skip that layer only.
