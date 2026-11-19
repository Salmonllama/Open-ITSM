# Operating Open ITSM

This guide covers installing, securing, upgrading, backing up, restoring and recovering a
self-hosted Open ITSM v1 server.

## Requirements

- **Production host:** Linux server or VM (amd64 or arm64) with Docker Engine and Docker Compose v2
  (`docker compose`).
- **Windows evaluation:** Docker Desktop on Windows (supported for evaluation only; run production
  on Linux).
- **Resources:** about 2 GB RAM, disk space for PostgreSQL, attachments and 14 days of backups.
- **Network:** ports 80 and 443 reachable from browsers (HTTPS is required for camera QR code
  scanning), and a DNS hostname for the server.

PostgreSQL runs on an internal Docker network (`backend`) with no host port and no internet route.
Browsers reach Open ITSM only through the Caddy reverse proxy.

## Quick install (one command)

### Linux

```sh
curl -fsSL https://raw.githubusercontent.com/Salmonllama/Open-ITSM/main/scripts/install.sh | bash
```

Or download, inspect and run it with options:

```sh
curl -fsSL https://raw.githubusercontent.com/Salmonllama/Open-ITSM/main/scripts/install.sh -o install.sh
chmod +x install.sh
./install.sh --dir /opt/open-itsm --hostname itsm.example.com
```

Pass `--internal` if the hostname is internal-only and not reachable from the internet for Let's
Encrypt.

The script checks Docker Compose v2, creates the install folder, downloads `compose.yml`,
`.env.example` and `scripts/restore.sh`, generates random values for `POSTGRES_PASSWORD`,
`APP_SECRET_KEY` and `SESSION_SECRET`, starts the stack with `docker compose up -d`, and prints
the one-time setup token.

### Windows (evaluation with Docker Desktop)

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri https://raw.githubusercontent.com/Salmonllama/Open-ITSM/main/scripts/install.ps1 `
  -OutFile install.ps1
.\install.ps1
```

## Manual install

Every install needs only two files: `compose.yml` and `.env`.

```sh
mkdir -p /opt/open-itsm/certs
cd /opt/open-itsm
curl -fsSLO https://raw.githubusercontent.com/Salmonllama/Open-ITSM/main/compose.yml
curl -fsSLO https://raw.githubusercontent.com/Salmonllama/Open-ITSM/main/.env.example
cp .env.example .env
chmod 600 .env
```

Edit `.env` and fill in:

- `OPEN_ITSM_VERSION` — pin a released version tag (for example `1.0.0`).
- `APP_HOSTNAME` — hostname only, with no `https://` or port (for example `itsm.example.com`).
- `POSTGRES_PASSWORD` — output of `openssl rand -hex 24`.
- `APP_SECRET_KEY` — output of `openssl rand -base64 32`.
- `SESSION_SECRET` — output of `openssl rand -base64 48`.

Start the stack:

```sh
docker compose up -d
```

> **Keep a separate copy of `APP_SECRET_KEY`.** Stored Microsoft 365, Entra ID, Slack and Teams
> credentials are encrypted with AES-256-GCM under this key. Without it, a restored database cannot
> decrypt those credentials and they will have to be re-entered.

## TLS certificates

Camera QR scanning only works over HTTPS, so Caddy serves HTTPS by default.

