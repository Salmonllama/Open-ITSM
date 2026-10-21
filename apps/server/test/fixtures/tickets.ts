/** Tickets as a requester would raise them, for tests until email intake arrives in M7. */
export const ticketFixtures = {
  printer: {
    subject: 'Printer on floor 2 jams on every job',
    requester: { name: 'Dana Whitfield', email: 'Dana.Whitfield@example.com' },
    message: 'Since this morning the printer by the kitchen jams on every page. Can someone look?',
  },
  vpn: {
    subject: 'VPN drops every few minutes',
    requester: { name: 'Sam Okafor', email: 'sam.okafor@example.com' },
    message: 'Working from home today and the VPN keeps disconnecting.',
  },
  laptop: {
    subject: 'New starter needs a laptop on Monday',
    requester: { name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
    message: 'Priya starts on Monday in Finance and will need a laptop and an account.',
  },
} as const;
