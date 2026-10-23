const { EXCEPTIONS } = require('../agent/agent.js');
const labels = ['booked', 'wants_new_time', 'transport_barrier', ...Object.keys(EXCEPTIONS), 'other'];

function decideReply(text, read) {
  const problems = [];
  if (!read || !Array.isArray(read.labels) || !read.labels.length || read.labels.some(label => !labels.includes(label))) problems.push('The reply labels are missing or unsupported.');
  if (!read || typeof read.quote !== 'string' || !read.quote.trim() || !text.includes(read.quote)) problems.push('The supporting quote does not match the patient reply word for word.');
  if (!read || typeof read.summary !== 'string' || !read.summary.trim()) problems.push('The reply summary is missing.');
  const hold = reason => ({ status: 'needs_review', review: reason, problems, messages: [], booked: false });
  if (problems.length) return hold(problems.join(' '));
  const exception = read.labels.find(label => EXCEPTIONS[label]);
  if (exception) return hold(EXCEPTIONS[exception] + '. A navigator must review the reply; automated outreach is paused.');
  const messages = [];
  if (read.labels.includes('transport_barrier')) messages.push({ kind: 'transport', body: 'We can help with transport to your appointment. In this test inbox, a ride-support option has been offered; no ride has been booked.' });
  if (read.labels.includes('wants_new_time')) messages.push({ kind: 'slots', body: 'Test appointment options: Monday 9:00, Wednesday 13:30, or Friday 10:15. These are sample options; availability and booking have not been confirmed.' });
  const booked = read.labels.includes('booked');
  if (!messages.length && !booked) return hold('The reply needs a navigator to decide the next step. Automated outreach is paused.');
  return { status: booked ? 'booking_claimed' : 'awaiting_booking', review: null, problems, messages, booked };
}

module.exports = { decideReply, replyLabels: labels };
