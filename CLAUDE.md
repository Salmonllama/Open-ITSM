# CLAUDE.md

Open ITSM is a free, self-hosted ITSM (asset management and email ticketing) for IT teams of 1 to
10 technicians. Read both before starting work: `docs/PRODUCT_OVERVIEW.md` defines v1 scope (and
what is out of scope); `docs/IMPLEMENTATION.md` fixes the stack, data model, build order and
acceptance criteria.

## Status

| Milestone                                                               | State                    |
| ----------------------------------------------------------------------- | ------------------------ |
| M0 Scaffold, image, compose, `/healthz`, CI, LICENSE, CLAUDE.md         | Built; awaiting green CI |
| M1 Migrations, setup wizard, local login, roles, sessions, recovery CLI | Next                     |

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
```

`pnpm dev` reads `../../.env` for the server if it exists; set `DATABASE_URL` to a reachable
database (for example the test container above).

## Layout

```
apps/server       Fastify API; also serves the built web UI from WEB_ROOT
  src/server.ts   entrypoint: config, pool, pg-boss, listen, graceful shutdown
  src/app.ts      buildApp(): plugins, routes, static/SPA fallback (tests call this directly)
  src/config.ts   env parsing with zod; errors never echo values
  src/health.ts   GET /healthz (app, database, queue; 503 when any is down)
  test/           vitest; *.integration.test.ts need TEST_DATABASE_URL
apps/web          React + Vite + TanStack Router/Query + Tailwind v4, shadcn/ui-ready
packages/shared   zod schemas and types shared by server and web
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
- Prettier: 100 columns, single quotes, trailing commas. `docs/IMPLEMENTATION.md` is excluded
  from formatting because it is maintained by hand.

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
- **shadcn/ui:** `apps/web/components.json`, `src/lib/utils.ts` (`cn`) and theme tokens in
  `src/index.css` are in place; add components with the shadcn CLI as screens need them.

## Open questions

- GPL v3 is tentative until the first release (AGPL may be revisited if hosted SaaS happens).
  Do not change `LICENSE` without being told.
- Admin recovery when SSO is misconfigured and the admin password is lost: answered by the
  host-level recovery CLI (M1), confirmed in `docs/IMPLEMENTATION.md`.
