import type { TicketEvent, TicketSource, TicketStatus } from '@open-itsm/shared';
import type { Tone } from '@/components/ui/status-shape';

/** Ticket status words and tones from the design system. */
export const ticketStatusLabels: Record<TicketStatus, string> = {
  new: 'New',
  in_progress: 'In progress',
  waiting_on_user: 'Waiting on user',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const ticketStatusTones: Record<TicketStatus, Tone> = {
  new: 'info',
  in_progress: 'progress',
  waiting_on_user: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

/** How a ticket arrived, as in "#12 · by email". */
export const ticketSourceLabels: Record<TicketSource, string> = {
  email: 'by email',
  dashboard: 'by a technician',
  api: 'by API',
};

export const ticketSourceNames: Record<TicketSource, string> = {
  email: 'Email',
  dashboard: 'Technician',
  api: 'API',
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const longDayFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

/** `Oct 16, 9:12 AM`, with the year added when it is not this year. */
export function formatDateTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const day = date.getFullYear() === now.getFullYear() ? dayFormat : longDayFormat;
  return `${day.format(date)}, ${timeFormat.format(date)}`;
}

/** For list rows: the time today, otherwise the date. */
export function formatActivity(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (sameDay(date, now)) return timeFormat.format(date);
  return (date.getFullYear() === now.getFullYear() ? dayFormat : longDayFormat).format(date);
}

/** `#12`: ticket numbers are always shown with a hash. */
export function ticketRef(number: number): string {
  return `#${number}`;
}

/** A requester as people read them: the name, or the email when no name is known. */
export function requesterLabel(requester: { name: string; email: string }): string {
  return requester.name || requester.email;
}

/** One line of a ticket's history. */
export function describeTicketEvent(e: TicketEvent): string {
  switch (e.kind) {
    case 'created':
      return 'Ticket opened';
    case 'status':
      return `Status: ${e.fromStatus ? `${ticketStatusLabels[e.fromStatus]} → ` : ''}${e.toStatus ? ticketStatusLabels[e.toStatus] : ''}`;
    case 'assignee':
      return e.toAssignee
        ? `Assigned to ${e.toAssignee.name}`
        : `Unassigned from ${e.fromAssignee?.name ?? 'nobody'}`;
    case 'asset_linked':
      return `Linked ${e.asset?.number ?? 'an asset'}`;
    case 'asset_unlinked':
      return `Unlinked ${e.asset?.number ?? 'an asset'}`;
  }
}
