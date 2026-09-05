---
name: plan-for-review
description: Prepare plans, proposals, drafts, and reports the owner will read and judge. Triggers on "a plan for me", "for my review", "give me drafts", "write up a proposal", and any deliverable whose reader is the owner deciding something. Also use to clarify the review expectation for substantial integrations, large modifications, core changes, or high-risk work when the intended reader is unclear. Routine working plans for repairs do not require a review deliverable.
---

# Prepare a plan for owner review

## Settle the audience

An explicit request for your review material is enough. Start.

For a full feature integration, a core project change, or a high-risk
proposal where the reader is unclear, ask once: a proposal to judge, or a
working plan to execute? Keep investigating while you wait.

Deliver where the owner asked. Drafts requested in conversation need no
files and no document attachment.

## Write for the judgment

Lead with the recommendation and the result it produces. Then, as the
decision needs them: the problem, the evidence, the alternatives that were
live, the consequences, what is uncertain, and how the result gets
verified.

For an implementation plan, give the order of work and what depends on
what. Name each decision that is the owner's. Keep measured figures apart
from estimates. Put each piece of evidence next to the claim it supports,
as a link the owner can open.

Scale detail to the size of the decision. Headings follow the argument;
there is no template.

## Pick components by the information

- Verdict for the recommendation and its rationale.
- Callout for context that changes the reading, a warning, or a decision
  only the owner can make.
- MetricStrip for the figures that carry part of the argument.
- DecisionMatrix for alternatives scored against the same criteria.
- BeforeAfter for one concrete change in behavior.
- PhaseBoard for ordered phases of work.
- EvidenceChain for a claim, the evidence behind it, and the conclusion.
- Chart for a numeric relationship a table hides.
- Mermaid for a process, a dependency graph, or an architecture.

Before writing a component, read `COMPONENTS.md` in the stratamd skill and
copy its body shape. A component with the wrong shape renders as an error
card, not as Markdown. Plain prose or a table wins whenever it says the
same thing.

A Callout or comparison table does not create a tracked decision item.
When one is needed, use a Strata decision action anchored to the document
or a conversation message, using the supplied context and anchors. Follow
the owner's explicit answers wherever they provide them.

## Done when

The owner can read the recommendation, open its evidence, see the
tradeoffs, and find what needs their input, without reading the
investigation behind it.

Cut repetition and decoration. Deliver exactly the artifacts asked for.
This skill adds no approval step to the owner's existing instructions.
