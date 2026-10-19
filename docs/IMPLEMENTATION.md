# ITSM v1 Alpha: Implementation Prompt for Claude Code

Oct 18, 2026 · @matrix

## Brief

Build the v1 alpha of a free, open-source (GPL v3, tentative), self-hosted ITSM for internal IT teams of 1 to 10 technicians. It covers two things: asset management and email-based support ticketing. The product overview defines scope; this document fixes the stack, the install method and the build order.

The alpha is done when a team can install it with one command, sign in with a local account, track assets with QR labels, turn Microsoft 365 email into tickets, and answer those tickets from a web dashboard. Anything outside the product overview's v1 scope is not built, even if it looks easy.

How to use this: put this document in the repo as `docs/IMPLEMENTATION.md`, start Claude Code at the repo root, and tell it to read the file and begin at milestone 0. Claude Code should work one milestone at a time and follow the working rules at the end.

## Stack and tooling

One language (TypeScript) end to end, one database, no Redis, and a single application image. Pin current stable versions at scaffold time.

| Layer | Choice | Why |
| --- | --- | --- |
| Language and runtime | TypeScript on the current Node.js LTS | One language across server and UI; shared types |
| Repo layout | pnpm workspaces monorepo: `apps/server`, `apps/web`, `packages/shared` | Shared zod schemas keep API and UI in sync |
| API server | Fastify with zod validation and generated OpenAPI docs | Fast, small, well typed; REST is easy for techs to script against |
| Database | PostgreSQL | Reliable, easy `pg_dump` backups, leaves room for a hosted SaaS later |
| ORM and migrations | Drizzle ORM with SQL migrations run at startup | Typed queries, plain SQL migrations a reviewer can read |
| Background jobs | pg-boss (queue stored in PostgreSQL) | Email polling, notifications and backups without adding Redis |
| Web UI | React, Vite, TanStack Router and Query, Tailwind CSS, shadcn/ui | Standard, well documented, fast to build a dashboard with |
| Local auth | argon2id password hashes, server-side sessions in PostgreSQL, secure cookies | No JWTs to revoke; simple to reason about |
| API tokens | Random opaque bearer tokens owned by service accounts, stored as SHA-256 hashes | Revocable at once, no JWTs; hashing is safe for high-entropy secrets and fast per request |
| Entra ID sign-in | OpenID Connect via `openid-client` | Optional layer on top of local accounts |
| Email | Microsoft Graph API, app-only access to one shared mailbox | Official API; avoids IMAP and basic-auth issues |
| QR codes | `qrcode` to generate labels; `qr-scanner` for camera scanning | Small libraries; USB scanners work as keyboard input, no code needed |
| Chat | Slack and Teams outbound notifications via webhooks | Smallest useful integration for alpha |
| Secrets at rest | AES-256-GCM using a key from the environment | Protects the Graph, Slack and Teams credentials in the database |
| Logging | pino, JSON to stdout | Works with `docker compose logs` |
| Tests | Vitest for unit and integration, Playwright for end-to-end smoke tests | Covers the acceptance criteria below |
| Quality | ESLint, Prettier, strict TypeScript | Keeps Claude Code's output consistent |
| CI and releases | GitHub Actions building a multi-arch image to GitHub Container Registry | Free for open source; users pull the image |
| Reverse proxy and TLS | Caddy container in the Compose file | Camera scanning needs HTTPS; Caddy makes that nearly automatic |

## Architecture

&#91;embedded content: architecture · 3 containers, 3 external services\]

Browsers reach the app only through Caddy. The app is the single place that talks to PostgreSQL, the Microsoft 365 mailbox, Entra ID and the chat webhooks, so the integrations can fail without taking the database or the proxy with them.

## Installation and upgrade

The install method is Docker Compose on a Linux host or VM. One Compose file starts three containers, and one script prepares the configuration. Windows teams can evaluate through Docker Desktop; a Linux VM is the supported production path for the alpha.

