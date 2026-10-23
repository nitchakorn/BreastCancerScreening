# Breast Screening Follow-up Agent

A small working agent that makes sure no woman with an abnormal mammogram gets lost before her result is resolved.

Claude reads each breast imaging report, pathology report and patient text reply. Plain code checks those reads, picks the pathway, sets the deadline, decides every follow-up, and hands a case to a person only when a rule says so. A day-by-day simulation shows the agent working nine made-up patients over 90 days.

**Live demo:** turn on GitHub Pages for this repo (Settings, then Pages, then deploy from the `main` branch and the `/docs` folder). The page will be at `https://nitchakorn.github.io/BreastCancerScreening/`.

This is a demo with synthetic patients. It sends no real messages, books nothing and writes to no EHR. Not for clinical use.

## Local agent workspace

The workspace runs the same agent on cases you create. Give it a report and it follows up the way the simulation does: a text, a portal message and an automated call, replies read by Claude, bookings, a reminder the day before, and the next report until the result is resolved. People step in through the same handoffs. A demo clock moves time forward, so a month of follow-up takes a few clicks.

The workspace and the simulation share one engine (`createEngine` in `agent/agent.js`). A test replays all nine simulated patients through the workspace and checks that the agent makes the same decisions, 106 of them, on the same days.

You need Node.js 22.22 or newer (24.5 or newer also works). There are no npm packages to install.

```sh
npm start
```

Open `http://127.0.0.1:3000`. The server only listens on your own computer and has no login, so use synthetic data only.

### A three-minute demo

1. Pick **Diagnostic imaging** under Try a sample and choose **Read report & start case**. Claude's read is checked, the pathway is set and the first text goes to the test inbox. **Coming up** shows the agent's plan: a portal message on day 2, a call on day 4, and a navigator on day 5 if she never answers.
2. Choose **+1 day**. Under the test inbox, pick the sample reply **Has no ride** and send it. Claude labels it, code checks the quote, and the agent offers a free ride.
3. Under **Test schedule**, choose **She booked online**. The agent sees the booking. Move the clock: it texts a reminder the day before, then marks the appointment done and watches for the report.
4. Under **Reports**, add **Diagnostic result: benign (BI-RADS 2)**. The case closes and shows how many days it took.
5. Start a **Biopsy pathway** case and send the reply **Scared, asks for a call**. The case goes to the nurse navigator, who can book for her, hand the case back to the agent, or close it with a note.
6. Start **Conflicting findings**. It is held for a radiologist. Add the **Radiologist addendum** as the next report and the agent picks the case back up.

**Start over** clears every case and resets the clock.

### What the workspace does

| You do | The agent does |
| --- | --- |
| Start a case with a report | Claude reads it, code checks every quote, and the rules set the pathway, the due date and the day a person takes over |
| Move the clock | Runs its daily check for every day in between: texts, portal messages, calls, check-ins, reminders, overdue notes and handoffs |
| Reply as the patient | Claude labels the reply and quotes it, and code checks the quote. No ride gets a ride offer, another time gets open slots, and a booking claim gets checked against the schedule. Fear, medical questions, refusals, wrong numbers and unclear replies go to the navigator |
| Book in the test schedule | Trusts the schedule over what she says, texts a reminder the day before, and marks the appointment done on the day |
| Add the next report | Reads and checks it like the first one. A result can close the case, start a biopsy pathway or release a radiologist hold |
| Act as the navigator or radiologist | Hand the case back to the agent, book for her, confirm that benign pathology matches the imaging, or close the case with a note |

Two watches exist only in the workspace, because in the simulation the report always arrives on time. The agent hands the case to a navigator if the imaging report is not in 3 days after the appointment, or if pathology is not in 10 days after the biopsy.

### Recorded mode: no key required

With no API key, the workspace uses **recorded mode**. Claude's reads of the bundled reports and replies were recorded earlier with Claude Code (see `reads/`). Sample reports get their dates moved to the demo clock, and recorded mode moves the dates in the recorded read the same way. Any other text fails openly and can be retried in live mode. It never borrows another sample's answer.

### Live mode

Keep credentials in a local `.env` file, never in Git or chat. Copy `.env.example` to `.env`, set `READER_MODE=live` and `ANTHROPIC_API_KEY`, and restart. Leave `ANTHROPIC_MODEL` blank to use an available Sonnet model. Reports and replies go to the Claude API with a forced tool call (`record_report` or `record_reply`), and their text is treated as source material, never as instructions. Code checks every read before the agent acts. A failed API call keeps the item with a **Retry** button. An unusable answer goes to a person.

### Saved data

Cases, reports, replies, messages, handoffs and events are stored in `.local/cases.sqlite`, which Git ignores. Each change is one transaction: the agent's state, its messages and its handoffs are saved together, so a restart never sends a message twice. A database from milestone 1 is kept under a new name and a fresh one starts. Dates follow `APP_TIME_ZONE` (default `America/New_York`).

### Tests

```sh
npm test            # everything below, with no model calls
npm run check       # print the nine-patient simulation
npm run build       # rebuild docs/index.html
```

| Test | What it proves |
| --- | --- |
| `test/simulation.test.js` | The simulation prints exactly the saved timelines and summary |
| `test/parity.test.js` | The workspace makes the same decisions on the same days as the simulation, for all nine patients |
| `test/loop.test.js` | Outreach, replies, bookings, results, people's actions and the demo clock, through the HTTP API |
| `test/workflow.test.js` | Intake, duplicates, restarts, retries and request checks |
| `test/policy.test.js` | A bad read is held for a person instead of messaging her |
| `test/reader.test.js` | Recorded and live reading, with the API mocked |

| Path | Purpose |
| --- | --- |
| `server/app.js` | HTTP API, demo clock and background reader |
| `server/loop.js` | Runs the shared engine for saved cases, one day at a time |
| `server/policy.js` | Checks every read and works out what the page shows |
| `server/store.js` | SQLite records, one transaction per change |
| `server/reader.js` | Recorded mode and the live Claude API reader |
| `server/samples.js` | Sample reports and replies, dated to the demo clock |
| `app/` | The workspace page |

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
node scripts/read.js --samples   # reads the extra workspace replies only
```

No API key is stored in this repo. The page replays the recorded reads in `reads/`, so it works without one.

## What's where

| Path | What it is |
| --- | --- |
| `data/documents.json` | The reports, the addendum and the pathology reports, all made up |
| `data/replies.json` | Patients' text replies |
| `data/sample-replies.json` | Extra replies for the workspace, so every reply rule has a sample |
| `data/patients.json` | The patients, and how the simulated world reacts to the agent |
| `prompts/` | The two prompts Claude gets: one for documents, one for replies |
| `reads/` | What Claude returned in the recorded run |
| `agent/agent.js` | The rules, the engine and the day-by-day simulation |
| `server/`, `app/` | The local workspace |
| `test/` | Tests, including the simulation's saved output in `test/fixtures/` |
| `scripts/` | Reading, checking and building |
| `site/template.html` | The page template |
| `docs/index.html` | The built page |
