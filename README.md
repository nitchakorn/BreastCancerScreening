# Breast Screening Follow-up Agent

A small working agent that makes sure no woman with an abnormal mammogram gets lost before her result is resolved.

Claude reads each breast imaging report, pathology report and patient text reply. Plain code checks those reads, picks the pathway, sets the deadline, decides every follow-up, and hands a case to a person only when a rule says so. A day-by-day simulation shows the agent working nine made-up patients over 90 days.

**Live demo:** turn on GitHub Pages for this repo (Settings, then Pages, then deploy from the `main` branch and the `/docs` folder). The page will be at `https://nitchakorn.github.io/BreastCancerScreening/`.

This is a demo with synthetic patients. It sends no real messages, books nothing and writes to no EHR. Not for clinical use.

## Local agent workspace

The local workspace adds report intake, a background reader, SQLite case storage, rule validation, a human review queue, an action history and an in-app test inbox. The original nine-patient simulation and workflow flowchart remain available from the workspace header.

You need **Node.js 24.5 or newer**. All server and test code uses Node's built-in modules; there are no npm dependencies to install.

```sh
npm start
```

Open the local address printed by the server, normally `http://127.0.0.1:3000`. Start with **Try a sample**, then choose **Read report & start case**. You can also save a sample as a `.txt` file and upload it. The server binds to loopback; this milestone is a local synthetic-data workspace without authentication.

### Recorded mode: no key required

With no API key configured, the workspace uses **recorded mode**, clearly identified in the banner and each case's action history. It recognizes the eight bundled synthetic reports, with their exam/procedure date adjusted to today. It does not read arbitrary new reports or call a model. Altered or unknown reports fail explicitly; they never silently use a different sample's answer.

Try **Diagnostic imaging** to create a case due in 14 days and a test-inbox message. **Routine screening** closes without outreach. **Conflicting findings** creates a review task without sending a patient message. **BI-RADS 5** adds a navigator heads-up while outreach continues. Pathology always goes to human review in this milestone. Six-month cases wait until one month before their due date for the initial message. Bookings can't be confirmed yet in this milestone, so a case that is still waiting for a booking goes to a navigator at its deadline: 7 days after the report for a biopsy, 30 days for diagnostic imaging, and one month after the due date for six-month imaging.

Cases, messages, review tasks and events are stored in `.local/cases.sqlite`, which is excluded from Git. Duplicate submissions with the same patient label and report reuse the case. The initial local message is committed atomically with the case decision and has a unique delivery key. Restarting resumes interrupted reads without duplicating that message. An interrupted live model call may be repeated; local delivery deduplication does not imply model-call billing is exactly once.

Sample dates and deadline checks use `APP_TIME_ZONE` (default `America/New_York`). Event timestamps are stored in UTC and displayed in the browser's local time.

### Enable live Claude reading later

Keep credentials in environment settings or a local `.env` file, never in Git or chat. To use a local file, copy `.env.example` to `.env`, set `READER_MODE=live` and set `ANTHROPIC_API_KEY` securely. Restart the server afterward. You can leave `ANTHROPIC_MODEL` blank to discover an available Sonnet model from your API account, or choose an available model ID explicitly. To force recorded mode even when a key is present, set `READER_MODE=recorded`.

Live mode calls `api.anthropic.com` using the existing report prompt and a structured `record_report` tool. Code checks the supporting quotes, category and date before selecting an action. A failed API request retains the case with a **Retry report read** action. An unusable structured answer enters human review. The API key stays on the server. In the managed cloud environment, the start command preserves the configured proxy and CA verification.

This first milestone stops at **report → read → saved pathway → initial test message or review → navigator handoff if still unbooked at the deadline**. Reply processing, confirmed bookings, repeat outreach and external messaging integrations are future work. Recorded-mode readiness does not establish that live API access works.

### Validate and demonstrate

```sh
npm test            # HTTP workflow, SQLite persistence, duplicates, policy failures and mocked provider errors
npm run check       # original nine-patient simulation
npm run build       # original standalone dashboard and embedded workflow
```

For a short demonstration: submit the diagnostic sample, inspect its evidence and inbox, submit it again to show deduplication, restart the server to show persistence, then submit the conflicting sample to show human review. The automated provider tests use test doubles and do not call Anthropic. A live demonstration requires enabling and checking live mode separately.

| Path | Purpose |
| --- | --- |
| `server/reader.js` | Explicit recorded mode and live Anthropic adapter |
| `server/policy.js` | Validation and initial action selection using the existing pathway rules |
| `server/store.js` | SQLite records, atomic inbox delivery, recovery and event history |
| `server/app.js` | HTTP API and background case worker |
| `app/` | Local workspace interface |
| `test/` | Tests with no model charges |

## How it works

