# Changelog

## [0.2.1]

- README screenshot of the live footer (real routstrd figures).
- Published to npm as `routstrd-pi` for the pi.dev package gallery.

## [0.2.0]

- Node indicator: `@host` — the routstr node that served the most recent
  response, taken from the daemon's usage rows (footer and status modes).
- Remote provider deposits: `Nsats remote` — total API-key credit on remote
  routstr providers, from the daemon's `GET /keys/balance`. Refreshed on
  start and about once a minute, independently of the fast local endpoints
  so sats attribution is never delayed. Older daemons without the endpoint
  simply omit the figure.
- Display configuration file (`~/.routstrd/pi.json`, or `ROUTSTRD_PI_CONFIG`):
  `show.spend|usd|node|wallet|remote`, each `true` (always), `false` (never)
  or `"auto"` (only while it fits the terminal), plus optional `daemonUrl`.
  Defaults: spend/wallet always, node/remote auto, usd off.
- Width-aware layout: `"auto"` figures drop cleanly (usd → remote → node)
  when the terminal is too narrow — never half-written — and re-fit on
  resize (footer mode uses the exact render width; status mode the terminal
  width minus a reserve, refreshed live on resize).
- Optional USD figure (`show.usd`): USD equivalent of the session spend,
  from the daemon's per-request USD cost.
- Documented that the package is fully standalone: on vanilla pi (no
  gentle-pi) it replaces the footer itself; no dependency on Gentle Shell.

## [0.1.0]

- Initial release.
- Session spend in sats (⚡): matches each assistant response id
  (`gen-…` and Anthropic-route `msg_…`) against the routstrd daemon's
  `/usage` rows — exact across `/resume`, `/fork` and compaction, and
  scoped to this pi session only.
- Local Cashu wallet balance in sats (₿) from the daemon's `/balance`.
- Two display modes, negotiated automatically:
  - **Footer mode**: replaces pi's built-in footer with a faithful copy
    whose money figures are routstrd's; keeps token stats, cache-hit rate,
    context %, git branch, session name, model name, thinking level and
    other extensions' status lines.
  - **Status mode**: when another footer extension (e.g. Gentle Shell)
    replaces the footer, falls back to `ctx.ui.setStatus()` so the sats
    figures still render in whatever UI owns the footer.
- Daemon base URL resolution: `ROUTSTRD_BASE_URL`, then
  `~/.routstrd/config.json` (honoring `ROUTSTRD_DIR`), then
  `http://127.0.0.1:8008`.
- Optional trace logging with `ROUTSTRD_PI_DEBUG=1`.
