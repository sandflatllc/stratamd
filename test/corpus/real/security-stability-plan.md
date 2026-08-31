# Security/Stability Dependency Slice — Execution Plan

**Date:** 2026-03-19
**Status:** REBASELINED 2026-03-29 — not started. The 2026-03-19 Node 20 and vulnerability snapshot below is retained only as superseded evidence; `SEC-DEP-001` and `SEC-DEP-002` govern execution.
**Scope class:** Bug-fix-class maintenance slice. No new surfaces, no visual changes, no DB migrations.
**Launch-queue linkage:** Open pre-cutover work. The rewritten launch queue carries status and points here; this plan owns the execution detail.

## Reconciled decision register (2026-03-29)

### SEC-DEP-001 — Narrow CVE slice and runtime boundary

The execution baseline is the 2026-03-28 production audit: 27 advisories (4 high,
22 moderate, 1 low) across the HTTP framework, the router, `ws`, `brace-expansion`,
and telemetry dependencies. Re-run the production audit immediately before
implementation and treat that result as execution evidence. Patch high/critical
advisories without bundling an unrelated framework-major program. Keep the current
Node 22 runtime for this narrow slice unless a separately reviewed Node 24 change is
expressly included; any Node 24 work receives its own container/runtime proof and a
watched deployment. The older Node 20-to-24 mandate and 18-advisory snapshot below are
superseded and must not drive execution.

### SEC-DEP-002 — Readiness contract

The slice is ready only when there are zero high/critical production advisories;
audit-zero is achieved where narrow fixes permit it; every residual moderate/low
advisory is patched or explicitly risk-accepted with Cairn-specific exploitability;
focused security/behavior tests, API/web typechecks, build, lint, validators,
integration-owned checks, packaged customer-document rendering, and container proof
pass; and one risk-sized second-reviewer pass covers the money-loop/API runtime
boundary. No feature, visual, schema, or provider activation belongs in this slice.

The governing engineering obligations are pointers, not restated policy:
`canon/process/engineering-standards.md`, `canon/process/review-cycle.md`, and
`canon/process/dev-lifecycle.md`.

---

## 1. Superseded baseline evidence (gathered 2026-03-19)

1. **Historical runtime finding.** The API container image then ran Node 20. Cairn is now on Node 22; `SEC-DEP-001` owns the current runtime boundary.
2. **Production audit: 18 known vulnerabilities — 1 low / 15 moderate / 2 high.**
   - **HTTP framework 4.12.17** — 12 advisories, incl. one HIGH (CORS middleware reflects any Origin with credentials when `origin` defaults to wildcard) and a low JWT NumericDate validation issue. **Mitigating fact verified:** Cairn passes an explicit `origin: webOrigin` (`packages/api/src/index.ts` ~L175), so the CORS high does not currently bite. Patch regardless. Fix: `>=4.12.25` (same 4.12.x line).
   - **ws** — 2 advisories incl. HIGH (memory-exhaustion DoS). Transitive. Fix: `>=8.21.0`.
   - **router** — 1 advisory, fixed **within v6** at `>=6.30.4`. No v7 migration required.
   - **brace-expansion**, **telemetry core** — 1 each, transitive patches.
3. All 18 findings are fixable with patch/minor bumps. No framework major is required for security.

## 2. Scope

### In
| Change | From → To | Notes |
|---|---|---|
| HTTP framework | 4.12.17 → latest 4.12.x (≥4.12.25) | clears 12 advisories |
| router | 6.30.3 → latest 6.30.x (≥6.30.4) | stays on v6 |
| Node runtime | Keep current Node 22 by default | A Node 24 change is a separately included and proven slice under `SEC-DEP-001`; it is not implied by CVE repair. |
| Transitive CVE closure | ws ≥8.21.0, brace-expansion, telemetry core | via parent bumps below; overrides only for stragglers |
| Stability minors | error reporting, database client, browser automation, query cache, auth library, i18n, date utilities, script runner, and remaining patch-level dev bumps (lint, dead-code scan, hooks, staged-files, postcss, autoprefixer) | zero API changes expected |

