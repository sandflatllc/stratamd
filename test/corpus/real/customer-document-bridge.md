---
title: Customer document production bridge
status: in-flight
owner: cairn-owner
created: 2026-03-13
target_canon_files:
  - canon/domain/documents.md
  - canon/domain/estimates-and-proposals.md
  - canon/domain/customer-portal.md
  - canon/domain/billing.md
tags: [documents, proposals, invoices, certificates, pdf]
---

# Customer document production bridge

## Goal

Replace Cairn's placeholder proposal PDF and JSON completion certificate with one production-capable rendering bridge that turns the existing `ProposalDocument`, `InvoiceDocument`, and `CertificateDocument` React blocks into self-contained HTML and then uses Cairn's existing Chromium PDF renderer.

This batch does not add a page, route, workflow, database table, or visual block. It supplies the shared rendering seam needed by existing owners: `public-proposal-view`, `job-billing`, `job-documents-panel`, `customer-portal-view`, and the development-only `print-documents-dev` reference surface.

## Reconciliation with Cairn today

- Proposal send currently freezes deterministic HTML and a PDF, but the HTML is a heading plus canonical JSON rather than the designed proposal.
- Completion certificate generation currently stores a JSON payload through `createGeneratedDocument`.
- Invoice facts exist in billing, but no issued-invoice PDF adapter currently feeds the customer document block.
- The three designed blocks, shared print CSS, customer tokens, vendored fonts, and logo assets already exist. They are reused rather than recreated.
- `createGeneratedDocument` remains the durable storage and registration contract for generated customer documents.
- The current proposal `customer_document` payload is not the full `Proposal` record expected by `ProposalDocument`. Production adapters must fail closed when required facts are absent; fixture fallback is forbidden.

## New-surface verification packet

### Owner surfaces

No new owner row is needed. Production callers remain owned by the existing proposal, billing, documents, and portal surfaces listed above. The renderer is a shared implementation seam, not a user-facing surface.

### Existing assets checked

- `packages/web/src/design-system/blocks/customer/{ProposalDocument,InvoiceDocument,CertificateDocument}.tsx`
- `packages/web/src/design-system/blocks/customer/{documents,proposal-document}.css`
- `packages/web/src/design-system/customer/{tokens.css,fonts/fonts.css}`
- `packages/web/public/design/{proposal,brand}`
- `packages/api/src/services/proposalFreeze.ts`
- `packages/api/src/services/documents/index.ts`
- `packages/api/src/services/SERVICES-CATALOG.md`

The production-only dead-export profile reports the customer document barrel exports as unconsumed. That is advisory evidence of the missing production bridge, not a deletion candidate.

### Architecture

1. Add a server-only web entry that renders one of the three existing document blocks to static markup. It takes document data, company identity, and copy explicitly; it imports no fixture and supplies no production default.
2. Add an API HTML-shell service that embeds the existing CSS, fonts, and logo assets as data URLs so Chromium rendering has no network or public-path dependency.
3. Extract the current Chromium implementation into a reusable HTML-to-PDF service. Designed documents render with zero PDF margin because their `.sheet` contract owns exact Letter geometry.
4. Add strict production adapters in separate follow-on slices: proposal version to `Proposal`, billing facts to `InvoiceRecord`, and closed/paid job facts to `CertificateRecord`.
5. Persist generated invoice and certificate PDFs only through `createGeneratedDocument`; preserve proposal freeze hashing and atomic finalize behavior.

### Trust and failure rules

- No demo fixture may supply missing legal or customer facts.
- Missing required identity, proposal, invoice, certificate, or customer-copy input stops generation with a named error.
- Customer-provided image URLs may not be treated as proof of successful embedding; the renderer must wait for fonts and images and surface load failures.
- Generated legal artifacts remain company-scoped, immutable/append-forward, explicitly customer-visible where appropriate, and hash-registered through the existing document service.
- Billing output remains tax-silent unless a future owner/accountant decision changes canon.

### Human gates retained

- Confirm the correct state contractor license number; the repo currently contains conflicting fixture values.
- Owner approves final customer-facing document copy.
- Owner confirms certificate warranty term, signer, and verification wording/source.
- Accountant/counsel approval remains required where current launch governance assigns it.

These gates block production activation, not the headless rendering foundation.

### Verification and review

- Unit tests for static markup selection, required inputs, self-contained assets, and deterministic HTML.
- API and web typechecks; API build to prove the container bundle seam.
- Targeted Chromium PDF smoke test when the executable is available; no owner visual signoff is required for this foundation batch.
- Batch verification before readiness.
- Required second-reviewer pass before any readiness claim.

## Scope boundaries

No deployment, production document generation, database migration, branch change, final copy approval, or owner visual acceptance is authorized by this batch.

## Progress — 2026-03-13 completion-certificate slice

The completion-certificate production caller is now implemented without activating it in production:

- `POST /documents/jobs/:jobId/certificate` preserves closed-job and cleared paid-in-full gates and is restricted to owner / office / crew-lead / operations.
- A fail-closed adapter loads company-scoped customer, trailhead address, job type, scope, company timezone, closed closeout context, and public non-deleted closeout photo evidence. Punch lists must be resolved, not merely recorded.
- Versioned configuration requires explicit owner copy approval plus real company identity and license, warranty years, signer, and an HTTPS verification URL template. No fixture value is used.
- The designed certificate renders through the shared self-contained Chromium bridge and stores as a customer-visible, hash-registered PDF legal-evidence document. Active legacy JSON placeholders are superseded append-forward.
- Retries reuse only the exact Cairn-generated certificate version. An arbitrary uploaded active PDF returns a named review-required conflict instead of being treated as the production artifact.

Verification: workspace typechecks; packaged API build and renderer-bundle probe; 28 targeted API tests and 3 web server-render tests; real installed-Chrome PDF (`%PDF`, 1,823,488 bytes); canon and catalog validators; hard duplication and dependency-boundary checks. The full repo sweep had one unrelated network-sensitive public-proposal probe failure while 2,976 other API tests passed.

Second-reviewer pass: `reviews/20260313-165338/SYNTHESIS.md`. No Critical defect. Container live rendering, owner visual acceptance, and real legal/config values remain pending.

## Progress — 2026-03-13 completion-certificate concurrency follow-up

The owner subsequently authorized the database-backed first-generation race fix:

- Migration `20260318000003_completion_certificate_generation_unique.sql` adds a partial unique index permitting at most one active Cairn-generated completion-certificate PDF per company/job. Its preflight aborts on existing duplicates without altering legal evidence.
- A losing concurrent request recognizes only the exact named 23505 constraint, deletes only its own randomized unregistered upload, re-reads the job documents, and adopts only the exact current generated winner.
- Cleanup failure, ambiguous registration failure, an unfamiliar active PDF, and an unresolved post-race read all fail closed. Legacy JSON placeholders and employee-uploaded review PDFs remain outside the uniqueness predicate.
- Unit/route regression coverage is green. The local database was started, the migration applied locally, and both real DB integration cases passed, covering the unique-index conflict and the legacy/upload exclusions. The dry-run push also passed. The migration has not been applied to production.

Second-reviewer pass: `reviews/20260313-175122/SYNTHESIS.md`. No Critical or Major defect. Its sole live-DB verification gap is now closed by the passing local migration and integration test.
