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

## Development

See `CLAUDE.md` for commands, layout and conventions.

## License

GPL v3. See `LICENSE`.
