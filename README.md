# Breast Screening Follow-up Agent

A small working agent that makes sure no woman with an abnormal mammogram gets lost before her result is resolved.

Claude reads each breast imaging report, pathology report and patient text reply. Plain code checks those reads, picks the pathway, sets the deadline, decides every follow-up, and hands a case to a person only when a rule says so. A day-by-day simulation shows the agent working nine made-up patients over 90 days.

**Live demo:** turn on GitHub Pages for this repo (Settings, then Pages, then deploy from the `main` branch and the `/docs` folder). The page will be at `https://nitchakorn.github.io/BreastCancerScreening/`.

This is a demo with synthetic patients. It sends no real messages, books nothing and writes to no EHR. Not for clinical use.

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
