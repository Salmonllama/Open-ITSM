# Open ITSM

A free, open-source, self-hosted ITSM for internal IT teams of 1 to 10 technicians: asset
management with QR labels and email-based support ticketing through Microsoft 365.

## Quick install

Requires a Linux host or VM with Docker Engine and Compose v2, about 2 GB RAM, and ports 80 and 443.

```sh
curl -fsSL https://raw.githubusercontent.com/Salmonllama/Open-ITSM/main/scripts/install.sh | bash
```

For manual installation, Windows evaluation (`scripts/install.ps1`), custom TLS certificates,
upgrades, backups, restore and admin recovery, see **[`docs/OPERATIONS.md`](docs/OPERATIONS.md)**.

To try from a source checkout on `https://localhost`:

```sh
cp .env.example .env    # then replace every change-me value and set APP_HOSTNAME=localhost
docker compose -f compose.yml -f compose.build.yml up -d --build
curl -k https://localhost/healthz
```

Open the site and enter the one-time setup token printed by `docker compose logs app` to create the
first local administrator.

## Features (v1)

- **Asset management:** custom asset types with custom fields, unique asset numbers, search,
  filters and all-or-nothing CSV import with full conflict reporting.
- **Lifecycle and history:** deployment assignment history, repair log (opening a repair moves the
  asset to In repair; closing restores its previous status), and full append-only activity feed.
- **QR labels and scanning:** printable QR asset tags for label printers and Avery sheets (5160 /
  L7160), plus a `/scan` page supporting device cameras and USB keyboard-mode scanners for lookup,
  check-out and check-in.
- **Consumables:** quantity tracking with add/use/count adjustments, optional repair links, a
  non-negative stock floor enforced in PostgreSQL, and low-stock indicators.
- **Ticketing:** tickets numbered from `#1`, queues (`All open`, `Unassigned`, `Mine`,
  `Waiting on user`, `Closed`), replies, internal notes, unread dots, linked assets and full event
  history.
- **Microsoft 365 shared mailbox (`/admin/email`):** app-only Microsoft Graph intake scoped to one
  shared mailbox, automatic threading (`[#N]`, reply headers, conversation ID), outbound email
  replies, attachments stored on disk, and 30-day secret expiry warnings.
- **Slack and Microsoft Teams notifications (`/admin/notifications`):** optional per-channel
  outbound alerts for new tickets, assignments and low stock (subject and link only, never message
  bodies).
  _Note: Slack webhooks are covered by automated tests against a stand-in, but have not yet been
  verified against a live Slack workspace. Feedback from Slack testers is welcome._
- **Optional Microsoft Entra ID SSO (`/admin/sso`):** OpenID Connect with PKCE and technician group
  access (with Microsoft Graph group-overage fallback). Local accounts always remain available, and
  `docker compose exec app itsm disable-sso` can switch SSO off from the host at any time.
- **Optional end-user portal (`/admin/portal`):** off by default. Lets requesters sign in via Entra
  ID or an emailed 15-minute one-time link to view and reply to their own open tickets on desktop or
  phone, strictly isolated in SQL with internal notes excluded.
- **Backups and restore (`/admin/backups`):** automatic pre-migration backup on upgrade, nightly
  scheduled backups (`pg_dump` + attachments, 14-day retention), manual **Backup now** and archive
  downloads, plus `scripts/restore.sh`.
- **Internal scripting API (`docs/api.md`):** named service accounts with scoped, expiring bearer
  tokens (`assets:read`, `assets:write`, `tickets:read`, `tickets:write`) and OpenAPI reference at
  `/api/docs` for signed-in staff.

## Documentation

- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — install, TLS, upgrades, backups, restore, recovery
- [`docs/api.md`](docs/api.md) — service accounts, API tokens, PowerShell and curl examples
- [`docs/PRODUCT_OVERVIEW.md`](docs/PRODUCT_OVERVIEW.md) — v1 product scope
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — architecture, data model and build plan
- [`CLAUDE.md`](CLAUDE.md) — development commands, layout and engineering decisions

## License

GPL v3. See [`LICENSE`](LICENSE).
