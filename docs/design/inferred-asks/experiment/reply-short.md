I moved the link handling into the main process so every click goes through one place. Local Markdown links now open in a Strata tab, and anything outside the workspace root opens in the system browser after a confirmation.

Two things I couldn't settle on my own. Should md links that point at a file outside the project's workspace root still open in Strata, or should those fall through to the browser? And do you want the confirmation dialog for external links, or is that just friction?

The rest is mechanical. The renderer asks the main process whether a target is local, and main answers with a kind. I also fixed a bug where `href?.startsWith("file:")` threw on null hrefs. Sounds good?

For the tests, I added three cases. What happens on a relative link with `..` segments? It resolves against the document's directory, then gets fenced against the workspace root, so it can't escape. That's covered by the third case.

Pick one of these for the worktree question and I'll finish it in this change:
1. Treat a thread's worktree as inside the fence.
2. Keep the fence at the workspace root only.
3. Make it a setting.