### Out (explicitly deferred — do not scope-creep into this slice)
- **PDF parser 4→6**: no known CVE at current 4.10.38; aging attack surface only. Revisit on a timer (Cairn parses externally-sourced PDFs); belongs to the full upgrade program.
- React 19, router 7, Tailwind 4, the bundler, the test runner, TypeScript (incl. TS 7 — blocked on tooling compat anyway), server adapter 2, HTTP client 8, plugin majors, and AI SDK jumps. All belong to the separate full upgrade program.
- Any DB migration, feature flag change, or behavior change.

## 3. Execution — optimized for wall-clock

Parallelism analysis: the change itself is inherently serial (one lockfile, one container file); the win is fanning out verification. Hard constraints:
- **Lockfile is serial** — exactly one agent edits manifests and runs the install. Never parallelize the bumps.
- **Integration tests are one lane** — the shared local database collides under parallel runners, and the full integration glob is never a valid gate (known single-fork fixture collisions). One agent, targeted per-area files, sequential.
- **Single machine** — container build + e2e + suites share CPU; ~6–8 concurrent lanes is the useful ceiling.

### Phase 0 — Land the change (1 agent, serial, ~20–30 min)
1. Confirm clean tree (portal work committed/stashed by owner decision).
2. All manifest edits in one pass: manifest bumps per §2 and overrides only for any transitive advisory not cleared by parent bumps. Do not change the Node 22 runtime unless the separate Node 24 slice is expressly included.
3. Single install; confirm lockfile coherent; the production audit should already report 0.

### Phase 1 — Verification fan-out (parallel; kick slow lanes first)
| Lane | What | Notes |
|---|---|---|
| V1 (start first) | container build, deploy target | long pole; validates the selected runtime image + workspace COPY lines |
| V2 (start first) | E2E smoke vs local stack (web on :5173) | one agent; single local stack |
| V3 | Integration tests: auth/CORS/routes areas, per-file, sequential | ONE agent by rule above |
| V4 | workspace typecheck | fast |
| V5 | API unit tests (excl. integration) | |
| V6 | Web unit tests | |
| V7 | Customer-doc render proof (packaged path) | exercises server rendering + headless Chromium on new Node |
| V8 | Security assertions: production audit = 0; CORS behavior unchanged (explicit-origin echo, Vary: Origin, credentials); JWT verify paths | |

### Phase 2 — Repair (parallel per independent failure)
- Independent failures → concurrent fixer agents (disjoint code; never the lockfile concurrently).
- Re-run only the affected lanes.
- Known-risk spots to check first if red: the selected runtime vs headless-Chromium launch in the container; Node type strictness in API typecheck; error-reporter minor init-option drift.

### Phase 3 — Gate + readiness
- Batch verification for the batch close.
- ONE batched second-reviewer pass sized to risk (dependency slice touching money-loop API runtime); review + residual low-risk repair run concurrently. No per-bump ceremony (proportional-ceremony ruling 2026-03-12).
- Report readiness; update the pointer-only `SECURITY-STABILITY` launch-queue row.

**Wall-clock estimate:** ~1.5–2 h if green (Phase 0 ~30 min + longest lane ~30–45 min + gate); repairs add little due to concurrent fixers. Calendar-effort ceiling ~1 day.

## 4. Deploy note (owner-gated — not part of this slice's execution)

Landing this slice locally does not authorize a deploy. The rewritten launch queue and current deploy canon own release sequencing, and this slice adds no migrations. Any separately included runtime-image change requires a watched deployment.

## 5. Success criteria

1. The production audit reports 0 known vulnerabilities.
2. The API container image builds and boots on the selected runtime (Node 22 by default); `/health` is green in the container.
3. All Phase 1 lanes green (integration per-file bar, not full-glob).
4. Zero behavior change: CORS, auth, PDF render proof, route smoke all byte/behavior-equivalent.
5. Second-reviewer synthesis MERGEABLE; launch-queue §3.3 updated.
