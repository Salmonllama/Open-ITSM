import type { TicketEvent } from '@open-itsm/shared';
import { describe, expect, it } from 'vitest';
import { describeTicketEvent, formatActivity, requesterLabel, ticketRef } from './tickets';

const base: TicketEvent = {
  id: 1,
  kind: 'created',
  fromStatus: null,
  toStatus: 'new',
  fromAssignee: null,
  toAssignee: null,
  asset: null,
  at: '2026-10-16T09:12:00Z',
  by: { kind: 'user', name: 'J. Rivera' },
};

describe('describeTicketEvent', () => {
  it('names status changes with both words', () => {
    expect(
      describeTicketEvent({ ...base, kind: 'status', fromStatus: 'new', toStatus: 'in_progress' }),
    ).toBe('Status: New → In progress');
  });

  it('names who a ticket was assigned to or taken from', () => {
    const rivera = { id: '6f1c1a62-6a43-4bb0-9a3a-0d1f7b6c4b11', name: 'J. Rivera' };
    expect(describeTicketEvent({ ...base, kind: 'assignee', toAssignee: rivera })).toBe(
      'Assigned to J. Rivera',
    );
    expect(describeTicketEvent({ ...base, kind: 'assignee', fromAssignee: rivera })).toBe(
      'Unassigned from J. Rivera',
    );
  });

  it('names linked assets by number, even once deleted', () => {
    expect(
      describeTicketEvent({ ...base, kind: 'asset_unlinked', asset: { id: null, number: 'LT-7' } }),
    ).toBe('Unlinked LT-7');
  });
});

describe('formatting', () => {
  it('shows a hash before numbers and falls back to the email', () => {
    expect(ticketRef(42)).toBe('#42');
    expect(requesterLabel({ name: '', email: 'sam@example.com' })).toBe('sam@example.com');
    expect(requesterLabel({ name: 'Sam', email: 'sam@example.com' })).toBe('Sam');
  });

  it('shows the time for today and the date otherwise', () => {
    const now = new Date(2026, 9, 21, 15, 0);
    expect(formatActivity(new Date(2026, 9, 21, 9, 5).toISOString(), now)).toMatch(/9:05/);
    expect(formatActivity(new Date(2026, 9, 16, 9, 5).toISOString(), now)).toMatch(/16/);
    expect(formatActivity(new Date(2025, 9, 16, 9, 5).toISOString(), now)).toMatch(/2025/);
  });
});
