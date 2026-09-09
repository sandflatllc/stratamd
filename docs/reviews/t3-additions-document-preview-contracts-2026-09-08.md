# PDF and HTML document preview audit

Read-only inspection of pinned upstream `08463e2c401ce87858aaaebcb70ed86fb002fb5f`, current Strata sources, v2 benchmark and official Electron/PDF.js docs. No dependency installation, repository edits or owner-file reads.

## Outcome

Use the existing preview window and tab conventions, with an actual PDF.js page renderer behind Strata's document toolbar. Reuse the guest WebContentsView isolation for HTML, but give attachment documents their own isolated session and serving policy. Keep source mode plain escaped text. Upstream itself uses Chromium's native PDF iframe and does not provide custom pagination/zoom implementation to copy.

The v2 `docs/design/t3-additions-2026-09-08/v2/proposals.js:85` toolbar has minus, 100%, plus, '1 of 3', Next page, filename, Read only, Open externally. `benchmark-guide.md` explicitly states the PDF is a layout fixture and pagination/zoom still need implementation. A screenshot of that fixture or buttons changing only labels do not meet feature13.

## Exact upstream behavior

`apps/web/src/components/files/FilePreviewPanel.tsx:206` defines `BrowserDocumentFrame`. PDF uses an unsandboxed iframe because Chromium's native viewer requires it. HTML uses iframe sandbox `allow-scripts allow-forms allow-popups allow-modals`, deliberately omitting allow-same-origin. This upstream comment is not justification to place arbitrary PDF-named HTML in Strata's privileged renderer origin.

`AttachmentBrowserPreview` requests `assets.createUrl` resource `{_tag:'attachment', attachmentId, fileName, mimeType, disposition:'inline'}`. `WorkspaceBrowserPreview` requests workspace-file for files inside the workspace and media-file for exact files outside it. `apps/web/src/assets/assetUrls.ts` resolves relative signed URLs against the selected environment's HTTP base, models loading/failure, and provides refresh. `packages/contracts/src/assets.ts` defines resource/result contracts; result has relativeUrl, expiresAt, optional sourcePath/imageDimensions.

`apps/server/src/assets/AssetAccess.ts` signs asset access, one-hour normal TTL. Attachment inline document MIME is derived from the server-owned attachment id extension (pdf/html/htm), not merely claimed client MIME. Generic files otherwise download. Workspace preview tokens support approved sibling assets; media-file tokens refer to a single exact host file. Do not turn that into an arbitrary directory grant.

`apps/server/src/http.ts:54` applies HTML CSP `sandbox allow-scripts allow-forms allow-popups allow-modals`, in addition to the iframe sandbox. Its asset responses include nosniff. This creates an opaque HTML origin even when opening the signed asset directly. Asset authorization is scoped through the signed URL; bearer/DPoP credentials must not enter document DOM, query parameters or guest storage. URLs are capability secrets and should not be logged or persisted as durable attachment identity.

No PDF.js dependency or custom PDF page count/zoom code was found in upstream apps/web/package.json or FilePreviewPanel. Native viewer controls are Chromium-owned. Electron webContents exposes page zoom and printing APIs, but no documented PDF document page/count controller. URL fragments/native shadow DOM are not a reliable basis for Strata's custom toolbar.

## Concrete Strata reuse and required changes

- `src/main/preview/host.ts:274` already creates WebContentsView with contextIsolation, sandbox, all Node integrations disabled, no preload, no webview tag. Reuse creation/lifecycle/bounds/tab machinery. Guest policies in `guest-policy.ts` deny permissions except fullscreen and downloads, and reject non-http popup targets.
- Existing guest partition is derived from workingFolder and intended for persistent browsing. Attachment HTML should use a separate non-persistent document partition, with deny-all permissions, no popups/new-window navigation and no access to browsing cookies. Do not give this guest Strata preload or custom internal protocols.
- `src/main/local-link.ts` currently resolves only HTML and Markdown. `host.ts:925` only allows existing local .html/.htm or HTTP(S). Adding .pdf to a filename allowlist alone does not create page controls or attachment handling. Model document tabs explicitly or route attachment document mode through the existing preview window shell rather than weakening generic navigation guards.
- `src/main/engine/client.ts` already calls T3_RPC.createAssetUrl for saved-comment attachments. Add a bounded authenticated main-process document read resolving a selected attachment's exact id/metadata against the current engine identity. Keep original binary bytes from feature3; never PDF -> file.text(). Make pending local staged attachments open without requiring premature upload.
- `src/main/protocols.ts` existing visual protocol serves only image/evidence ids with restrictive CSP. Do not relax that image protocol for arbitrary HTML. A separate document resource handler must validate opaque document id/engine identity and content type, enforce byte limits and isolate privileges. HTML response CSP belongs at response level so direct navigation cannot bypass iframe attributes.
- `src/renderer/index.html` shell CSP currently limits connect-src to self/app. Main-resolved PDF bytes avoid exposing bearer headers or widening shell access to arbitrary remote engine origins. A packaged PDF.js worker needs narrow worker-src/bundled asset support, not global unsafe-eval or remote CDN scripts.

