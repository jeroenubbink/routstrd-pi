# routstrd-pi

A [pi](https://pi.dev) agent package that shows **routstrd** session spend and wallet
balance in **satoshis** — with a ⚡ / ₿ glyph instead of pi's dollar estimate.

## What it does

It replaces pi's built-in footer with a faithful copy that swaps the money
figures for routstrd's real, wallet-signed numbers:

- **`⚡13.99sats`** — what this session actually spent, summed from the routstrd
  daemon's per-request `satsCost`. A trailing `…` marks requests still syncing;
  `⚡--` marks an unreachable daemon.
- **`@ai.redsh1ft.com`** — the routstr node that served the most recent
  response, from the daemon's usage rows.
- **`₿1519`** — total left in your local routstrd Cashu wallet, across mints.
- **`72sats remote`** — total held as API-key credit on remote routstr
  providers (daemon `GET /keys/balance`).
- Everything else stays as you know it: `↑ ↓ R W` token stats, `CH` cache-hit
  rate, context `%`/window with the usual color thresholds, git branch, session
  name, model name with thinking level, and other extensions' status lines.

Every figure can be turned on/off or made width-aware — see
[Configuration](#configuration) below.

Example footer (stats line):

```
↑32.0k ↓254 R512 W0 CH1.6% ⚡13.99sats @ai.redsh1ft.com ₿1519 72sats remote 24.0%/1M   (routstr) glm-5.3 • medium
```

The package is fully standalone — no other package is required. On a vanilla
pi install it replaces the footer itself; nothing depends on Gentle Shell
(see below for what happens when Gentle Shell is present).

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
switches to status mode: `⚡13.99sats used @ai.redsh1ft.com · ₿1519 wallet ·
72sats remote` appears in gentle's status surfaces (the INTEGRATIONS card /
status bar), alongside gentle's own `ctx`/`$` segments. Those segments come
from gentle-pi; hide them via gentle's visibility settings if you want the
sats figures to stand alone. Without gentle-pi (or any other footer
extension), the package renders its own footer — this is the default path.

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

All display options are optional and live in a small JSON file. Default
location: `~/.routstrd/pi.json` (honoring `ROUTSTRD_DIR`); `ROUTSTRD_PI_CONFIG`
points at another path. The file is read when pi starts — restart pi (or run
`/reload`) to apply changes. A missing or invalid file simply means defaults.

```json
{
  "daemonUrl": "http://127.0.0.1:8008",
  "show": {
    "spend": true,
    "usd": false,
    "node": "auto",
    "wallet": true,
    "remote": "auto"
  }
}
```

| Key | Default | Shows | Rules |
|---|---|---|---|
| `show.spend` | `true` | `⚡13.99sats` — sats this session spent | `true`/`false` |
| `show.usd` | `false` | `$0.012` — USD equivalent of the session spend, from the daemon's usage rows | `true`/`false`/`auto` |
| `show.node` | `auto` | `@ai.redsh1ft.com` — routstr node that served the latest response | `true`/`false`/`auto` |
| `show.wallet` | `true` | `₿1519` — local Cashu wallet balance | `true`/`false`/`auto` |
| `show.remote` | `auto` | `72sats remote` — API-key credit on remote routstr providers | `true`/`false`/`auto` |
| `daemonUrl` | — | Daemon base URL override | URL string |

Rule semantics:

- `true` — always show the figure (even when narrow).
- `false` — never show it.
- `"auto"` — show it only while it fits the terminal, so a narrow window
  never shows a figure half-written. Extras drop in this order when space
  runs out: `usd`, then `remote`, then `node`; the spend and wallet figures
  come last. When the terminal is resized the line re-fits immediately.

The daemon base URL is otherwise resolved in this order:

1. `ROUTSTRD_BASE_URL` environment variable
2. `daemonUrl` from the display config file
3. `host`/`port` from `~/.routstrd/config.json` (honoring `ROUTSTRD_DIR`)
4. Default `http://127.0.0.1:8008`

## Caveats

- Sats are attributed per completed assistant response. Requests that fail
  after payment, and auxiliary requests that produce no assistant message,
  are not counted — they still drain the wallet, so treat `₿` as the source
  of truth for what you have left.
- `₿` shows the **local** Cashu wallet (proofs held at your mints) and can
  dip briefly mid-payment while proofs are in flight.
- `Nsats remote` shows API-key credit on remote routstr providers (refreshed
  on start and about once a minute; the daemon asks remote nodes live, so the
  first figure can take a few seconds).
- The extension is display-only; it never mutates wallet or daemon state.
- Requires a routstrd daemon with `/keys/balance` for the remote figure
  (0.3.0+); without it, the other figures still work.


## Roadmap

- [x] Session spend in sats (⚡)
- [x] Node that served the latest response (@host)
- [x] Local wallet balance in sats (₿)
- [x] Remote provider deposits — API-key credits (`Nsats remote`)
- [ ] Per-mint / per-node breakdown

## License

MIT
