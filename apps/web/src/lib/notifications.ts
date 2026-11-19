import type {
  ChannelKind,
  LowStockMode,
  NotificationChannel,
  NotificationEvent,
} from '@open-itsm/shared';
import type { Tone } from '@/components/ui/status-shape';

export const channelKindLabels: Record<ChannelKind, string> = { slack: 'Slack', teams: 'Teams' };

export const eventLabels: Record<NotificationEvent, string> = {
  ticket_created: 'New tickets',
  ticket_assigned: 'Tickets assigned',
  low_stock: 'Low stock',
};

export const lowStockModeLabels: Record<LowStockMode, string> = {
  first: 'When an item first runs low',
  every: 'Every time stock is used while low',
};

export type ChannelState = 'off' | 'failing' | 'working' | 'unused';

export function channelState(channel: NotificationChannel): ChannelState {
  if (!channel.enabled) return 'off';
  if (channel.lastError) return 'failing';
  return channel.lastSentAt ? 'working' : 'unused';
}

export const channelStateLabels: Record<ChannelState, string> = {
  off: 'Switched off',
  failing: 'Not working',
  working: 'Working',
  unused: 'Nothing sent yet',
};

export const channelStateTones: Record<ChannelState, Tone> = {
  off: 'neutral',
  failing: 'danger',
  working: 'success',
  unused: 'info',
};

/** What a channel is told about, in a sentence. */
export function describeEvents(channel: NotificationChannel): string {
  const events = channel.events;
  if (events.length === 0) return 'Not told about anything. Edit it to choose events.';
  const words = (['ticket_created', 'ticket_assigned', 'low_stock'] as const)
    .filter((e) => events.includes(e))
    .map((e) => {
      if (e === 'low_stock') {
        return channel.lowStockMode === 'first'
          ? 'low stock (when an item first runs low)'
          : 'low stock (every use while low)';
      }
      return e === 'ticket_created' ? 'new tickets' : 'tickets being assigned';
    });
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
  return `Told about ${list}.`;
}
