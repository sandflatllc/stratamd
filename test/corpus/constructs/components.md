# Component corpus

<Callout kind="warning">
### Before continuing

Back up the local store before changing its format.
</Callout>

<Verdict outcome="recommended">
### Adopt the bounded parser

It preserves source identity without allowing executable MDX.
</Verdict>

<MetricStrip>
- **Open time:** 224 ms
- **Typing:** 9.8 ms
- **Byte drift:** 0
</MetricStrip>

<PhaseBoard>
### Phase 1

| Work | Status |
|---|---|
| Parser | Complete |

### Phase 2

- Add editor views.
</PhaseBoard>

<DecisionMatrix>
| Criterion | Keep current | Adopt bounded parser |
|---|---|---|
| Byte preservation | Partial | Strong |
| Executable content | Possible | Blocked |
</DecisionMatrix>

<BeforeAfter>
> ### Before
> Copy the document into chat and compare rewrites manually.

> ### With StrataMD
> Discuss tracked edits in the open document.
</BeforeAfter>

<Chart kind="line">
| Month | Open time | Typing |
|---|---:|---:|
| Jul | 240 | 12.4 |
| Aug | 224 | 9.8 |
</Chart>

<EvidenceChain>
### Claim

Mechanical guards hold better than prose.

### Evidence

- [Database findings](./evidence.md#database-guards) — enforced invariants held.
- [CI findings](#ci-findings) — prose-only gates drifted.

### Therefore

Move the invariant into executable boundaries.
</EvidenceChain>

<AnnotatedScreenshot>
![Review table](./review-table.png)

| Pin | X | Y | Image version | Note |
|---:|---:|---:|---|---|
| 1 | 24.0 | 31.5 | 48211:1788372000000000000 | Long rows need a clearer boundary. |
</AnnotatedScreenshot>

```md
<Callout>
This stays code.
</Callout>
```

- A list item
  <Callout>
  This stays list text.
  </Callout>
- Another item
