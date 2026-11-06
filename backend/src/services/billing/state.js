// Pure subscription state logic (no database) so it is easy to test.
//   trialing  -> expired        when the trial ends
//   active    -> past_due       when the paid period ends (grace period, full access)
//   past_due  -> expired        after the grace period
//   active/trialing + cancel    -> cancelled when the period/trial ends
// Expired and cancelled businesses keep all their data and can read it, but cannot create or change anything.
const DAY = 86400000;

function effectiveStatus(sub, now = new Date(), graceDays = 3) {
  if (!sub) return 'expired';
  const t = now.getTime();
  const trialEnd = sub.trial_end ? new Date(sub.trial_end).getTime() : null;
  const end = sub.end_date ? new Date(sub.end_date).getTime() : null;
  switch (sub.status) {
    case 'cancelled': return 'cancelled';
    case 'expired': return 'expired';
    case 'trialing':
      if (trialEnd !== null && t > trialEnd) return sub.cancel_at_period_end ? 'cancelled' : 'expired';
      return 'trialing';
    case 'active':
    case 'past_due':
      if (end === null || t <= end) return 'active';
      if (sub.cancel_at_period_end) return 'cancelled';
      return t <= end + graceDays * DAY ? 'past_due' : 'expired';
    default: return 'expired';
  }
}

/** Can the business create/change data? Read access is always kept. */
const canWrite = (status) => status === 'trialing' || status === 'active' || status === 'past_due';

module.exports = { effectiveStatus, canWrite };