Minimal implementation: one read-only document model with filename, original identity, kind, loading/error, PDF page/count/zoom or HTML preview/source. Reuse tab/window presentation. PDF renderer gets bounded Uint8Array through existing typed IPC; HTML renders only in an isolated guest, source mode in escaped read-only text. Open externally should use the explicitly selected original local file or a durable downloaded copy with clear failure handling; never hand an expiring authenticated URL to an arbitrary external app as the only durable reference.

## PDF.js choice and mechanics

Official [PDF.js examples](https://mozilla.github.io/pdf.js/examples/) demonstrate getDocument, getPage and canvas rendering with scaled viewport. Use PDFDocumentLoadingTask.promise, document.numPages, getPage(currentPage), getViewport({scale}) and page.render(...). Scale canvas backing dimensions for devicePixelRatio separately from UI zoom. Next/previous changes the rendered page; zoom changes viewport dimensions and rendering. Cancel or serialize prior render tasks before rendering again on the same canvas. Destroy loading task/document/worker when tab closes or source changes.

Official [API documentation](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) supports Uint8Array data, worker, resource URLs and image-area limits. Data may transfer to the worker; send a dedicated copy rather than transferring a buffer still owned by staging. Package worker and needed fonts/CMaps/WASM locally. Bound canvas area and one/few active pages rather than rendering every page eagerly. Handle corrupt, password-protected and unsupported PDFs as actual errors. A canvas-only baseline can show pages and toolbar but has no selectable/searchable text; add the supported text layer when required, and do not claim those features otherwise.

Official registry metadata fetched to `/tmp/strata-pdfjs-metadata.json` currently reports pdfjs-dist 6.3.289, Apache-2.0, Node >=22.13.0 or >=24. This is a candidate pin, not installation approval or compatibility proof. Confirm Strata's build/runtime compatibility and package worker import using that exact version. PDF.js generated scripts must remain in worker/viewer isolation; keep XFA disabled and do not add annotation scripting/interactive form execution to a read-only feature. Preserve Apache license/notice files in distribution. [Official package metadata](https://registry.npmjs.org/pdfjs-dist/latest).

If avoiding a new dependency is mandatory, native PDF viewer can deliver functioning built-in controls with Chromium's toolbar, but it cannot honestly be described as the approved custom page/zoom toolbar. That would be a design deviation requiring an explicit decision rather than a fake adapter.

## Meaningful verification

1. Generate a real three-page PDF fixture with visually distinct text/colors on every page. In Electron, open original staged bytes; prove page count 3, initial page content, next page visibly different, boundaries disabled, and zoom changes canvas size/rendered content while page identity stays fixed. Save evidence matching files-pdf only after real render completion.
2. Test rapid next/zoom/tab close during loading; stale promises must not replace a newly opened document or leak workers. Include corrupt/missing/password-required fixture errors, not only successful placeholders.
3. HTML fixture should run a harmless script proving it rendered, then attempt access to window.strata, require, parent document, shell origin storage, browsing-session cookies, privileged custom protocols and popup navigation. Assert they are absent/blocked and app remains intact. Source mode must display literal script markup without executing it.
4. Verify local HTML sibling assets only within intended scope; remote attachment has no implicit workspace sibling access. Test path traversal/symlink canonicalization for any added local resource handler. Mocking a URL string alone does not prove authorization.
5. Test actual signed attachment HTTP response MIME/disposition and expired signature refresh using an isolated engine. Preserve origin/engine identity across retry and reject stale results after switching engines. Do not log capability URLs.
6. Verify opening/closing document mode does not change existing browser tabs, preview automation host or download policy. Coordinate host changes with feature8 implementer and run focused existing preview specs plus full final gate after integration.

No runtime PDF or HTML verification was executed in this audit.
