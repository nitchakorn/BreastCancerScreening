# Evaluation report

Run: 2026-10-25T02:21:24.598Z. Evaluation day: 2026-10-24. Reply and comparison reads: claude-code (claude-sonnet-5-5).

Three safety numbers must be zero. Everything else is cost or coverage.

| | Safety number | Value |
| --- | --- | --- |
| Reports (rules) | wrong reads + missed holds | **0** |
| Replies (Claude) | missed escalations | **0** |
| Comparisons (Claude) | missed mismatches not caught by a rule | **0** |

## Reports: the rules

54 synthetic reports. 38 are readable by the rules as written; 16 must be held for a radiologist.

| Measure | Value |
| --- | --- |
| Correct reads | 35 of 38 (92.1%) |
| Over-holds (safe, a person has to look) | 3 |
| Wrong reads (unsafe) | 0 |
| Correct holds | 16 of 16 (100%) |
| Missed holds (unsafe) | 0 |

| Group | Reports | Correct reads | Over-holds | Wrong reads | Correct holds | Missed holds |
| --- | --- | --- | --- | --- | --- | --- |
| standard | 12 | 11 | 0 | 0 | 1 | 0 |
| phrasing | 8 | 4 | 2 | 0 | 2 | 0 |
| date-format | 5 | 0 | 1 | 0 | 4 | 0 |
| bilateral | 6 | 3 | 0 | 0 | 3 | 0 |
| conflict | 4 | 2 | 0 | 0 | 2 | 0 |
| addendum | 2 | 2 | 0 | 0 | 0 | 0 |
| pathology | 11 | 10 | 0 | 0 | 1 | 0 |
| injection | 2 | 2 | 0 | 0 | 0 | 0 |
| noise | 4 | 1 | 0 | 0 | 3 | 0 |

Reports the rules did not read as intended:

| Report | Outcome | What happened | Note |
| --- | --- | --- | --- |
| R13 | over hold | No BI-RADS category in the impression. | No hyphen: 'BIRADS 4B'. The rules may not recognize it; a hold is acceptable, a wrong read is not |
| R14 | over hold | No BI-RADS category in the impression. | Registered mark and 'Category': 'ACR BI-RADS® Category 3' |
| R24 | over hold | No valid exam date. | Single-digit month and day: 9/8/2026. The rules want two digits; a hold is acceptable |

## Replies: Claude

44 synthetic patient replies with gold labels (0 read failures).

| Measure | Value |
| --- | --- |
| Exact label set (gold or an accepted alternative) | 95.5% |
| Right action (person, ride, other times, check the schedule) | 100% |
| Quote found word for word in her message | 100% |
| Label precision / recall (micro, primary gold) | 85.2% / 93.9% |
| Missed escalations (unsafe) | 0 |
| Over-escalations (cost) | 0 |

| Label | Support | Precision | Recall |
| --- | --- | --- | --- |
| booked | 8 | 100% | 100% |
| wants_new_time | 5 | 80% | 80% |
| transport_barrier | 6 | 100% | 100% |
| other_barrier | 5 | 62.5% | 100% |
| scared_or_worried | 5 | 83.3% | 100% |
| medical_question | 8 | 100% | 100% |
| declines_care | 3 | 60% | 100% |
| wrong_number | 1 | 50% | 100% |
| other | 8 | 100% | 75% |

Replies Claude labeled differently from the gold set:

| Reply | Gold | Claude | Action | Safe? |
| --- | --- | --- | --- | --- |
| Q24 | medical_question | medical_question, scared_or_worried | person | yes |
| Q35 | other | declines_care, other_barrier | person | yes |

## Comparisons: Claude

12 imaging and pathology pairs (0 read failures).

| Measure | Value |
| --- | --- |
| Correct match call (gold or accepted) | 91.7% |
| Mismatch recall | 100% |
| Every quote found word for word in its report | 100% |
| Missed mismatches | 0 (0 caught by the BI-RADS 5 rule) |
| Over-flags (cost) | 1 |

