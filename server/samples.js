const documents = require('../data/documents.json');
const reads = require('../reads/documents.json');
const ids = ['P2-screen', 'P1-screen', 'P7-dx', 'P9-screen', 'P5-apr', 'P8-dx', 'P7-path', 'P8-path'];
const names = ['Diagnostic imaging', 'Routine screening', 'Biopsy pathway', 'Conflicting findings', 'Six-month follow-up', 'BI-RADS 5 heads-up', 'Benign pathology review', 'Malignant pathology handoff'];
function normalize(text) { return text.trim().replace(/^(PROCEDURE )?DATE:.*$/m, '$1DATE: <exam date>'); }
function examples(today) {
  const [y, m, d] = today.split('-');
  return ids.map((id, i) => ({ id, label: names[i], text: documents.find(doc => doc.id === id).text.replace(/^(PROCEDURE )?DATE:.*$/m, `$1DATE: ${m}/${d}/${y}`) }));
}
function recordedRead(text) {
  const doc = documents.find(item => ids.includes(item.id) && normalize(item.text) === normalize(text));
  const date = text.match(/^(?:PROCEDURE )?DATE: (\d{2})\/(\d{2})\/(\d{4})\s*$/m);
  if (!doc || !date) return null;
  const read = structuredClone(reads[doc.id]);
  read.exam_date = `${date[3]}-${date[1]}-${date[2]}`;
  read.quotes.exam_date = date[0].trim();
  return read;
}
module.exports = { examples, recordedRead };