1. **A new report arrives.** This starts the agent.
2. **Claude reads the report.** It returns the BI-RADS category, which breast, the recommended next step, the exam date and the exact words that support each one.
3. **Code checks the read.** Every quote must match the report word for word. If the BI-RADS category is missing, or the findings and the impression disagree, the case goes to a radiologist and stops there.
4. **Rules pick the pathway and set a due date** (table below).
5. **The agent waits and watches.** Each day it checks whether the next step was booked or done.
6. **If the next step isn't booked, the agent reaches out.** It texts a booking link and checks the schedule. Claude reads her replies. No ride means a free ride option, and another time means new slots. No answer means a portal message, then an automated call.
7. **A person steps in only for exceptions.** She says she is scared or asks a medical question, turns down care, raises a barrier the agent can't solve, or doesn't answer after three tries.
8. **A new result comes in and the loop starts again.** A diagnostic mammogram or a pathology report goes back through steps 2 to 4.
9. **The case closes when the result is resolved.** Back to routine screening, on a six-month track, or handed to breast surgery after a cancer diagnosis.

Claude never decides what happens next. It only reads and quotes. That keeps every decision traceable to a quote and a rule, and a rule change is a code change that can be tested.

## Pathways and deadlines

| BI-RADS | Next step | Due | Agent outreach starts | Goes to a person |
| --- | --- | --- | --- | --- |
| 1 or 2 | Routine screening | Next routine screen | None | None |
| 0 (screening) | Diagnostic mammogram or ultrasound | 14 days | As soon as the report is read | Day 30 if not booked, or any exception |
| 3 | Short-interval imaging | 6 months | 1 month before due | 1 month after due, or any exception |
| 4 or 5 | Biopsy | 14 days | As soon as the report is read | Day 7 if not booked, or any exception. For BI-RADS 5 the navigator also gets a heads-up on day 1, but the case doesn't wait on her. |
| After biopsy | Pathology result | 10 days after biopsy | None. The agent never gives results. | Day 10 if no result |

The outer limit is 60 days from the abnormal result to resolution, the window a national quality measure uses. The agent never changes a BI-RADS category, orders a test or tells a patient a result.

## The nine demo patients

| | Path |
| --- | --- |
| P1 | BI-RADS 1. Routine, so the agent stays quiet. |
| P2 | BI-RADS 0. Books from the first text. Diagnostic comes back BI-RADS 2. |
| P3 | BI-RADS 0. Needs a ride. Gets the ride option, books, benign. |
| P4 | BI-RADS 0. No answer to a text, a portal message or a call, so a navigator takes over. |
| P5 | BI-RADS 3. Books from the reminder. Stable at 6 months. |
| P6 | BI-RADS 3. Ignores the reminders. Goes to a navigator one month after the due date. |
| P7 | BI-RADS 4. Says she is scared, so a navigator calls her. Benign biopsy, and a person confirms it matches the imaging. |
| P8 | BI-RADS 5. Books the biopsy right away. Cancer, handed to breast surgery. |
| P9 | Unclear report: the impression says negative but the findings describe a possible mass. Held for a radiologist, who corrects it. |

At the end of the 90 days, all six abnormal results are resolved within 60 days (median 8.5 days), and four of nine patients needed a person.

## Run it yourself

You need [Node.js](https://nodejs.org).

```
node scripts/check.js        # print every patient's timeline and the summary
node scripts/check.js P7     # one patient
node scripts/build.js        # rebuild docs/index.html
```

Then open `docs/index.html` in a browser.

The **Workflow** section contains the full flowchart. Choose **Expand flowchart** to zoom and scroll, or **Download SVG** to keep a vector copy. Close the viewer with **Close** or Escape. The diagram is embedded in the built HTML, so it also works when that file is opened directly.

The diagram source is `site/workflow.dot`, with its rendered image in `site/workflow.svg`. If you edit the diagram, regenerate it with Graphviz (`dot -Tsvg site/workflow.dot -o site/workflow.svg`), then run `node scripts/build.js` to update the page.

To run the reading step again, you also need [Claude Code](https://claude.com/claude-code) installed and signed in:

```
node scripts/read.js         # sends every report and reply to Claude, saves to reads/
```

No API key is stored in this repo. The page replays the recorded reads in `reads/`, so it works without one.

## What's where

| Path | What it is |
| --- | --- |
| `data/documents.json` | The reports, the addendum and the pathology reports, all made up |
| `data/replies.json` | Patients' text replies |
| `data/patients.json` | The patients, and how the simulated world reacts to the agent |
| `prompts/` | The two prompts Claude gets: one for documents, one for replies |
| `reads/` | What Claude returned in the recorded run |
| `agent/agent.js` | The rules and the day-by-day simulation |
| `scripts/` | Reading, checking and building |
| `site/template.html` | The page template |
| `docs/index.html` | The built page |
