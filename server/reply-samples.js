const replies = require('../data/replies.json');
const reads = require('../reads/replies.json');
const samples = [
  ...[['P3-r1', 'Need a ride'], ['P7-r1', 'Scared / worried'], ['P8-r1', 'I booked']].map(([id, label]) => ({ id, label, text: replies.find(item => item.id === id).text, read: reads[id] })),
  { id: 'new-time', label: 'Different time', text: 'Could I get a different appointment time?', read: { labels: ['wants_new_time'], quote: 'different appointment time', summary: 'The patient requests another appointment time.' } },
  { id: 'medical', label: 'Medical question', text: 'Does this mean I have cancer?', read: { labels: ['medical_question'], quote: 'Does this mean I have cancer?', summary: 'The patient asks about the medical meaning of the result.' } },
  { id: 'decline', label: 'Decline care', text: 'I do not want this appointment.', read: { labels: ['declines_care'], quote: 'I do not want this appointment.', summary: 'The patient declines the appointment.' } },
  { id: 'wrong-number', label: 'Wrong number', text: 'Wrong number. Please stop texting me.', read: { labels: ['wrong_number'], quote: 'Wrong number. Please stop texting me.', summary: 'The message reached the wrong person, who asks to stop contact.' } }
];
function replyExamples() { return samples.map(({ id, label, text }) => ({ id, label, text })); }
function recordedReply(text) { return structuredClone(samples.find(sample => sample.text.trim() === text.trim())?.read || null); }
module.exports = { replyExamples, recordedReply };