**Requirements:** Docker Engine with Compose v2, about 2 GB of RAM, ports 80 and 443 open, and a hostname for the server.

1. **Install.** Run `install.sh` (Linux) or `install.ps1` (Windows). It checks for Docker, creates the install folder, downloads `compose.yml` and `.env.example`, generates random values for the database password and the two secret keys, asks for the hostname, then runs `docker compose up -d`. A manual path (copy the two files, edit `.env`) must work too and be documented.
2. **Containers.** `app` (Fastify server plus the built web UI, one image), `db` (PostgreSQL) and `caddy` (TLS and reverse proxy). Named volumes: `pgdata`, `attachments`, `backups`, `caddy_data`.
3. **TLS.** A public hostname gets a Let's Encrypt certificate from Caddy automatically. An internal-only hostname uses Caddy's internal CA or a certificate placed in `./certs`. HTTPS is required because browsers only allow camera scanning on secure pages.
4. **First run.** Opening the URL shows a setup wizard that creates the local administrator. The wizard works only while no users exist and requires a one-time setup token printed in the app container's log, so a stranger who finds a fresh install cannot claim it.
5. **Upgrade.** `docker compose pull && docker compose up -d`. Image tags are versioned and pinned in `.env`. On start the app takes an automatic backup, runs migrations, and refuses to start (leaving data untouched) if a migration fails.
6. **Backup and restore.** A nightly job writes a `pg_dump` and an archive of the attachments volume to `backups/`, keeping 14 days by default. The admin UI has a Backup now button. `scripts/restore.sh <file>` restores a backup. The docs tell operators to copy `backups/` off the host.
7. **Admin recovery.** A host-level CLI, run with `docker compose exec app`, resets any local account's password and can switch off Entra ID sign-in. Shell access to the host is the trust boundary. This answers the open recovery question and is a proposal to confirm.

## Data model

Start from these tables and refine them as needed; keep the rules in the right column enforced in the database, not only in code.

| Table | Holds | Rules |
| --- | --- | --- |
| `users` | Technicians, admins and optional end users: email, role, password hash, Entra ID subject | Email unique; role is admin, technician or end user |
| `sessions` | Server-side sessions | Expire and can be revoked |
| `service_accounts` | Named non-human identities for scripts: name, description, created by, disabled flag | Name unique; no password or Entra ID subject, so they can never sign in to the web UI |
| `api_tokens` | Service account, public token ID, SHA-256 hash of the secret, scopes, expiry, created by, last used time, revoked time | Hash unique; expiry required and at most one year after creation; scopes limited to `assets:read`, `assets:write`, `tickets:read`, `tickets:write` |
| `settings` | Key-value configuration, with credentials stored encrypted | Secrets never returned by the API |
| `asset_types` | Name, number prefix, next sequence value | Name unique |
| `asset_type_fields` | Custom field definitions per type: label, kind (text, number, date, select, yes/no), options, required | Field keys unique within a type |
| `assets` | Asset number, type, status, assignee or location, custom field values (JSONB) | Asset number unique across all types; status is one of preparing, in stock, deployed, in repair, retired |
| `asset_assignments` | Assignment history: asset, who or where, start, end | Append only; one open assignment per asset |
| `repairs` | Asset, opened and closed dates, notes | Opening a repair sets the asset to in repair |
| `consumables` | Name, quantity, low-stock threshold | Quantity never below zero |
| `consumable_adjustments` | Quantity changes with reason and user; optional repair link | Append only |
| `tickets` | Number, subject, status, assignee, requester, source | Ticket number unique and human readable |
| `ticket_messages` | Inbound and outbound messages, Graph message ID, attachments | Graph message ID unique, which prevents duplicate tickets |
| `ticket_events` | Status and assignee changes | Append only |
| `audit_log` | Sign-ins, failed sign-ins and token attempts, setting changes, service account and token changes, backups | Append only |

Asset numbers are generated from the type's prefix and sequence (for example `LAP-000123`) and can be overridden by hand. The unique constraint is the source of truth, and CSV import rejects any row that would duplicate a number, reporting every conflict at once.

