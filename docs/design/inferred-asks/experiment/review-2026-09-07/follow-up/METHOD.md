# Follow-up on direct optional questions and request anchors

This targeted follow-up was specified after the first comparison exposed two defects in the revised prompt: it missed the real question "Want me to write that up as a plan file before touching code?" on the second pass, and once anchored the activity-placement choice on a descriptive alternative rather than the request itself.

Here `baseline.txt` is the FIRST REVISED prompt from the parent experiment, not the original production-plan prompt. `revised.txt` is a refinement that explicitly includes direct optional questions, limits the offer exclusion to declarative availability statements, and requires the quote to contain the request itself.

Four cases come from the main set: the long reply, the real plan question, the worktree-choice reply, and the complex reminder/export reply. Two new synthetic cases contrast a direct offer phrased as a question with declarative offers and invitations to object. Their labels were written before follow-up calls. The resulting six cases have eleven target asks, or twenty-two target instances per prompt over two passes.

The same settings, Codex home, JSON schema, cwd, sequential paired ordering, and sixty-second limit apply. The main experiment must finish before this runner starts. There are twenty-four planned calls, two per case per prompt. The scripts and file names preserve the parent format so the results can be reproduced.

This is a targeted repair check, not another full validation set. It cannot establish the refined prompt's performance on all twelve original cases. Reusing four cases after observing them makes those four development cases. The two new cases provide only a small check on different wording.

No attempt is made in this revision to solve lossy question summaries by adding more generated fields. Original context in the reply UI remains a separate application proposal.
