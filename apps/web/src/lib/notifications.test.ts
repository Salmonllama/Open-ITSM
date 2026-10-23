import type { NotificationChannel } from '@open-itsm/shared';
import { describe, expect, it } from 'vitest';
import { channelState, describeEvents } from './notifications';

const base: NotificationChannel = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'IT team',
  kind: 'slack',
  webhookHint: 'hooks.slack.com …abcd',
  events: ['ticket_created'],
  lowStockMode: 'first',
  enabled: true,
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
};

describe('channelState', () => {
  it('reads off, failing, working and unused', () => {
    expect(channelState({ ...base, enabled: false, lastError: 'x' })).toBe('off');
    expect(channelState({ ...base, lastError: 'Slack refused the message.' })).toBe('failing');
    expect(channelState({ ...base, lastSentAt: '2026-10-23T10:00:00Z' })).toBe('working');
    expect(channelState(base)).toBe('unused');
  });
});

describe('describeEvents', () => {
  it('lists the events in a sentence', () => {
    expect(describeEvents(base)).toBe('Told about new tickets.');
    expect(
      describeEvents({
        ...base,
        events: ['low_stock', 'ticket_created', 'ticket_assigned'],
        lowStockMode: 'every',
      }),
    ).toBe('Told about new tickets, tickets being assigned and low stock (every use while low).');
    expect(describeEvents({ ...base, events: [] })).toMatch(/Not told about anything/);
  });
});
