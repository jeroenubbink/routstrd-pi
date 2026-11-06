# Changelog

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
