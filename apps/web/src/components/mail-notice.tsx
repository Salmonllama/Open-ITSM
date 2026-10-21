import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  describeMailStatus,
  mailNeedsAttention,
  mailStateLabels,
  mailStateTones,
} from '@/lib/mail';
import { mailStatusQuery, sessionQuery } from '@/lib/queries';
import { StatusBadge } from './ui/status-badge';

/** The notice above the ticket list while the mailbox is failing or its secret is expiring. */
export function MailNotice() {
  const status = useQuery(mailStatusQuery);
  const session = useQuery(sessionQuery);
  if (!status.data || !mailNeedsAttention(status.data)) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-raised px-4 py-3"
    >
      <StatusBadge tone={mailStateTones[status.data.state]}>
        {mailStateLabels[status.data.state]}
      </StatusBadge>
      <span className="flex-[1_1_280px]">{describeMailStatus(status.data)}</span>
      {session.data?.user.role === 'admin' ? (
        <Link to="/admin/email" className="type-label">
          Open email settings
        </Link>
      ) : (
        <span className="type-caption text-ink-muted">An administrator can fix this.</span>
      )}
    </div>
  );
}
