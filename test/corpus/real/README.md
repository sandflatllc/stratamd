# Real-document corpus

These fixtures preserve the shape of real agent-written working documents: the hard wrapping, dense tables, inline-code paths, frontmatter, Unicode punctuation, and long prose that agents actually produce. The first three were originally byte-for-byte copies of private owner documents; before open-sourcing they were rewritten (2026-08-31) as fictional documents that keep the same Markdown construct coverage. Tests copy them to temporary directories before opening them. Do not edit a fixture to make a failing round trip pass. Fix the parser or serializer, then add the troublesome source document here if it represents a new case.

| Fixture | Why it is here |
|---|---|
| `launch-queue-index.md` | Compact document with hard-wrapped paragraphs, tables, inline-code paths, and many relative links (including a URL-encoded one). Contains the plain-text bold target `navigation index` used by `editor-markdown.test.ts` and `prd-6.12.spec.ts`. |
| `customer-document-bridge.md` | Frontmatter, headings, lists, code spans (including brace groups), and long agent-written prose. Contains the bold target `production-capable rendering bridge` used by `prd-6.12.spec.ts`. |
| `security-stability-plan.md` | Tables, nested lists, emphasis, lazy paragraph continuation after bold lead-ins, Unicode punctuation (—, –, ≥, →, §, ~), and dense planning content. Contains the bold target `Bug-fix-class maintenance slice` used by `prd-6.12.spec.ts`. |
| `strata-product-page.md` | An earlier revision of the product page (now the root `README.md`), SHA-256 `6b97e740b3de72b74e27833ac79db4329b22163255d6c063fbd4f2e64ba9907a`. The 2026-08-30 incident baseline: inserting two rows into its delivery table makes the external-replace splice outgrow the parsed snapshot (see `editor-undo.test.ts` and `agent-buffer-table-edit.spec.ts`). Smaller synthetic tables splice cleanly, so the regression depends on these exact bytes; the live sample doc keeps evolving and cannot anchor the test. |

The bold-target phrases are load-bearing: `editor-markdown.test.ts` and `prd-6.12.spec.ts` select them and toggle strong, asserting the file changes by exactly `**…**` and nothing else. Keep each phrase as plain paragraph text, appearing once, not adjacent to other inline marks.
