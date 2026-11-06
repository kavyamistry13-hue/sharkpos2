import { Link } from 'react-router-dom';
import { AlertTriangle, Clock } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useBilling } from '../hooks/useBilling';
import { dateOnly } from '../utils/format';

/** Thin strip under the header: trial ending, payment overdue, or expired (data safe, read-only). */
export default function SubscriptionBanner() {
  const { isRole } = useAuth();
  const { status } = useBilling();
  if (!status) return null;
  const owner = isRole('business_owner');
  const cta = owner ? <Link to="/billing" className="ml-2 font-bold underline">{status.status === 'trialing' ? 'Choose a plan' : 'Renew Subscription'}</Link> : <span className="ml-2">Ask the business owner to renew.</span>;
  let tone, icon, text;
  if (status.status === 'expired' || status.status === 'cancelled') {
    tone = 'bg-bad-soft text-bad'; icon = AlertTriangle;
    text = status.status === 'cancelled' ? 'Your subscription has ended. Your data is safe.' : 'Your subscription has expired. Your data is safe.';
  } else if (status.status === 'past_due') {
    tone = 'bg-warn-soft text-warn'; icon = AlertTriangle;
    text = 'Your payment is overdue. Renew soon to keep creating sales and changes.';
  } else if (status.status === 'trialing' && status.daysLeft != null && status.daysLeft <= 5) {
    tone = 'bg-warn-soft text-warn'; icon = Clock;
    text = `Your free trial ends in ${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'} (${dateOnly(status.endsAt)}).`;
  } else return null;
  const Icon = icon;
  return (
    <div role="status" className={`flex items-start gap-2 px-4 py-2 text-sm font-medium sm:px-6 ${tone}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{text}{cta}</p>
    </div>
  );
}
