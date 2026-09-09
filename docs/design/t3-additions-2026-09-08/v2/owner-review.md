# Saved owner review, revision 2

The browser has decisions for 10 of the 12 flows: 9 approved and 1 needing changes. Files and previews and Browser evidence have no saved decision.

| Flow | Saved decision | Feedback |
| --- | --- | --- |
| Questions | Needs changes | Redo the appearance and use Strata's modal pattern for the question/comment interaction. |
| Files and previews | No saved decision |  |
| Usage limits | Approved | Approved with a correction to the Codex usage-window example. |
| Compact context | Approved |  |
| Commands and skills | Approved |  |
| Draft markers | Approved |  |
| Project defaults | Approved |  |
| Import conversations | Approved |  |
| Browser evidence | No saved decision |  |
| Window capture | Approved |  |
| Connection and recovery | Approved |  |
| Custom models | Approved |  |

## Meaning of approval

Dillon clarified that Approved with a comment means the design is accepted and the comment is a required correction. Keep the rest of that flow approved. Needs changes still calls for a revised mockup.

## Requested revisions

Questions: Dillon rejected the appearance and said comment windows should use modals. Revise the question and answer-file mockups around the existing Strata modal components, then return that flow for review.

Usage limits: the layout remains approved. The corrected fixture shows only a weekly window for Codex, keeps the Claude five-hour example separate, and excludes Codex from that combined short-window calculation. The reset-credit example now belongs to Claude. The implementation must render engine-reported windows and capabilities rather than infer limits from this fixture.

The other eight approved flows have no notes. No decision was inferred for the two missing records. Product implementation remains gated on the remaining design decisions.

The [raw browser record](owner-review.json) preserves Dillon's exact wording and the original saved status for every flow. This export does not change the gallery's saved feedback.


## Implementation authorization and question correction

Dillon subsequently requested implementation of all 15 features. The historical decisions above remain unchanged. The question benchmark now uses the existing SetupDialog frame and answer controls in a 640 × 560 modal, with Hold, optional dismissal, and per-answer files. The asking, blocking and upload-error images were replaced; all six question states were recaptured and checked. This records the requested correction, not a new owner approval.
