# report-platform — publishing to the canonical report-host

This toolkit produces structured JSON artifacts (research findings, sequenced
hardening plans, gate verdicts) that are far more useful as an interactive
page than as a wall of JSON. Rather than run its own server, claude-zig-quality
**publishes those reports into the shared, canonical `report-host` platform**
on the meshnet.

> **Adoption, not a second server.** An earlier iteration shipped a
> self-contained `Mix.install` Phoenix server here (`report-server.exs` +
> a `launchd` plist + `deploy.sh`). That was a *reinvention* of `report-host`,
> which already exists as the canonical, durable, multi-project meshnet
> dashboard. The server was retired; this directory now holds only the
> **publisher** and the design lessons. See `doc/adr/0006-report-platform.md`.

## What's here

| File | Purpose |
|---|---|
| `publish.ts` | Publishes a claude-zig-quality status report to `report-host`. Holds a **hand-maintained** status snapshot (the `summary`/`tasks`/`links` arrays, edited as work progresses) already shaped as report-host's dashboard schema, and writes `reports/claude-zig-quality.json` on the host via an atomic temp-file + rename. (Mapping arbitrary workflow `{plan,findings}` JSON into that schema is a possible future enhancement; today the snapshot is curated in-file.) |
| `README.md` | This file. |

```sh
# Publish / refresh the live report:
bun report-platform/publish.ts
bun report-platform/publish.ts --dry-run     # print the JSON, don't write
# View:
open http://100.100.39.44:4000/r/claude-zig-quality
```

## The canonical platform: `report-host`

`report-host` is a packaged **Phoenix LiveView release**, source-tracked in
**`EugOT/home-cordlab`** at `apps/report_host`, deployed by the Rust installer
`apply/cordlab-apply` and supervised by the `home.cordillera.report-host`
`launchd` agent on `himalayas`. (The `ai.secureinfra.*` namespace was retired
on personal machines in the 2026-06-21 home-lab migration; it remains only as
the MUW k3s cluster identity in `EugOT/cluster-config`.)

- **Host:** `himalayas` (Apple-Silicon Mac mini), meshnet IP `100.100.39.44`.
- **URL:** `http://100.100.39.44:4000/` — index of all projects;
  `http://100.100.39.44:4000/r/<project>` per project. (A `report.cordillera.home`
  Caddy + internal-TLS front is planned; until then, the raw meshnet IP.)
- **Meshnet:** NordVPN Meshnet (**not** Tailscale → no `tailscale serve`, no
  MagicDNS; peers use the raw `100.x` IP). The release binds the meshnet IP.
- **Toolchain:** Elixir pinned `1.20.1-otp-29` (the host has two `mise` install
  roots; pinning avoids the split).

### Multi-project contract

report-host historically read a single `current.json` (last-writer-wins — pz,
walcode, gitstore clobbered each other). It now also reads
`REPORT_HOST_REPORTS_DIR` (`~/.local/share/report-host/reports/`): each project
writes `reports/<slug>.json` and gets `/r/<slug>` + a slot in the index, with no
cross-project clobber. `current.json` remains a back-compat alias. Slugs are
basename-guarded against traversal. (Added in chezmoi `apps/report_host`; see
that repo's commit `feat(report-host): multi-project reports dir + per-slug
routes`.)

## Lesson: LiveView interactivity needs same-origin JS

A CDN `phoenix.js` / `phoenix_live_view.js` + a hand-rolled
`new LiveSocket(...).connect()` renders the page but leaves **`phx-click`
dead**: the server logs `CONNECTED TO Phoenix.LiveView.Socket` (transport only)
yet the **LiveView channel never joins**, so events never reach the server.
Root cause: CDN/dep version drift. The fix (used by report-host) is to serve the
deps' own `priv/static` JS **same-origin** via `Plug.Static`, plus a
`<meta name="csrf-token">` and `Application.put_env(:phoenix, :json_library,
Jason)`. Then the channel joins and interactivity works.

## Lesson: durability + ops gotchas

- **`launchd`, not `nohup`.** A `nohup &` server is an orphan (PPID 1) and
  does not survive reboot; an orphan can also squat `:4000` and shadow the
  managed service. Use the `KeepAlive` + `RunAtLoad` LaunchAgent, and ensure it
  is boot-persistent (`launchctl enable`).
- **Logs must be `$HOME`-writable.** A LaunchAgent's `StandardErrorPath` must
  be writable at spawn time; a `/Volumes` mount can be absent in `launchd`'s
  context → exit 78 (`EX_CONFIG`), silently.
- **Distinct release node name** when staging a second instance, or EPMD
  rejects it (`name ... in use`).
- **`secret_key_base` ≥ 64 bytes**, or the cookie session store 500s every
  request.

## Report data shape (what the publisher emits)

`publish.ts` emits report-host's dashboard schema directly. `state` ∈
`ready | warn | error | info` and drives each panel/dot color:

```json
{
  "title": "claude-zig-quality — hardening progress",
  "observed_at": "<ISO-8601>",
  "source": "...",
  "summary": [{ "label": "Phase 1", "value": "MERGED", "note": "...", "state": "ready" }],
  "nodes":   [{ "name": "...", "state": "ready", "kernel": "...", "os": "...", "note": "..." }],
  "tasks":   [{ "title": "...", "note": "...", "state": "ready" }],
  "links":   [{ "label": "PR #9", "url": "https://...", "note": "merged" }]
}
```

(claude-zig-quality has no node fleet, so `nodes` is empty.)