Every column that records who made a change (assignment history, repairs, consumable adjustments, ticket messages and events, the audit log) accepts either a user or a service account, so changes made by a script are attributed to the named service account.

## Build plan

Build in this order. Each milestone ends with passing tests and a commit before the next begins.

| # | Build | Done when |
| --- | --- | --- |
| M0 | Monorepo scaffold, app image, `compose.yml`, `/healthz`, CI pipeline, `LICENSE`, a `CLAUDE.md` with the working rules | `docker compose up` gives a healthy app behind Caddy; CI is green |
| M1 | Migrations, first-run setup wizard with one-time token, local login, roles, sessions, admin recovery CLI | A fresh install goes wizard, then login; a second wizard visit is refused; the CLI resets a password |
| M2 | Asset types with custom fields, asset CRUD, unique asset numbers, search and filters, CSV import; service accounts and API tokens with the `assets:read` and `assets:write` scopes, admin pages to manage them, and the API reference (see API security) | A duplicate number is rejected in the UI, the API and the import, with every conflict reported; a token with only `assets:read` can list assets but is refused when it creates one; an expired, revoked or disabled-account token is refused; no token value appears in logs |
| M3 | Statuses, assignment history, repair log | Opening a repair moves the asset to in repair; history shows every assignment |
| M4 | Printable QR label page, scan page using the camera, keyboard-input scan field for USB scanners | Scanning a label opens that asset; a scanner typing into the field does the same |
| M5 | Consumables with quantities, low-stock threshold and indicator, optional repair link | Stock cannot go below zero; low-stock items are flagged on the dashboard |
| M6 | Ticket model and technician dashboard: list, filters, detail, reply composer, assignee, status, history; the `tickets:read` and `tickets:write` token scopes | A technician can open, reply to, assign and close a ticket created from a test fixture; a token with `tickets:write` can do the same and its changes are attributed to its service account; a token with only asset scopes is refused on every ticket endpoint |
| M7 | Microsoft 365 email: settings page, test connection, polling, tickets from email, threading, outbound replies, attachments | An email to the shared mailbox creates a ticket; a reply from the user lands on the same ticket; a tech reply arrives as email |
| M8 | Slack and Teams outbound notifications, off by default, configured per team | A new ticket posts to a configured channel; with nothing configured, nothing is sent |
| M9 | Optional Entra ID sign-in with technician access from an Entra ID group | With SSO on, group members sign in; local accounts still work, including when SSO is misconfigured |
| M10 | Optional end-user dashboard showing a requester's own open tickets | An end user sees only their own tickets; the feature is off by default |
| M11 | Backup and restore, install scripts, operator documentation, end-to-end smoke tests, release workflow | A clean VM goes from zero to a working install with one script; a backup restores into a fresh install |

## API security

The REST API is internal. It serves the technician dashboard, the optional end-user dashboard and administrators' scripts. It is not a public or third-party API, and its endpoints are not a stable contract in v1. Browser sessions and roles arrive in M1; API tokens arrive in M2 with the asset scopes and gain the ticket scopes in M6.

**Every request is authenticated.** Routes are deny-by-default: a route is public only if it is on an explicit allowlist (`/healthz`, sign-in, the first-run wizard while no users exist, and the end-user one-time link). Every other route declares the roles or scopes it accepts, and a test fails if a route declares neither. A request carries either a session cookie or a bearer token, never both; a request with both is refused.

**Browser sessions (M1).** As described under Security and operations: argon2id passwords, server-side sessions, HttpOnly, Secure and SameSite cookies, CSRF protection on state-changing requests, and login rate limiting. Sessions have an idle timeout and an absolute timeout, and are revoked on sign-out, password change and account disable. The API sends no CORS headers, so other origins cannot call it from a browser.

**Service accounts and API tokens (M2).**

