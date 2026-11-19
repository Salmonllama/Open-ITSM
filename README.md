# Open ITSM

A free, open-source, self-hosted ITSM for internal IT teams of 1 to 10 technicians: asset
management with QR labels and email-based support ticketing through Microsoft 365.

**Status:** pre-alpha, under active development. See `docs/IMPLEMENTATION.md` for the plan.

## Try it

Requires Docker Engine with Compose v2.

```sh
cp .env.example .env    # then replace every change-me value
docker compose -f compose.yml -f compose.build.yml up -d --build
curl -k https://localhost/healthz
```

Set `APP_HOSTNAME=localhost` in `.env` for a local trial. Open the site and enter the setup
token from `docker compose logs app` to create the first administrator. If an admin password is
lost, `docker compose exec app itsm reset-password <email>` sets a new one. Published images and an install
script arrive with the alpha release.

## What works so far

- Asset types with custom fields, assets with unique numbers, search, filters and CSV import.
- Assignment to a person or location, repairs and a full activity history for each asset.
- QR asset tags for label printers and Avery sheets, and a scan page for phones and USB scanners.
- Consumables such as toner and cables: add stock, use it (optionally for an open repair) or
  record a count. Stock never goes below zero. An item is low at or below its threshold (0 never
  flags it), and low items show above the asset list and beside Consumables in the sidebar.
- Tickets, numbered from #1: a list with queues (All open, Unassigned, Mine, Waiting on user,
  Closed), search and filters, and a ticket page with the conversation, replies and internal
  notes, status, assignee, linked assets, the requester and a history of every change. An
  unread dot marks tickets the requester wrote on since you last opened them. Technicians can
  also open tickets with New ticket.
- Email through one Microsoft 365 shared mailbox (Email, for administrators): email to it opens a
  ticket, replies are emailed with `[#N]` in the subject, and the requester's answers land on
  the same ticket. Files travel both ways and are kept on the attachments volume. The page
  walks through the app registration and the Exchange commands that limit the app to that one
  mailbox, tests the connection, and warns 30 days before the client secret expires.
- Slack and Teams notifications (Notifications, for administrators), off until a channel is
  added: new tickets, assignments and low stock, chosen per channel, with the subject and an
  Open button, never what was written. Low stock posts when an item first runs low or on every
  use while low, as each channel chooses. Teams uses a Workflows webhook from the "Send webhook
  alerts to a channel" template; links point to `https://APP_HOSTNAME`.
  **Slack is untested:** it is built to Slack's incoming webhook docs and covered by automated
  tests, but nobody has tried it against a real Slack workspace yet. If you can, add a channel,
  press Send test message and open an issue with what happened. Contributors and testers are
  welcome.
- Service accounts with scoped API tokens for scripts; see `docs/api.md`.

## Development

See `CLAUDE.md` for commands, layout and conventions.

## License

GPL v3. See `LICENSE`.