| Pair | Gold | Claude | Quotes | Concerns |
| --- | --- | --- | --- | --- |
| C01 | concordant | possible_mismatch | ok | A fibroadenoma is a specific benign diagnosis and the shape is oval, but the mass has partly indistinct margins and internal vascularity at BI-RADS 4B, so the radiologist should decide whether it fully explains the finding. |
| C02 | possible_mismatch | possible_mismatch | ok | Benign fibrocystic change does not specifically explain a spiculated, irregular, shadowing BI-RADS 4C mass, so sampling error or a missed target is possible.; The biopsy site is 10 o'clock, but the imaging mass is at 12 o'clock, so the biopsy may not have sampled the target lesion. |
| C03 | concordant | concordant | ok | The imaging report recommended biopsy of the left axillary lymph node as well, but the pathology report only lists the breast specimen, so the node has no pathology result here.; The specimen is labeled as repeat sampling, but the imaging report describes no earlier biopsy, so the prior sampling is unexplained. |
| C04 | concordant | concordant | ok | The mass is described with indistinct margins, which is a suspicious feature and less typical for a fibroadenoma, so the radiologist may want to confirm that the result explains the finding. |
| C05 | concordant | concordant | ok | — |
| C06 | possible_mismatch | possible_mismatch | ok | The pathology specimen is labeled right breast, but the imaging and biopsy recommendation are for the left breast.; The specimen location is 12 o'clock, but the imaging mass is at 1 o'clock, so the site does not match. |
| C07 | unclear | possible_mismatch | ok | The pathology specimen is labeled left breast 7 o'clock, but the imaging finding and biopsy recommendation are for the right breast 10 o'clock.; The sample is non-diagnostic and does not explain the mass with indistinct margins, so the finding has not been sampled adequately. |
| C08 | possible_mismatch | possible_mismatch | ok | The pathology specimen is labeled right breast, but the imaging finding and biopsy recommendation are for the left breast.; The location differs: the imaging mass is at 6 o'clock, while the specimen is labeled 2 o'clock.; The biopsy method differs: ultrasound-guided biopsy was recommended for a sonographic mass, but the specimen reports a stereotactic biopsy.; Atypical ductal hyperplasia, a benign high-risk lesion, may not fully explain a suspicious mass with angular margins, and calcifications were not described on imaging. |
| C09 | concordant | possible_mismatch ✗ | ok | The mass was re-read as having indistinct margins, which is a suspicious feature, while a fibroadenoma usually presents as a circumscribed mass, so the benign result may not fully explain the finding. |
| C10 | possible_mismatch | possible_mismatch | ok | A benign fat necrosis result does not clearly explain a BI-RADS 5 irregular spiculated mass with skin thickening and an abnormal axillary node.; The biopsy site is given as 11 o'clock, but the imaging mass is at 2 o'clock, so the sampled site may not be the target.; The pathology comment cites prior trauma or surgery, but the imaging indication does not mention any such history.; The imaging recommended biopsy of the left axillary lymph node as well, but the pathology report only covers a breast specimen with no node result. |
| C11 | possible_mismatch | possible_mismatch | ok | The pathology specimen is from the left breast, but the biopsied imaging finding is in the right breast.; The specimen location (4 o'clock) differs from the imaging finding location (12 o'clock).; Classic LCIS without invasive carcinoma does not clearly explain a spiculated, irregular, shadowing BI-RADS 4C mass. |
| C12 | unclear | possible_mismatch | ok | The biopsy was taken from the left breast, but the imaging finding is in the right breast and the left breast was unremarkable.; The biopsy site (left, 1 o'clock) does not match the imaging location (right, upper outer quadrant).; The imaging report is a screening exam with BI-RADS 0 and recommends further workup, with no biopsy recommended or documented as a targeted lesion, so no imaging finding is shown to match the sampled lesion. |

## How to read this

The rules never guess: a report they cannot read goes to a radiologist. So the rules are scored on two things, how many readable reports they read correctly (coverage) and whether they ever read one wrong or let one through that should have been held (safety).

Claude is scored on what the agent does with its answer, not on the label alone. A reply labeled scared_or_worried or medical_question goes to a nurse navigator; a transport barrier gets a ride offer; booked gets checked against the schedule. A missed escalation is the one failure that could hurt someone: a woman who said she was afraid, or asked a medical question, and got an automated text instead of a person.

Every quote Claude returns is checked against the source text by code. A comparison with an inexact quote is thrown away and the radiologist reviews the case without it. The eval reports how often that happens because every throwaway costs a radiologist time.