| Rule | Requirement |
| --- | --- |
| Ownership | Every token belongs to a named service account (for example "Intune sync" or "Inventory import"), not to a person, so scripts keep working when staff change. Service accounts cannot sign in to the web UI |
| Who manages them | Only administrators create, disable and delete service accounts, and create and revoke tokens. The audit log records which administrator did it |
| Scopes | Each token has one or more of four scopes. `assets:read` and `assets:write` cover asset types, assets, assignments, repairs, consumables and CSV import. `tickets:read` and `tickets:write` cover tickets, replies, status and assignee. `write` does not imply `read`; a token needs both to read and change |
| Never reachable by token | Settings, connector credentials, users, service accounts, tokens, backups, the audit log and admin recovery. These stay with signed-in administrators |
| Format | `oitsm_<token id>_<secret>`, with at least 256 bits of random secret. The prefix lets secret scanners find leaked tokens; the ID finds the row without scanning hashes |
| Storage | Only a SHA-256 hash of the secret is stored, compared in constant time. The full token is shown once at creation and cannot be retrieved later |
| Expiry | Required. Default 90 days, maximum one year. The admin page flags tokens expiring within 14 days |
| Use | Sent only in the `Authorization: Bearer` header; a token in a query string or form body is refused and logged as a failed attempt. Token requests skip the CSRF check because they carry no cookie |
| Revocation | Revoking a token or disabling its service account takes effect on the next request. Disabled service accounts keep their history so audit records stay readable |
| Rate limits | A per-token request limit, and a per-IP backoff after repeated invalid tokens |
| Visibility | The admin page lists each service account with its tokens, scopes, expiry, creator and last-used time, but never the token value |
| Attribution | Changes made with a token name the service account as the actor in asset, ticket and consumable history |

**API reference.** Fastify's generated OpenAPI document and its viewer are served only to signed-in administrators and technicians. The operator documentation includes short PowerShell (`Invoke-RestMethod`) and curl examples that read an asset by number and update a ticket's status.

**Audit and logging.** The audit log records sign-ins, failed sign-ins, failed token attempts, service account and token creation, disablement and revocation, and every state-changing request made with a token. Logs never contain passwords, session IDs, CSRF tokens or token secrets; redact the `Authorization` header and `Cookie` header in pino.

## Integrations

**Microsoft 365 email (M7).** The operator registers an app in Entra ID with application permissions to read and send mail, then limits it to one shared mailbox using Exchange Online scoping so the app cannot read every mailbox in the tenant. Check Microsoft's current documentation for the scoping method, since it has changed over time. The settings page takes the tenant ID, client ID, client secret and mailbox address, and has a Test connection button.

- Poll the inbox with Graph delta queries about once a minute. Webhooks need a public address, which many self-hosted installs lack, so leave them for later.
- Put a ticket reference such as `[#1042]` in every outbound subject. Match inbound mail by that reference first, then by the reply headers and Graph conversation ID, and only then open a new ticket.
- Skip mail sent by the mailbox itself and automatic replies, so two mailboxes cannot loop. Store each Graph message ID and ignore repeats.
- Warn on the settings page before the client secret expires, because an expired secret silently stops ticket intake.

**Entra ID sign-in (M9).** Authorization code flow with PKCE through OpenID Connect. The operator supplies tenant ID, client ID, secret and the object ID of the technician group. Members of that group sign in as technicians. If a user belongs to too many groups for the token to list them, fall back to a Graph membership check. Local accounts are never disabled by turning SSO on, and a failed SSO setup must leave local login working.

**Teams and Slack (M8).** Outbound notifications only for the alpha: new ticket, ticket assigned and low stock. Slack uses an incoming webhook URL. Teams uses a workflow webhook URL; Microsoft has been moving Teams away from the older connector webhooks, so confirm the current method before building. Messages carry the subject and a link, never the ticket body. Two-way chat is out of scope.

**End-user dashboard (M10).** Requesters sign in with Entra ID when it is enabled, or with an emailed one-time link sent through the Microsoft 365 mailbox. The end-user requester can respond to their open tickets from this dashboard.

## Security and operations