1. **Public hostname (Let's Encrypt, default):** leave `CADDY_GLOBAL_OPTIONS` and `CADDY_TLS` empty
   and ensure ports 80 and 443 are reachable from the internet. Caddy obtains and renews a
   certificate automatically.
2. **Internal-only hostname (Caddy internal CA):** set `CADDY_GLOBAL_OPTIONS=local_certs` in
   `.env`. Distribute Caddy's root certificate from the `caddy_data` volume to technician devices if
   you want to avoid browser warnings.
3. **Your own internal certificate:** place `cert.pem` and `key.pem` in `./certs/` next to
   `compose.yml`, set `CADDY_TLS=tls /certs/cert.pem /certs/key.pem` in `.env`, and run
   `docker compose up -d`.

## First-run setup

1. Read the one-time setup token from the app container log:
   ```sh
   docker compose logs app
   ```
2. Open `https://<APP_HOSTNAME>` in your browser.
3. Enter the setup token, your name, email address and password (at least 12 characters) to create
   the first local administrator account.

The setup wizard works only while no users exist. After the first administrator is created, the
wizard is permanently closed.

## Upgrading

1. Change `OPEN_ITSM_VERSION` in `.env` to the new release tag.
2. Pull the new image and restart:
   ```sh
   docker compose pull && docker compose up -d
   ```

When new database migrations are waiting, Open ITSM automatically creates a `pre_migration` backup
in the `backups` volume before running them. Migrations run inside a single PostgreSQL transaction:
if a migration fails, the transaction rolls back and the app refuses to start, leaving your data
untouched.

## Backups and restore

### Automatic and manual backups

- A nightly job runs at **02:00 UTC**, writes a `.tar.gz` archive containing a `pg_dump` custom
  database dump (`database.dump`), a `manifest.json` and the `attachments` volume to
  `/data/backups`, and prunes archives older than `BACKUP_RETENTION_DAYS` (14 days by default,
  always keeping at least the newest backup).
- Administrators can also open **Backups** (`/admin/backups`) in the web UI to press **Backup now**
  or download any archive.

### Copy backups off the host

Backups stored only on the same server do not survive a disk or VM loss. Copy the `backups` Docker
volume off the host regularly (for example via a host cron job or backup agent) and keep a separate
copy of `APP_SECRET_KEY` in your password manager.

To copy the latest backup off the host using Docker:

```sh
docker compose exec -T app sh -c 'ls -1t /data/backups/*.tar.gz | head -n 1'
```

### Restoring a backup

From the install folder containing `compose.yml` and `.env`:

```sh
./scripts/restore.sh /path/to/open-itsm-YYYYMMDDTHHMMSSZ-scheduled.tar.gz
```

`restore.sh` validates the archive, stops the `app` container, recreates the `itsm` database,
restores `database.dump` with `pg_restore`, replaces `/data/attachments` from the archive, and
starts `app` again. Pass `--yes` to skip the interactive confirmation prompt.

When restoring onto a **brand-new server**:

1. Install Open ITSM (`install.sh --no-start` or manual setup) and set the **original**
   `APP_SECRET_KEY` in `.env`.
2. Start the database (`docker compose up -d --wait db`).
3. Run `./scripts/restore.sh /path/to/backup.tar.gz`.

## Admin recovery CLI

If an administrator forgets their password or misconfigures Entra ID single sign-on, recover from
the server host. Shell access to the host is the trust boundary.

```sh
# List every account, its role and whether it is active, locked or disabled
docker compose exec app itsm list-users

# Reset a local account's password (prints a new random password once, clears lockout,
# revokes all sessions; add --enable to re-enable a disabled account)
docker compose exec app itsm reset-password admin@example.com
docker compose exec app itsm reset-password admin@example.com --enable

# Switch off Microsoft Entra ID sign-in without deleting its saved settings
docker compose exec app itsm disable-sso
```

## Integrations

All integrations are configured by a signed-in administrator in the web UI (never reachable via API
tokens) and stored with credentials encrypted under `APP_SECRET_KEY`:

- **Microsoft 365 email (`/admin/email`):** app-only Graph access scoped to one shared mailbox via
  Exchange Online RBAC for Applications. Polls every minute, threads by `[#N]`, reply headers and
  conversation ID, and warns 30 days before the client secret expires.
- **Slack and Teams (`/admin/notifications`):** outbound webhook notifications per channel for new
  tickets, assignments and low stock. Messages include subject and a link to
  `https://<APP_HOSTNAME>`, never the ticket body.
- **Microsoft Entra ID SSO (`/admin/sso`):** optional OIDC authorization code + PKCE sign-in.
  Members of the configured technician group sign in as technicians; falls back to Microsoft Graph
  `checkMemberGroups` on group overage. Local accounts always remain available.
- **End-user portal (`/admin/portal`):** off by default. Lets requesters view and reply to their own
  open tickets via Entra ID or an emailed 15-minute one-time link.
- **Scripting API (`docs/api.md`):** create named service accounts and scoped, expiring API tokens
  under **Service accounts** (`/admin/service-accounts`).
