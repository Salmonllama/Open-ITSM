# CLAUDE.md

Open ITSM is a free, self-hosted ITSM (asset management and email ticketing) for IT teams of 1 to
10 technicians. Read these before starting work: `docs/PRODUCT_OVERVIEW.md` defines v1 scope (and
what is out of scope); `docs/IMPLEMENTATION.md` fixes the stack, data model, build order and
acceptance criteria; `docs/open-itsm-brand.md` links the design system (tokens, components,
voice, logo) and the page mockups that every screen must follow.

## Status

| Milestone                                                               | State                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| M0 Scaffold, image, compose, `/healthz`, CI, LICENSE, CLAUDE.md         | Done (CI green on PR #1)                                |
| M1 Migrations, setup wizard, local login, roles, sessions, recovery CLI | Done (CI green on PR #2; restyled to the design system) |
| M2 Asset types, fields, assets, CSV import, service accounts, tokens    | Done (CI green on PR #3)                                |
| M3 Status rules, assignment history, repairs, asset activity            | Done (CI green on PR #5)                                |
| M4 QR tags, label printing, scan page with check in and out             | Built; PR open, waiting on CI and review                |

Update this table when a milestone is committed.

## Working rules

1. Build only what `docs/PRODUCT_OVERVIEW.md` and `docs/IMPLEMENTATION.md` describe. Put proposed
   extras in `docs/IDEAS.md` instead of building them.
2. One milestone at a time. Before moving on, run `pnpm check` (lint, format, typecheck, tests)
   and commit with a clear message. Do not start the next milestone until every "done when"
   item of the current one is met and verified, including CI green on the milestone's pull
   request. Locally verified is not enough.
3. Write tests alongside the code, starting with the milestone's acceptance criterion.
4. Keep this file current with commands, conventions and decisions so a new session can resume
   cold.
5. Never commit secrets. `.env.example` holds placeholders only.
6. Prefer boring, well-known libraries. Before adding a dependency, say why the existing ones
   will not do.
7. When a requirement is ambiguous or an external API behaves differently from the spec, stop
   and ask. Check current Microsoft, Slack and library docs instead of relying on memory.
8. The project is GPL v3 (`LICENSE`). Do not add license headers or change the license.

## Commands

Requires Node 24 LTS (`.nvmrc`) and pnpm via corepack (`corepack enable`).

```sh
pnpm install                 # install all workspace packages
pnpm dev                     # server (tsx watch, :3000) and web (vite, :5173, proxies /api and /healthz)
pnpm build                   # shared -> server -> web, in dependency order
pnpm lint                    # eslint
pnpm format                  # prettier --write (format:check in CI)
pnpm typecheck               # tsc --noEmit in every package
pnpm test                    # vitest in every package
pnpm check                   # lint + format:check + typecheck + test

# Integration tests need PostgreSQL; they are skipped when TEST_DATABASE_URL is unset.
docker run -d --name itsm-testdb -e POSTGRES_PASSWORD=test -e POSTGRES_DB=itsm_test -p 5433:5432 postgres:18.6-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/itsm_test pnpm test

# Full stack from this checkout on https://localhost (Caddy internal CA)
docker compose -f compose.yml -f compose.build.yml up -d --build
scripts/compose-smoke.sh     # what CI runs: build, start, check /healthz through Caddy, tear down

# Database schema changes: edit apps/server/src/db/schema.ts, then generate a SQL migration
pnpm --filter @open-itsm/server db:generate --name <change>
# Raw SQL (triggers, functions): drizzle-kit generate --custom --name <change>, then fill it in

# Recovery CLI (in production: docker compose exec app itsm <command>)
pnpm --filter @open-itsm/server cli list-users
pnpm --filter @open-itsm/server cli reset-password admin@example.com [--enable]
```

`pnpm dev` reads `../../.env` for the server if it exists; set `DATABASE_URL` to a reachable
database (for example the test container above). Writes through Vite on :5173 are refused by the
CSRF origin check (Vite's proxy rewrites `Host`), so click-through checks of writes use the built
app instead: `pnpm build`, then `WEB_ROOT=apps/web/dist node dist/server.js` in `apps/server`
with the `.env` values exported, on http://localhost:3000.

## Layout

```
apps/server       Fastify API; also serves the built web UI from WEB_ROOT
  src/server.ts   entrypoint: config, pool, pg-boss, listen, graceful shutdown
  src/app.ts      buildApp(): plugins, routes, static/SPA fallback (tests call this directly)
  src/config.ts   env parsing with zod; errors never echo values
  src/health.ts   GET /healthz (app, database, queue; 503 when any is down)
  src/db/         schema.ts (Drizzle tables), client.ts (pool, db, runMigrations)
  src/logging.ts  pino options; scrubs anything shaped like a token from URLs
  src/auth/       password (argon2id), sessions, setup token, tokens (API tokens, rate counters),
                  http (cookie, bearer, CSRF, deny-by-default access check, token audit)
  src/assets/     fields.ts (field keys, value validation, CSV cells), numbers.ts (next numbers)
  src/routes/     setup, auth, users and service-accounts (admin only), asset-types, assets,
                  asset-import, asset-history (assign, return, repairs, history, suggestions);
                  deps.ts holds RouteDeps and the ADMIN_ONLY/ASSETS_* access presets
  src/audit.ts    append-only audit log writer (actor is a user or a service account)
  src/recovery.ts recovery commands; src/cli.ts is the `itsm` entrypoint in the image
  drizzle/        generated SQL migrations, applied at startup in one transaction
  test/           vitest; *.integration.test.ts need TEST_DATABASE_URL (each file gets its own DB)
apps/web          React + Vite + TanStack Router/Query + Tailwind v4
  src/index.css   design-system tokens (light, dark, OS-dark), Tailwind colour mappings, type-* styles
  src/components/ ui/ (Button, Input/Select/Label, Card/ErrorMessage, StatusBadge, Table), FormField,
                  PageHeader, ConfirmDialog, FormDialog, Logo, AuthLayout, ThemeSelect
  src/routes/     setup, login, authed layout (sidebar shell; redirects to setup/login), index,
                  assets (list), asset-new, asset-view (view + edit), asset-import, asset-types
                  (list + one type), admin-users, admin-service-accounts
  src/components/asset-form.tsx  number, name, status and the type's custom fields
  src/components/asset-history.tsx  asset page cards (assigned to, assignment history, repairs,
                  activity) and the assign/return/repair/status dialogs
  src/components/asset-tag.tsx  the printed tag (QR code drawn as an SVG path)
  src/components/qr-camera.tsx  camera preview that reads QR codes
  src/routes/asset-labels.tsx  print page (/assets/labels); scan.tsx is /scan and the tag
                  route /a/<number>
  src/lib/        api.ts (fetch wrapper, CSRF header, CSV import), queries.ts, assets.ts (status
                  tones, date and field formatting), theme.ts, roles.ts, scan.ts (tag URLs, reading
                  scans), labels.ts (print layouts)
  public/brand/   logo SVGs from the design system (lockup, reversed, mark, favicon, app icon)
packages/shared   zod schemas and types shared by server and web (auth, assets, tokens)
docs/api.md       operator notes for scripts: tokens, PowerShell and curl examples
compose.yml       app + db + caddy; the file operators download (Caddyfile is inline)
compose.build.yml override that builds the app image from the checkout
Dockerfile        multi-stage; runtime runs as `node`, files root-owned
.github/workflows/ci.yml  lint, format, audit, build, typecheck, tests (with Postgres), compose smoke
```

## Conventions

- TypeScript strict everywhere, ESM, `NodeNext` resolution on the server and shared package (use
  `.js` in relative imports), `Bundler` in the web app (no extensions, `@/` alias to `src`).
- `@open-itsm/shared` is consumed from source in dev, tests and typecheck (the
  `@open-itsm/source` export condition plus vitest/vite aliases) and from `dist` at runtime.
  Build tsconfigs clear `customConditions` so emitted code points at `dist`.
- Every route declares zod schemas for input and response via `fastify-type-provider-zod`;
  they feed the OpenAPI document at `/api/docs` (JSON at `/api/docs/json`).
- Unknown `/api/*` routes return JSON 404; other GET requests that accept HTML get `index.html`
  so client-side routes work.
- Logs are pino JSON to stdout; `authorization`, `cookie` and `set-cookie` are redacted.
- Dependencies are pinned to exact versions (`.npmrc` `save-exact=true`) and by the lockfile.
- Prettier: 100 columns, single quotes, trailing commas. `docs/IMPLEMENTATION.md`,
  `docs/PRODUCT_OVERVIEW.md` and `docs/open-itsm-brand.md` are excluded from formatting because
  they are maintained by hand.

## Decisions

- **Versions pinned at M0 (Oct 2026):** Node 24.22.0 LTS, pnpm 10.28.0, TypeScript 6.0.3,
  Fastify 5.12.7, zod 4.6.7, Drizzle ORM 0.45.4, pg-boss 12.38.0, React 19.3.1, Vite 8.3.4,
  Tailwind 4.3.3, Vitest 5.0.5, ESLint 10.4.0, PostgreSQL 18.6, Caddy 2.11.7.
- **TypeScript 6, not 7:** TS 7 (native compiler) is out, but typescript-eslint 8.x supports
  only `<6.1`. Revisit when typescript-eslint supports 7.
- **Two secrets in `.env`:** `APP_SECRET_KEY` (32 bytes base64, AES-256-GCM for stored
  credentials) and `SESSION_SECRET` (cookie signing, at least 32 chars). Both are validated at
  startup even though M0 does not use them yet, so a bad `.env` fails early.
- **Caddy config is inline in `compose.yml`** (Compose `configs.content`) so installs need only
  `compose.yml` and `.env`. `CADDY_GLOBAL_OPTIONS=local_certs` switches to Caddy's internal CA
  for internal hostnames. A certificate in `./certs` is not wired up yet (install work, M11).
- **Networks:** `backend` is `internal: true` (db and app only), so PostgreSQL has no host port
  and no route out; `frontend` joins app and caddy. A `caddy_config` volume was added beside the
  four volumes the spec lists, to keep Caddy's autosaved config.
- **PostgreSQL 18 volume** mounts at `/var/lib/postgresql` (the 18+ image layout), not
  `/var/lib/postgresql/data`.
- **Queue health** is `pg-boss isInstalled()`, which needs a database round trip; database and
  queue checks time out after 2 s each.
- **`trustProxy: true`** because the app is only reachable through Caddy on the compose network.
- **Image name** `ghcr.io/salmonllama/open-itsm`, tag from `OPEN_ITSM_VERSION` in `.env`. The
  release workflow that publishes multi-arch images is M11; CI builds but does not push.
- **Docker production deps** come from `pnpm install --prod --filter "@open-itsm/server..."`
  against the lockfile rather than `pnpm deploy`, whose legacy mode ignores the lockfile.
- **Migrations** are Drizzle SQL files in `apps/server/drizzle`, applied by `runMigrations` at
  startup before anything else. Drizzle runs all pending files in one transaction, so a failure
  rolls back and the app exits without changing data. (The pre-migration backup is M11.)
- **Rules enforced in the database:** unique emails stored lowercase (check constraint), role
  enum, non-negative failed-login count, and an append-only `audit_log` (triggers reject UPDATE,
  DELETE and TRUNCATE). Users are disabled, never deleted; audit FKs to users have no cascade.
- **Passwords:** argon2id via Node's built-in `crypto.argon2` (no native dependency), OWASP
  parameters m=19456 KiB, t=2, p=1, stored as PHC strings. Minimum 12 characters, maximum 256,
  no composition rules (user's choice). Unknown emails still run a dummy verify to keep timing
  equal.
- **Sessions:** random 32-byte token in the `__Host-itsm_session` cookie (HttpOnly, Secure,
  SameSite=Lax); the DB stores only HMAC-SHA256(SESSION_SECRET, token). 12 h idle, 7 days max
  (user's choice). Disabling a user or setting their password revokes all their sessions, with no
  exception for the caller's own: resetting your own password signs you out too (review
  decision on PR #2, so a compromised session cannot survive a reset). Role changes
  apply on the next request because the user row is joined on every lookup. The session lookup
  runs only for `/api/*` requests.
- **CSRF:** every non-GET request is refused if its `Origin` (or `Sec-Fetch-Site`) is another
  site. Requests with a session must also send `x-csrf-token` matching the session's token
  (from `GET /api/auth/session` or the login response). Login and setup are `origin-only`.
- **Login protection:** 10 attempts per minute per IP (`@fastify/rate-limit`, in memory, login
  and setup only) plus account lockout for 15 minutes after 5 consecutive failures. Locked
  accounts get 429 "try again later"; unknown, disabled and wrong-password all get the same 401.
- **Setup wizard:** works only while `users` is empty. A one-time token is generated at startup
  in memory and logged at warn level; `POST /api/setup` checks "no users" and inserts under a
  Postgres advisory lock, so concurrent attempts cannot both win. A restart issues a new token.
- **User admin (M1, user's choice):** admins list users, create local admin/technician
  accounts, change role, disable/enable and set passwords. At least one active admin must
  remain. Local end-user accounts cannot be created (end users arrive in M10 via Entra ID or
  email links). Self-service password change is in `docs/IDEAS.md`.
- **Recovery CLI:** `itsm list-users` and `itsm reset-password <email> [--enable]` (prints a
  random password once, clears lockout, revokes sessions). The "switch off Entra ID sign-in"
  command lands with Entra ID in M9.
- **New dependencies in M1:** `@fastify/cookie` (Fastify has no cookie parsing),
  `@fastify/rate-limit` (per-IP throttling) and `drizzle-kit` (dev, generates migrations).
- **Design system (Oct 2026):** `docs/open-itsm-brand.md` links the source of truth; where the
  mockups and the design system disagree, the design system wins. Tokens live in
  `src/index.css` as CSS variables (light default; dark under `[data-theme='dark']` and under
  `prefers-color-scheme: dark` unless `data-theme='light'`) and map to Tailwind colours
  (`bg-surface-raised`, `text-ink-muted`, `border-line-strong`, `bg-pine`, `text-danger`, ...).
  Type styles are `type-display|title|heading|body|label|caption|id|code` (named `type-*`, not
  `text-*`, so tailwind-merge in `cn` does not drop them next to a colour class). Radius
  sm/md/lg = 4/6/10 px. Components in `src/components/ui` are hand-written to match the design
  system's reference components (Button primary/secondary/ghost/danger and sm; StatusBadge with
  word + 12px shape + colour; TextField with hint/error and `aria-invalid`). One primary button
  per view; a danger action confirms in a `ConfirmDialog` (native `<dialog>`) that names the
  thing. Copy follows the design system's voice: what happened, then what to do; sentence case;
  "you", never "we"; no exclamation marks. shadcn's `components.json` stays for later CLI use.
- **Shell:** sidebar nav from the mockups (lockup at 28px, Lucide icons at 20px, selected item
  pine-soft with `aria-current="page"`, user name, role and Sign out in the footer); main area
  with 32px padding. Only pages that exist get nav items (Status, and Users for admins).
- **Theme:** follows the OS by default; the sidebar's Theme select overrides it per browser
  (`localStorage` key `open-itsm-theme`, applied in `main.tsx` before render). Storing it per user
  is in `docs/IDEAS.md`.
- **Fonts:** Atkinson Hyperlegible Next (400/600/700) and Mono (400/500) are self-hosted from
  `@fontsource/*` packages, never Google Fonts, so installs need no outside requests.
- **New dependencies (design pass):** `@fontsource/atkinson-hyperlegible-next` and
  `@fontsource/atkinson-hyperlegible-mono` (the brand fonts, self-hosted) and `lucide-react`
  (the design system's icon set).

- **Route access (M2):** deny-by-default. Every route sets `config.access`: `PUBLIC`,
  `{ roles }` or `{ roles, scopes }` (presets in `routes/deps.ts`). A route without `scopes`
  can never be reached with a token; `test/app.test.ts` fails if a route declares nothing. The
  OpenAPI viewer and JSON are for signed-in staff only. No CORS headers are sent.
- **API tokens (M2):** belong to service accounts (admin-managed, cannot sign in). Format
  `oitsm_<16 hex id>_<64 hex secret>`; only SHA-256 of the secret is stored, compared in constant
  time; shown once. Expiry required: default 90 days, max 365, flagged within 14 days (user's
  choice). Scopes `assets:read`/`assets:write` now, ticket scopes in M6; `write` does not imply
  `read`. The asset scopes cover asset types and fields too (user's choice). Bearer header only:
  a token in the query or body is refused (400) and audited. Cookie plus token is refused (400).
  Token requests skip CSRF. Limits (in memory): 300 requests per token per minute; 10 invalid
  tokens per IP per 15 minutes, after which the IP gets 429 and attempts are no longer audited
  (so a flood cannot fill the log). Every state-changing token request is audited
  (`token.request`, written in onResponse). `last_used_at` is touched at most once a minute.
- **Service accounts** can be deleted only while nothing references them (409 `has_history`);
  otherwise disable them.
- **Who manages asset types (M2, user's choice):** administrators and technicians.
- **Asset fields (M2, user's choice):** number, name, status, type and custom fields. Asset numbers
  are `PREFIX-000123`, unique ignoring case across all types; a blank number takes the type's
  next number, skipping numbers already taken (the type row is locked). Numbers may contain `/`,
  so web URLs use the asset ID. Custom field values are JSONB keyed by a slug of the label;
  kinds are text, number, date (YYYY-MM-DD), select and boolean, and a field's kind never
  changes. Removing a choice that assets still use is refused.
- **Deleting assets (M2/M3, user's choice):** allowed with a confirmation naming the asset and an
  audit record, only while its activity holds nothing but edits; otherwise 409 and retire it.
  The page hides Delete once that is true.
- **Status rules (M3, user's choice):** people set only Preparing, In stock and Retired (create,
  edit, import, Change status), and only while the asset is not Deployed or In repair. Assigning
  sets Deployed; reassigning ends the open assignment and starts a new one; returning ends it and
  sets In stock or Retired. Opening a repair sets In repair (a DB trigger on `repairs` insert, so
  it holds for any writer) and keeps the assignment open; closing restores `previous_status`. A
  retired asset cannot be assigned or repaired; nothing can be assigned or returned during a
  repair; one open repair per asset. Refusals are 409 with what to do next.
- **Assignments (M3, user's choice):** free-text person and/or location (at least one), since end
  users are not accounts until M10; suggestions come from earlier assignments
  (`GET /api/assets/assignment-suggestions`). One open assignment per asset (partial unique
  index). `asset_assignments` and `repairs` are append only by trigger: the only update allowed
  is ending or closing an open row (closing may replace the repair notes); no delete or truncate.
- **Asset activity (M3, user's choice):** `asset_events` (append only) records edits (labels of
  what changed), status changes, assignments, returns and repairs, with the actor (user or
  service account). Its rows cascade only when the asset itself is deleted (trigger allows the
  delete only once the asset row is gone). `GET /api/assets/:id/history` returns assignments,
  repairs and activity, newest first. All of this is under the asset scopes.
- **Asset tags (M4, user's choice):** a tag's QR code holds `https://<host>/a/<asset number>`
  (number URL-encoded, so `OLD/42` is `/a/OLD%2F42`), built from the address the tag is printed
  from. `/a/*` is a client route that looks the number up (`GET /api/assets/by-number/:number`)
  and opens the asset; signed-out visitors sign in first and land on it. Changing an asset's
  number breaks its printed tag. The tag follows the design system's AssetTag: 2 × 0.75 in,
  black on white, QR, number, "type · name", a fixed "Property of IT" line and a fixed help
  line (a setting for both is in `docs/IDEAS.md`).
- **Printing tags (M4, user's choice):** `/assets/labels` prints one tag per label for label
  printers (`@page` 2 × 0.75 in) or sheets: Letter Avery 5160 (30) and A4 Avery L7160 (21), tag
  centred on each label. It takes `ids` (asset page "Print tag", ticked rows on the asset list)
  or the list's filters (nothing ticked), at most 1,000 tags. The layout is remembered per
  browser (`localStorage` key `open-itsm-label-layout`). The sidebar is hidden in print.
- **Scan page (M4, user's choice):** `/scan` reads a tag with the camera or from the "Asset
  number or tag" field (USB scanners in keyboard mode type the URL and press Enter; a typed
  number works too). Modes: Open asset (default), Check out (assigns to the person and/or
  location entered once; refuses an asset already deployed) and Check in (returns to In stock;
  refuses one not deployed). The camera uses the browser's `BarcodeDetector` where it has QR
  support and lazy-loads jsQR otherwise; it needs https (or localhost). A code is handled once
  while it stays in view.
- **New dependencies in M4:** `qrcode-generator` (draws tag QR codes; no dependencies, the one
  the design system's preview uses) and `jsqr` (reads QR codes in browsers without
  `BarcodeDetector`, which includes Safari and Firefox). Nothing in the project drew or read QR
  codes before.
- **CSV import:** comma-separated, UTF-8 (BOM allowed), header row names columns (`Number`,
  `Name`, `Status` and field labels or keys, any case). All-or-nothing in one transaction, at
  most 5,000 rows; every problem is reported with its line and column (HTTP 422); `dryRun=true`
  only checks. The web page always checks first, then imports.
- **New dependency in M2:** `csv-parse` (server). Hand-rolled CSV parsing gets quoted commas,
  newlines in cells and BOMs wrong; csv-parse is the standard, dependency-free parser.

## Open questions

- GPL v3 is tentative until the first release (AGPL may be revisited if hosted SaaS happens).
  Do not change `LICENSE` without being told.
- Admin recovery when SSO is misconfigured and the admin password is lost: the host-level
  recovery CLI (`itsm reset-password`, M1); the SSO switch-off command comes with M9.