- Passwords hashed with argon2id; login rate limiting and temporary lockout after repeated failures; session cookies are HttpOnly, Secure and SameSite.
- CSRF protection on every state-changing request made with a session cookie; zod validation on every API input.
- API access follows the API security section: deny-by-default routes, scoped and expiring service account tokens stored only as hashes, and no token access to administration.
- Stored credentials (Graph secret, Slack and Teams URLs, Entra secret) are encrypted with AES-256-GCM using `APP_SECRET_KEY` and are never returned by the API or written to logs.
- Inbound email is untrusted: sanitize HTML before display, never fetch remote images automatically, cap attachment size and type, and store attachments on the volume rather than in the database.
- Roles: admin, technician, end user. End users can reach only their own tickets, enforced in the query, not only in the UI.
- An append-only audit log covers sign-ins, settings changes, integration changes, service account and token changes, token use that changes data, and backups.
- The app runs as a non-root user in its container, exposes only the Caddy ports, and keeps PostgreSQL off the host network.
- `/healthz` reports app, database and queue status; logs are structured JSON.
- Dependencies are pinned by lockfile; CI runs an audit step and the test suite on every pull request.

## Alpha definition of done and working rules

**The alpha is done when:**

- A clean Linux VM goes from nothing to a signed-in administrator in under 15 minutes using only the install script and the docs.
- All M0 to M11 acceptance criteria pass in the end-to-end smoke tests.
- A backup taken on one install restores onto a fresh one.
- Disabling or misconfiguring Entra ID sign-in never blocks local login.
- Every API route is either on the public allowlist or declares the roles and scopes it accepts.

**Working rules for Claude Code:**

1. Read the product overview and this document first. Build only what they describe; list any proposed extra feature in `docs/IDEAS.md` instead of building it.
2. Work one milestone at a time. Before moving on, run lint, type checks and tests, then commit with a clear message.
3. Write tests alongside the code, starting with the acceptance criterion for the milestone.
4. Keep `CLAUDE.md` current with commands, conventions and decisions, so a new session can resume cold.
5. Never commit secrets. Use `.env.example` with placeholder values.
6. Prefer boring, well-known libraries. Before adding a new dependency, say why the existing ones will not do.
7. When a requirement is ambiguous or an external API behaves differently from this document, stop and ask rather than guess. Check current Microsoft, Slack and library documentation instead of relying on memory.
8. Add a GPL v3 `LICENSE` file at M0. Do not add license headers or change the license without being told.

## Assumptions to confirm

These choices go beyond what the product overview states. Change any you disagree with before handing this to Claude Code.

- [x] Production hosting is a Linux VM with Docker; Windows is for evaluation through Docker Desktop only. **Confirmed by user**
- [x] PostgreSQL rather than SQLite, accepting one extra container in exchange for a cleaner path to hosted SaaS. **Confirmed by user**
- [x] Chat integrations are outbound notifications only in the alpha. **Confirmed by user**
- [x] Admins are local accounts; Entra ID group members are technicians. **Confirmed by user**
- [x] Admin recovery is a host-level CLI command. **Confirmed by user**
- [x] End users sign in through Entra ID or an emailed one-time link. **Confirmed by user**
- [x] Ticket numbers are plain sequences shown as `[#1042]` in email subjects. **Confirmed by user**
- [x] The API is internal only; administrators issue tokens for scripting. **Confirmed by user**
- [x] API tokens belong to named service accounts that outlive staff changes, not to people. **Confirmed by user**
- [x] Four token scopes: `assets:read`, `assets:write`, `tickets:read`, `tickets:write`. **Confirmed by user**
- [x] Token expiry defaults to 90 days with a one-year maximum, and there are no non-expiring tokens. **Confirmed by user**
- [x] Token infrastructure ships in M2 with the asset scopes; the ticket scopes follow in M6 when tickets exist. **Confirmed by user**
- [x] Asset type and custom field definitions are covered by the asset scopes rather than kept for signed-in users. **Confirmed by user**
