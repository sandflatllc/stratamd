# Mesa practices review

Date: 2026-09-01. Author: Claude. Owner: Dillon. Status: draft for walkthrough.

## 1. Verdict

<Verdict outcome="caution">
Mesa's product is strong and its written process is upside down. The rules that protect Mesa live in the database and launcher scripts. The rules agents keep breaking live in prose.
</Verdict>

Four facts carry the whole review:

<MetricStrip>
- **Defects caught by canon:** 0 of 9
- **Instruction load:** 43,000 tokens
- **CI red since:** 2026-06-19
- **Unguarded write paths:** 6 to 47 per record
</MetricStrip>

<EvidenceChain>
### Claim

Mesa's written process is upside down.

### Evidence

- [08 §2.3](./evidence/08-postmortems.md#defects) — canon caught none of the major August defects.
- [01 §2](./evidence/01-instructions.md#read-path) — the mandated read path costs about 43,000 tokens.
- [03 §0](./evidence/03-ci.md#status) — CI stayed red while every push still deployed.

### Therefore

Move invariants into database guards, launchers, and CI.
</EvidenceChain>

## 2. What Mesa is, in one page per island

| Island | Owns | The invariant that makes it Mesa |
|---|---|---|
| Address and job | Address, job identity, warranty history | Address is the record. One job, one address. Warranty follows the address, not the customer. |
| Sales | Stage, owner, source, appointments, commitments, outcomes | Stages move only by work being done. One accountable owner, never a pool. Junk leaves no record. |
| Measurement | Measurement versions, adopted roof map | Provider originals are immutable. Corrections fork. Nothing about money crosses the bridge. |
| Production | Production status, crew, schedule, claims, evidence packets | Claims land on a real section of a real roof. Quantity conservation. Found work is a named item. |

## 3. Change list, ordered

<PhaseBoard>
### Now

- Fix integration migration ordering and get one green run. *1 day · Tests*
- Wire deploys to green CI. *0.5 day · Owner decision*
- Delete retired process documents and dead validators. *1 day · Instructions*
- Cut pre-commit to four jobs and CI to five lanes. *0.5 day · Gates*

### Next

- Add guard triggers to ten core tables. *3 days · Ownership*
- Build the islands manifest and check script. *3 days · Ownership*
- Fix system map extraction and add the island layer. *3.5 days · System map*
- Convert mocked proposal tests to real API flows. *2 days · Tests*

### As touched

- Consolidate write modules one island at a time. *30 days · Architecture*
- Run the test deletion sweep with cross-family review. *2 days · Tests*
- Add symbol-level usage, then delete six catalogs. *3 days · System map*
- Walk the product map by island. *Your interview time*
</PhaseBoard>
