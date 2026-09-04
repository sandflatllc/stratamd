# Cockpit v1 external scenario record

Recorded 2026-09-03 on the owner's workstation. These scenarios deliberately distinguish observed evidence from evidence that still needs an unchanged external client or a controlled server restart.

## Scenario 11 — mobile and the published server

- The T3 service is bound on all interfaces at port 3774 and its orchestration endpoint rejects an unauthenticated request with the expected `auth_invalid / missing_credential` response.
- The active desktop and server processes were launched from `~/Projects/t3-strata/t3code/release/T3-Code-0.0.37-x86_64.AppImage`. The installed/downloaded published build on this host is 0.0.33.
- No unconsumed pairing credential exists in the live server store. This automated run therefore did not consume a credential, impersonate the phone, restart T3, or claim that unchanged mobile continued a Strata-created thread.

Result: **open external evidence**. Run unchanged T3 mobile against a published-server process, open a thread Strata created, reply, and confirm the same thread id appears in Strata.

## Scenario 12 — one line per action

`test/unit/agent-chat-contract.test.ts` parses the real message fixture `test/corpus/messages/action-summary.md`, proves two posted actions, proves no more than two nonempty prose lines, and proves the prose does not repeat the question or replacement text.

Result: **automated evidence recorded**.

## Scenario 13 — localhost continuation, Stop, restart

- The current T3 server is reachable at `127.0.0.1:3774`.
- The vendored client tests prove stable thread identity, interrupt dispatch, persisted stream state, and command-id deduplication against recorded server behavior.
- A real localhost continuation/Stop/restart run requires a paired credential and intentionally restarting the owner's active T3 process. Neither condition was available to this run.

Result: **open external evidence**. With the owner-controlled restart window, continue an existing thread, measure Stop acknowledgment under two seconds, restart the published server, and confirm one resubscribed copy of the same thread.

## Fork removal

The fork cannot be removed while PID 8364 is executing its AppImage and PID 8802 is serving from the mounted image. Removing the directory would delete the executable backing the owner's running server. Delete `~/Projects/t3-strata` only after T3 has been deliberately relaunched from the published build and scenarios 11 and 13 pass.
