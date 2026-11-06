# routstrd-pi

A [pi](https://pi.dev) agent package that shows **routstrd** session spend and wallet
balance in **satoshis** — with a ⚡ / ₿ glyph instead of pi's dollar estimate.

## What it does

It replaces pi's built-in footer with a faithful copy that swaps the money
figures for routstrd's real, wallet-signed numbers:

- **`⚡13.99sats`** — what this session actually spent, summed from the routstrd
  daemon's per-request `satsCost`. A trailing `…` marks requests still syncing;
  `⚡--` marks an unreachable daemon.
- **`₿1519`** — total left in your local routstrd Cashu wallet, across mints.
- Everything else stays as you know it: `↑ ↓ R W` token stats, `CH` cache-hit
  rate, context `%`/window with the usual color thresholds, git branch, session
  name, model name with thinking level, and other extensions' status lines.

Example footer (stats line):

```
↑32.0k ↓254 R512 W0 CH1.6% ⚡13.99sats… ₿1519 24.0%/1M   (routstr) glm-5.3 • medium
```

The session spend is exact: every assistant message routed through a routstr
daemon carries the daemon's response id (visible as `responseId` in the session
file — `gen-…` from OpenAI-shaped routes, `msg_…` from the Anthropic-shaped
route), and the daemon's `GET /usage` reports the sats charged for each of
those ids. The extension matches the session's ids against the daemon's
usage rows, so it survives `/resume`, `/fork` and compaction, and it never
counts requests made by other clients (Claude Code, OpenCode, other pi
sessions) against your pi session.

### Gentle Shell

If you use [gentle-pi](https://github.com/earendil-works/gentle-pi), its
footer extension replaces pi's (and ours), so the package automatically
switches to status mode: `⚡13.99sats used · ₿1519 wallet` appears in gentle's
status surfaces (the INTEGRATIONS card / status bar), alongside gentle's own
`ctx`/`$` segments. Those segments come from gentle-pi; hide them via
gentle's visibility settings if you want the sats figures to stand alone.

### Debugging

Set `ROUTSTRD_PI_DEBUG=1` to append a trace of lookups and matches to
`/tmp/routstrd-pi-debug.log`.

## Install

Prerequisites: a running [routstrd](https://github.com/routstr/routstrd) daemon
with pi wired up (`routstrd clients add --pi-agent`), and pi itself.

```sh
pi install ./pi-agent-routstrd     # local path, or:
pi install git:github.com/routstr/routstrd-pi@v0.1.0
```

Then start pi normally — the footer appears once the first events fire.

### Configuration

The daemon base URL is resolved in this order:

1. `ROUTSTRD_BASE_URL` environment variable
2. `host`/`port` from `~/.routstrd/config.json` (honoring `ROUTSTRD_DIR`)
3. Default `http://127.0.0.1:8008`

## Caveats

- Sats are attributed per completed assistant response. Requests that fail
  after payment, and auxiliary requests that produce no assistant message,
  are not counted — they still drain the wallet, so treat `₿` as the source
  of truth for what you have left.
- `₿` shows the **local** Cashu wallet (proofs held at your mints) and can
  dip briefly mid-payment while proofs are in flight. Deposits sitting as
  API-key credit on remote routstr providers are not shown yet — planned for
  a future release.
- The extension is display-only; it never mutates wallet or daemon state.

## Roadmap

- [x] Session spend in sats (⚡)
- [x] Local wallet balance in sats (₿)
- [ ] Remote provider deposits (API-key credits) from the provider registry
- [ ] Per-mint breakdown

## License

MIT
