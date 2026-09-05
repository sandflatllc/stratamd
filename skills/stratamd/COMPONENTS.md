# Strata components

Nine registered tags render in Strata documents and conversation replies.
Anything else in angle brackets stays raw text.

Rules the parser enforces:

- The opening and closing tags sit alone on their lines at column 1, at
  the top level of the document. Inside a list, a blockquote, or a code
  fence the tag stays text.
- The body is one or more ordinary Markdown blocks. Components never nest.
- Properties are the ones listed here and nothing else. No colors, fonts,
  sizes, classes, styles, expressions, or scripts. The theme owns the look.
- A registered tag with the wrong body, an unknown property, or a nested
  component is kept byte for byte and shown as an error card that names the
  problem. It renders nothing.

## Callout

Context, a warning, an implication, or supporting material. Optional
`kind="context|warning|implication|support"`, default `context`. Body:
ordinary blocks; add a heading when it needs a title.

```md
<Callout kind="warning">
### Before continuing

Back up the local store before changing its format.
</Callout>
```

## Verdict

The controlling judgment at the top of a judgment-heavy section. Optional
`outcome="recommended|caution|blocked|neutral"`, default `neutral`. Body:
the judgment and its short rationale.

```md
<Verdict outcome="recommended">
### Adopt the bounded parser

It preserves source identity without allowing executable MDX.
</Verdict>
```

## MetricStrip

Figures that carry part of the argument. No properties. Body: one Markdown
list, one metric per item, each starting with a strong label.

```md
<MetricStrip>
- **Open time:** 224 ms
- **Typing:** 9.8 ms
- **Byte drift:** 0
</MetricStrip>
```

## PhaseBoard

Ordered phases of work with their supporting material. No properties.
Body: phase headings in execution order, each followed by prose, lists, or
tables.

```md
<PhaseBoard>
### Phase 1

| Work | Status |
|---|---|
| Parser | Complete |

### Phase 2

- Add editor views.
</PhaseBoard>
```

## DecisionMatrix

Two to six alternatives scored against the same criteria. No properties.
Body: exactly one GFM table whose first header is `Criterion`; every other
header names an alternative.

```md
<DecisionMatrix>
| Criterion | Keep current | Adopt bounded parser |
|---|---|---|
| Byte preservation | Partial | Strong |
| Executable content | Possible | Blocked |
</DecisionMatrix>
```

## BeforeAfter

One transformation, two named sides. No properties. Body: exactly two
blockquotes, each opening with an H3 that names its side, with ordinary
Markdown beneath.

```md
<BeforeAfter>
> ### Before
> Copy the document into chat and compare rewrites manually.

> ### With StrataMD
> Discuss tracked edits in the open document.
</BeforeAfter>
```

## Chart

A numeric relationship the table hides. Optional `kind="line|bar"`,
default `line`. Body: exactly one GFM table; the first column is labels,
then one to six numeric columns, at most 1,000 rows. The table stays the
editable source under the chart.

```md
<Chart kind="line">
| Month | Open time | Typing |
|---|---:|---:|
| Jul | 240 | 12.4 |
| Aug | 224 | 9.8 |
</Chart>
```

## EvidenceChain

A claim, the evidence behind it, and the conclusion it earns. No
properties. Body: H3 sections named exactly `Claim`, `Evidence`, and
`Therefore`, in that order. Evidence is a list, and every item carries a
local Markdown link or a same-document heading link. A bare "see section
3" fails.

```md
<EvidenceChain>
### Claim

Mechanical guards hold better than prose.

### Evidence

- [Database findings](./evidence.md#database-guards) — enforced invariants held.
- [CI findings](#ci-findings) — prose-only gates drifted.

### Therefore

Move the invariant into executable boundaries.
</EvidenceChain>
```

## AnnotatedScreenshot

Numbered pins on one local image with durable notes. No properties. Body:
exactly one local Markdown image, then one GFM table with the headers
`Pin`, `X`, `Y`, `Image version`, and `Note`. Pins are unique positive
integers, X and Y are percentages from 0 to 100, and the note is nonempty.

Strata generates the `Image version` cell from the file's size and
modification time. Propose a pin row only through a strata edit on a
document where that version already appears. Otherwise leave pins to the
owner's Place pin.

```md
<AnnotatedScreenshot>
![Review table](./review-table.png)

| Pin | X | Y | Image version | Note |
|---:|---:|---:|---|---|
| 1 | 24.0 | 31.5 | 48211:1788372000000000000 | Long rows need a clearer boundary. |
</AnnotatedScreenshot>
```
