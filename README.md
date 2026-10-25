# Breast Screening Follow-up Agent

## The problem

Women with an abnormal mammogram sometimes get lost before follow-up, especially older women. Sometimes the finding is in both breasts and she only hears about one side. Sometimes the message gets lost between the radiologist, her doctor and her.

## What the agent does

This agent follows every finding, on each side, until it's resolved.

Rules read each breast imaging report and pathology report: the BI-RADS category, the exam date, which breast and the recommendation. Rules pick the pathway, set the deadline, decide every follow-up, and hand a case to a person only when a rule says so. When a report gives each breast its own assessment, each breast gets its own case with its own deadline, so a finding on one side can't hide the other.

Claude does the two jobs that need judgment. It reads her text replies. And when a biopsy result comes back, it compares the pathology report with the imaging report, writes a short side-by-side summary, and flags anything that may not match. A radiologist decides. A day-by-day simulation shows the agent working eleven made-up patients over 90 days.

The deadlines in this demo are placeholders for clinical review. A health system's clinicians would set the real ones.

**Live demo:** [nitchakorn.github.io/BreastCancerScreening](https://nitchakorn.github.io/BreastCancerScreening/), served by GitHub Pages from the `/docs` folder on `main`.

**Try the agent yourself:** `workspace.html` on the same site (`https://nitchakorn.github.io/BreastCancerScreening/workspace.html`) runs the local workspace in your browser, with nothing to install. Give it a report, reply as the patient, book an appointment and move the clock forward.

This is a demo with synthetic patients. It sends no real messages, books nothing and writes to no EHR. Not for clinical use.

## What is a rule, and what needs judgment

The product manager's job here is to ask radiologists and surgeons what has gone wrong before, and build for that. Then decide which parts should be rules and which parts need judgment.

The BI-RADS category and the deadlines are rules. A report states its category in a fixed place, so code reads it the same way every time, and a report that doesn't fit goes to a radiologist instead of a guess. Comparing the radiology and pathology reports needs judgment. A benign biopsy can still be wrong when it doesn't explain what the imaging showed, like a spiculated mass. That's where Claude helps. It puts the two reports side by side and flags what may not match, and the radiologist decides.

| Job | Done by |
| --- | --- |
| Read the BI-RADS category, the exam date, which breast and the recommendation | Rules. A report they can't read cleanly goes to a radiologist. |
| Set deadlines, send reminders, hand the case to a person | Rules |
| Understand her text replies | Claude, and code checks its quote |
| Check that a biopsy result explains the imaging | Claude flags. The radiologist decides. |

In the simulation, Claude flagged all three benign biopsies for a closer look. The radiologist confirmed two of them and sent Evelyn B.'s back, because fibrocystic change doesn't explain a spiculated mass. Her repeat biopsy found the cancer, 18 days after her imaging.

The first version had Claude read every report too. Those reads are kept in `reads/documents.json`, and a test checks that the rules read all 19 of those reports the same way, including the one Claude held because its impression said negative while its findings described a mass.

## Local agent workspace

The workspace runs the same agent on cases you create. Give it a report and it follows up the way the simulation does: a text, a portal message and an automated call, replies read by Claude, bookings, a reminder the day before, and the next report until the result is resolved. People step in through the same handoffs. A demo clock moves time forward, so a month of follow-up takes a few clicks.

The workspace and the simulation share one engine (`createEngine` in `agent/agent.js`). A test replays all eleven simulated patients through the workspace and checks that the agent makes the same decisions, 157 of them, on the same days, for each breast that has its own case.

You need Node.js 22.22 or newer (24.5 or newer also works). There are no npm packages to install.

```sh
npm start
```

Open `http://127.0.0.1:3000`. The server only listens on your own computer and has no login, so use synthetic data only.

The public page `docs/workspace.html` is the same workspace running in the browser. `scripts/build.js` bundles the same page and server files, and `site/browser-workspace.js` swaps three things: SQLite runs as WebAssembly (sql.js, loaded from jsDelivr), the page's `/api/` requests are answered in the browser, and Claude's reads are the recorded ones. The rules read any report you give it. Cases stay in that browser.

### A three-minute demo

1. Pick **Diagnostic imaging** under Try a sample and choose **Read report & start case**. The rules read it, the pathway is set and the first text goes to the test inbox. **Coming up** shows the agent's plan: a portal message on day 2, a call on day 4, and a navigator on day 5 if she never answers.
2. Choose **+1 day**. Under the test inbox, pick the sample reply **Has no ride** and send it. Claude labels it, code checks the quote, and the agent offers a free ride.
3. Under **Test schedule**, choose **She booked online**. The agent sees the booking. Move the clock: it texts a reminder the day before, then marks the appointment done and watches for the report.
4. Under **Reports**, add **Diagnostic result: benign (BI-RADS 2)**. The case closes and shows how many days it took.
5. Start a **Biopsy pathway** case and send the reply **Scared, asks for a call**. The case goes to the nurse navigator, who can book for her, hand the case back to the agent, or close it with a note.
6. Start **Conflicting findings**. It is held for a radiologist. Add the **Radiologist addendum** as the next report and the agent picks the case back up.
7. Start **Both breasts: biopsy right, 6 months left**. The right breast case starts biopsy outreach, and the left breast gets its own case on the six-month track. **Her other breast** links the two. Book the biopsy and add **Pathology: benign fibroadenoma, right breast**. When the right side closes, the timeline says the left side is still open.
8. Start **Spiculated mass, biopsy needed (BI-RADS 4C)**. Book the biopsy, move the clock past it, and add **Pathology: benign, but may not explain the mass**. Claude's side-by-side summary shows up with its concerns, and the radiologist gets the case. Choose **Doesn't match: repeat biopsy**. The agent tells her doctor and starts booking outreach for the repeat biopsy.

**Start over** clears every case and resets the clock.

### What the workspace does

| You do | The agent does |
| --- | --- |
| Start a case with a report | The rules read it, and set the pathway, the due date and the day a person takes over. A report they can't read cleanly goes to a radiologist with the reason |
| Give it a report that assesses each breast separately | Opens a case for each breast that needs follow-up, each with its own pathway, deadline and messages. The case list and the case page show which breast. Closing one side notes that the other side is still open |
| Move the clock | Runs its daily check for every day in between: texts, portal messages, calls, check-ins, reminders, overdue notes and handoffs |
| Reply as the patient | Claude labels the reply and quotes it, and code checks the quote. No ride gets a ride offer, another time gets open slots, and a booking claim gets checked against the schedule. Fear, medical questions, refusals, wrong numbers and unclear replies go to the navigator. While a person has the case, the agent reads her replies but doesn't answer them |
| Book in the test schedule | Trusts the schedule over what she says, texts a reminder the day before, and marks the appointment done on the day |
| Add the next report | Reads it like the first one. A result can close the case, start a biopsy pathway or release a radiologist hold. A pathology result gets Claude's side-by-side comparison with the imaging |
| Act as the navigator or radiologist | Hand the case back to the agent, book for her, confirm that a benign result matches the imaging, call it a mismatch so the agent follows her to a repeat biopsy, or close the case with a note |

Two watches exist only in the workspace, because in the simulation the report always arrives on time. The agent hands the case to a navigator if the imaging report is not in 3 days after the appointment, or if pathology is not in 10 days after the biopsy.

### Recorded mode: no key required

With no API key, the workspace uses **recorded mode**. The rules read every report in every mode, so any report works. Claude's reads of the bundled replies and its comparisons of the sample biopsy results were recorded earlier with Claude Code (see `reads/`). Sample reports get their dates moved to the demo clock, and recorded mode moves the dates in the recorded comparison the same way. A reply it hasn't seen fails openly and can be retried in live mode. A biopsy result with no recorded comparison still goes to the radiologist, with a note that no comparison is available. It never borrows another sample's answer.

### Live reading with Claude Code: no API key

If you have [Claude Code](https://claude.com/claude-code) installed and signed in, the workspace can read any new reply and compare any biopsy result through it. Copy `.env.example` to `.env`, set `READER_MODE=claude-code`, and run `npm start`. Each call runs `claude -p` with the text on stdin, tools turned off, no saved session, and the same JSON schema the API mode uses, so the answer comes back already in shape. Code still checks every quote before the agent acts. If `claude` is not on your PATH, set `CLAUDE_CODE_COMMAND` to the full path of the program.

### Live mode with an API key

Keep credentials in a local `.env` file, never in Git or chat. Copy `.env.example` to `.env`, set `READER_MODE=live` and `ANTHROPIC_API_KEY`, and restart. Leave `ANTHROPIC_MODEL` blank to use an available Sonnet model. Replies and report pairs go to the Claude API with a forced tool call (`record_reply` or `record_comparison`), and their text is treated as source material, never as instructions. Code checks every quote before the agent acts. A failed reply read keeps the item with a **Retry** button. A comparison that can't be made never blocks the case: the radiologist gets it with the reason.

### Saved data

Cases, reports, replies, messages, handoffs and events are stored in `.local/cases.sqlite`, which Git ignores. Each change is one transaction: the agent's state, its messages and its handoffs are saved together, so a restart never sends a message twice. A database from milestone 1 is kept under a new name and a fresh one starts. Dates follow `APP_TIME_ZONE` (default `America/New_York`).

### Tests

```sh
npm test            # everything below, with no model calls
npm run check       # print the eleven-patient simulation
npm run build       # rebuild docs/index.html
```

| Test | What it proves |
| --- | --- |
| `test/simulation.test.js` | The simulation prints exactly the saved timelines and summary |
| `test/parity.test.js` | The workspace makes the same decisions on the same days as the simulation, for all eleven patients and each breast |
| `test/loop.test.js` | Outreach, replies, bookings, results, people's actions and the demo clock, through the HTTP API, including a report with findings in both breasts and a benign biopsy that doesn't match the imaging |
| `test/workflow.test.js` | Intake, duplicates, restarts, retries and request checks |
| `test/policy.test.js` | The rules read every report the same way Claude did in the first version. A report the rules can't read, or a bad read, is held for a person instead of messaging her. A comparison with an inexact quote isn't used |
| `test/reader.test.js` | Rules read reports in every mode with no model call. Recorded, live and Claude Code comparisons and replies, with the API mocked |
| `test/eval.test.js` | The rules read the evaluation corpus with no wrong reads and no missed holds; the scorer's own logic; the saved model run re-scores clean |
| `test/variants.test.js` | The category and date variants the eval found stay readable, the reader and the checker share one pattern, and a two-digit year still holds |
| `test/cmo.test.js` | The CMO view's numbers match the simulation summary, each case's phases add up to its days, and the built page has no unfilled value |

### Evaluation: how well does it read, and is it ever unsafe

`eval/` holds a synthetic evaluation corpus and a runner that scores the agent's three reading jobs. Each job has one safety number that must be zero, and the rest is coverage or cost.

| Job | Corpus | Safety number (must be 0) | Cost number |
| --- | --- | --- | --- |
| Rules read reports | 54 reports: standard, phrasing variants, date formats, bilateral, conflicting findings, addenda, pathology, instruction text planted in a report, noise | Wrong reads and missed holds | Over-holds: readable reports a radiologist had to look at anyway |
| Claude labels her replies | 44 replies: paraphrases, mixed labels, Spanish, a reply that embeds instructions, "STOP", a husband replying for a patient who died | Missed escalations: a reply that needed a person got an automated text | Over-escalations |
| Claude compares pathology with imaging | 12 pairs: concordant, side mismatches, nonspecific benign results for suspicious masses, nondiagnostic samples, a pair with nothing to compare | Missed mismatches not caught by the BI-RADS 5 rule | Over-flags |

Claude is scored on what the agent would do with its answer, not on the label alone. Every quote is checked word for word against the source, the same check the agent runs.

```sh
npm run eval          # the rules on the 54 reports, no model calls, exit 1 if anything is unsafe
npm run eval:model    # also replies and comparisons through your Claude Code sign-in (56 calls, about a dollar)
node eval/run.js --score eval/results/<file>.json   # re-score a saved run
```

Each run saves the raw model answers in `eval/results/` and writes `eval/REPORT.md`. The saved run (Oct 25, 2026, 56 calls through Claude Code):

| | Result |
| --- | --- |
| Rules | 40 of 40 readable reports read correctly, 17 of 17 holds, **0 unsafe** |
| Replies | 95.5% exact label sets, 100% right action, 100% quotes found, **0 missed escalations** |
| Comparisons | 11 of 12 match calls, 100% mismatch recall, 100% quotes found, 1 over-flag, **0 missed mismatches** |

`test/eval.test.js` runs the rules part on every `npm test` and fails the build if a wrong read or a missed hold appears. It also re-scores the saved run.

**What the eval changed.** The first run read 35 of 38 readable reports and held three that a radiologist would have read at a glance: `BIRADS 4B` without a hyphen, `ACR BI-RADS® Category 3` with the mark, and a `9/8/2026` date without leading zeros. Safe, but each one is a radiologist's time. The reader in `agent/agent.js` wanted the hyphen and two-digit dates, while the checker in `server/policy.js` already accepted `BIRADS`, so the two had drifted apart. The fix: one shared category pattern (`CATEGORY_PATTERN`) that both the reader and the checker use, dates with or without leading zeros, and three more corpus reports to hold the new edges (a two-digit year still holds; `BI RADS 3` and `BI-RADS category: 4A` read). `test/variants.test.js` keeps it that way. After the change: 40 of 40, 0 over-holds, still 0 unsafe. A real health system's report formats would add their own variants the same way: a corpus report first, then the rule.

### The CMO view

`docs/cmo.html` (live at [nitchakorn.github.io/BreastCancerScreening/cmo.html](https://nitchakorn.github.io/BreastCancerScreening/cmo.html)) is the one page a chief medical officer would read about this program. It is built by `scripts/cmo.js` from the same 90-day simulation as the main page, so the two always agree, and `test/cmo.test.js` checks that they do.

It answers five questions in the order an executive asks them:

| Question | What the page shows |
| --- | --- |
| Are we inside the window? | The CDC NBCCEDP indicator: abnormal result to final diagnosis within 60 days, target at least 75%. In the simulation, 8 of 8 (100%), median 10 days |
| Where do the days go? | For each case, days spent reaching her and booking, waiting for the appointment slot, and waiting for the result and review. In the simulation, the slot wait is half the days, which is a scheduling problem, not an outreach problem |
| How much human time? | Women who needed a person (5 of 11) and every handoff by role and reason: 4 to a navigator, 4 to a radiologist, 2 to surgery, against 24 texts, 3 portal messages, 2 calls, 9 replies read and 5 comparisons made by the agent |
| What is open? | A BI-RADS 3 woman 46 days past her six-month imaging and with a navigator, and one left breast on its six-month track |
| What did the safety checks catch? | A benign biopsy that did not explain a spiculated mass, flagged by Claude and confirmed by the radiologist, where the repeat biopsy found cancer; and a negative report over findings that described a mass, held by the rules and corrected by the radiologist |

With real data the page would read from the case store instead of the simulation. The questions would not change.

| Path | Purpose |
| --- | --- |
| `scripts/cmo.js` | Builds the CMO view from the simulation |
| `docs/cmo.html` | The built CMO view |
| `eval/corpus/` | The three evaluation corpora with gold labels |
| `eval/score.js` | Scoring, pure functions, tested |
| `eval/run.js` | The runner: rules offline, Claude through the same reader the workspace uses |
| `eval/results/` | Saved runs with raw model answers |
| `server/app.js` | HTTP API, demo clock and background reader |
| `server/loop.js` | Runs the shared engine for saved cases, one day at a time |
| `server/policy.js` | Checks every read and works out what the page shows |
| `server/store.js` | SQLite records, one transaction per change |
| `server/reader.js` | Rules for reports, and recorded or live Claude reads for replies and comparisons |
| `server/samples.js` | Sample reports and replies, dated to the demo clock |
| `app/` | The workspace page |

## How it works

1. **A new report arrives.** This starts the agent.
2. **Rules read the report.** They pull out the BI-RADS category, the exam date, which breast and the recommendation, each with the exact words it came from. When the report gives each breast its own category, they read each one.
3. **A report that doesn't fit the rules goes to a radiologist.** No category, two categories for one breast, or a negative impression over findings that describe a mass: the case stops there until a radiologist looks at it.
4. **Rules pick the pathway and set a due date for each breast** (table below). When each breast has its own assessment, each breast gets its own case, and the more urgent side goes first.
5. **The agent waits and watches.** Each day it checks whether the next step was booked or done.
6. **If the next step isn't booked, the agent reaches out.** It texts a booking link and checks the schedule. Claude reads her replies. No ride means a free ride option, and another time means new slots. No answer means a portal message, then an automated call.
7. **A person steps in only for exceptions.** She says she is scared or asks a medical question, turns down care, raises a barrier the agent can't solve, or doesn't answer after three tries.
8. **A new result comes in and the loop starts again.** A diagnostic mammogram goes back through steps 2 to 4.
9. **When a biopsy result comes back, Claude compares it with the imaging.** It writes a short side-by-side summary and flags anything that may not match, with the exact words from both reports. Code checks every quote. A radiologist decides. If it doesn't match, the agent follows her to a repeat biopsy.
10. **The case closes when the result is resolved.** Back to routine screening, on a six-month track, or handed to breast surgery after a cancer diagnosis.

Claude never decides what happens next. It reads her replies and compares reports, and every quote it gives is checked against the source. That keeps every decision traceable to a quote and a rule, and a rule change is a code change that can be tested.

## Pathways and deadlines

These deadlines are placeholders for clinical review. A health system's clinicians would set the real ones.

| BI-RADS | Next step | Due | Agent outreach starts | Goes to a person |
| --- | --- | --- | --- | --- |
| 1 or 2 | Routine screening | Next routine screen | None | None |
| 0 (screening) | Diagnostic mammogram or ultrasound | 14 days | As soon as the report is read | Day 30 if not booked, or any exception |
| 3 | Short-interval imaging | 6 months | 1 month before due | 1 month after due, or any exception |
| 4 or 5 | Biopsy | 14 days | As soon as the report is read | Day 7 if not booked, or any exception. For BI-RADS 5 the navigator also gets a heads-up on day 1, but the case doesn't wait on her. |
| After biopsy | Pathology result | 10 days after biopsy | None. The agent never gives results. | Day 10 if no result |
| Benign result that doesn't match | Repeat biopsy | 14 days from the radiologist's call | As soon as the radiologist calls it | Day 7 if not booked, or any exception |

Each breast with its own assessment follows its own row. Closing one side never closes the other. A BI-RADS 5 finding with a benign biopsy is always flagged by rule, whatever Claude says.

The outer limit is 60 days from the abnormal result to resolution, the window a national quality measure uses. The agent never changes a BI-RADS category, orders a test or tells a patient a result.

## The eleven demo patients

| | Path |
| --- | --- |
| P1 | BI-RADS 1. Routine, so the agent stays quiet. |
| P2 | BI-RADS 0. Books from the first text. Diagnostic comes back BI-RADS 2. |
| P3 | BI-RADS 0. Needs a ride. Gets the ride option, books, benign. |
| P4 | BI-RADS 0. No answer to a text, a portal message or a call, so a navigator takes over. |
| P5 | BI-RADS 3. Books from the reminder. Stable at 6 months. |
| P6 | BI-RADS 3. Ignores the reminders. Goes to a navigator one month after the due date. |
| P7 | BI-RADS 4. Says she is scared, so a navigator calls her. Benign biopsy. Claude flags the partly indistinct margins, and the radiologist confirms it matches the imaging. |
| P8 | BI-RADS 5. Books the biopsy right away. Cancer, handed to breast surgery. |
| P9 | Unclear report: the impression says negative but the findings describe a possible mass. Held for a radiologist, who corrects it. |
| P10 | Findings in both breasts: BI-RADS 4A on the right, BI-RADS 3 on the left. Books the right-side biopsy from the first text. Benign. Claude flags the indistinct margins, and the radiologist confirms it matches the imaging. The right side is resolved in 11 days. The left side stays open on its six-month track, due March 8, 2027, and the agent keeps following it. |
| P11 | BI-RADS 4C, a spiculated mass. Her biopsy comes back benign. Claude flags that fibrocystic change doesn't explain the mass, and the radiologist calls it a mismatch. The agent tells her doctor and texts her to book a repeat biopsy. She replies that her doctor's office said the biopsy was benign, so a navigator calls her and books it. The repeat biopsy finds invasive lobular carcinoma, and breast surgery takes over 18 days after her imaging. |

At the end of the 90 days, all eight abnormal results are resolved within 60 days (median 10 days), five of eleven patients needed a person for an exception or an unclear report, and Joyce K.'s left breast is still on its six-month track.

## Run it yourself

You need [Node.js](https://nodejs.org).

```
node scripts/check.js        # print every patient's timeline and the summary
node scripts/check.js P11    # one patient
node scripts/build.js        # rebuild docs/index.html
```

Then open `docs/index.html` in a browser.

The **Workflow** section contains the full flowchart. Choose **Expand flowchart** to zoom and scroll, or **Download SVG** to keep a vector copy. Close the viewer with **Close** or Escape. The diagram is embedded in the built HTML, so it also works when that file is opened directly.

The diagram source is `site/workflow.dot`, with its rendered image in `site/workflow.svg`. If you edit the diagram, regenerate it with Graphviz (`dot -Tsvg site/workflow.dot -o site/workflow.svg`), then run `node scripts/build.js` to update the page.

To run Claude's part again, you also need [Claude Code](https://claude.com/claude-code) installed and signed in:

```
node scripts/read.js         # sends every reply, and each biopsy result with its imaging report, to Claude; saves to reads/
node scripts/read.js --samples   # reads the extra workspace replies only
node scripts/read.js --only P11-r1,P11-path --note "what was added"   # reads only those items and adds them to the saved run
```

Claude's comparisons of the five biopsy results and Evelyn B.'s reply were recorded on Oct 23, 2026 (6 calls, about 11 cents). The other replies were recorded on Oct 22 and 23, in the same runs as the first version's report reads.

No API key is stored in this repo. The page replays the recorded reads in `reads/`, so it works without one.

## What's where

| Path | What it is |
| --- | --- |
| `data/documents.json` | The reports, the addendum and the pathology reports, all made up. Each pathology report names the imaging report it follows |
| `data/replies.json` | Patients' text replies |
| `data/sample-replies.json` | Extra replies for the workspace, so every reply rule has a sample |
| `data/patients.json` | The patients, and how the simulated world reacts to the agent |
| `prompts/` | The two prompts Claude gets: one to compare a biopsy result with the imaging, one for replies |
| `reads/` | What Claude returned: replies, comparisons, and the first version's report reads that the tests check the rules against |
| `agent/agent.js` | The report rules, the follow-up rules, the engine and the day-by-day simulation |
| `server/`, `app/` | The local workspace |
| `test/` | Tests, including the simulation's saved output in `test/fixtures/` |
| `scripts/` | Reading, checking and building |
| `site/template.html` | The page template |
| `site/browser-workspace.js` | What changes when the workspace runs in the browser |
| `docs/index.html` | The built page |
| `docs/workspace.html` | The built workspace that runs in the browser |
| `docs/cmo.html` | The built CMO view |
