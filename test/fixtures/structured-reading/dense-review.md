# Mesa practices review

Date: 2026-09-01. Author: Claude. Owner: Dillon. Status: draft for walkthrough.

## 1. Verdict

Mesa's product is strong and its written process is upside down. The rules that actually protect Mesa live in the database and in the launcher scripts. The rules that agents keep breaking live in prose. The process spends almost all of its weight on the prose.

Four facts carry the whole review:

| Fact | Evidence |
|---|---|
| Not one defect in either major August postmortem was caught by a canon rule. The owner personally caught more invented facts than any process stage. | 08 §2.3, §7.5 |
| An agent following the router's own read chain loads about 43,000 tokens of instructions before touching code. The rules it needs fit in about 5,000. | 01 §2, §7d |
| CI has been red since 2026-06-19 and every push to main deployed anyway. Playwright has never run in CI. | 03 §0, 04 §1 |
| Money and piece-rate rules are enforced at the database and hold. Core records have between 6 and 47 write paths each. | 02 §4, 06 §3 |

The fix is not more rules. It is moving the rules into three places that work whether or not anyone reads them.

## 2. What Mesa is, in one page per island

This section exists so the rest of the document can be judged against the product, not the code.

| Island | Owns | The invariant that makes it Mesa |
|---|---|---|
| Address and job | Address, job identity, warranty history | Address is the record. One job, one address. Warranty follows the address, not the customer. |
| Sales | Stage, owner, source, appointments, commitments, outcomes | Stages move only by work being done. One accountable owner, never a pool. Junk leaves no record. |
| Measurement | Measurement versions, adopted roof map | Provider originals are immutable. Corrections fork. Nothing about money crosses the bridge. |
| Inspection | Visit session, capture session, recap | FreeFlow capture, no pickers. One controller. Recovery never duplicates a visit. |
| Proposal and contract | Proposal versions, signing, change orders, catalog | Signed price never mutates. Change orders are the only path. Agent drafts, human approves. |
| Production | Production status, crew, schedule, claims, evidence packets | Claims land on a real section of a real roof. Quantity conservation. Found work is a named item. |
| Payroll and costing | Pay periods, paychecks, costing layers | Piece rate times physical percent. FLSA per workweek. Seal locks the same transaction. Dash, never zero. |
| Billing | Requests, payments, refunds, QBO links | Request, submission, and settled money are three facts. Cleared principal only. Mesa's page, never QuickBooks'. |

## 3. Islands: the ownership model

Ownership is tagged but write authority is scattered. The database needs one guarded door per record.

### 3.1 What exists

Every island has a folder, an owner tag, and a README. None of them has a guard on the tables it claims.

### 3.2 The front-door census

| Record | Write paths | Guarded |
|---|---:|---|
| Address | 6 | No |
| Job | 14 | No |
| Shift | 17 | No |
| Measurement | 47 | No |
| Paycheck | 3 | Yes |

### 3.3 The change

Add a guard trigger to each core table so every write goes through the island's door.

## 4. The instruction system

The instruction system is too large to function as working memory. Put the rules that must hold where the system can enforce them.

### 4.1 The numbers

The router and page list expand into 44 files. The page list alone contributes 68 percent of the required context.

### 4.2 The change

Delete retired process documents. Keep a 120-line invariants file that is always loaded.

## 5. Tests

The test count looks healthy while the most important paths run against mocks or never run at all.

## 6. CI and release gates

A red check cannot protect main when deployment ignores it. Make the gate mechanical.

## 7. Change list, ordered

### Now, this week

| Change | Effort | Owner |
|---|---|---|
| Fix integration migration ordering and get one green run. | 1 day | Tests |
| Wire deploys to green CI. | 0.5 day | Owner decision |
| Delete retired process documents and dead validators. | 1 day | Instructions |

### Next, weeks two and three

| Change | Effort | Owner |
|---|---|---|
| Add guard triggers to ten core tables. | 3 days | Ownership |
| Build the islands manifest and check script. | 3 days | Ownership |
| Convert mocked proposal tests to real API flows. | 2 days | Tests |

### Then, island by island as touched

| Change | Effort | Owner |
|---|---|---|
| Consolidate write modules one island at a time. | 30 days | Architecture |
| Run the test deletion sweep with cross-family review. | 2 days | Tests |
| Walk the product map by island. | Your interview time | Owner |
