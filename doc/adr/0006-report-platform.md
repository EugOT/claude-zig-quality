# ADR 0006: Interactive reports platform (Phoenix LiveView on the meshnet)

- **Status:** Amended — ADOPT the existing `report-host` (see amendment below)
- **Date:** 2026-06-21
- **Deciders:** repo owner
- **Tags:** reporting, phoenix, liveview, meshnet, launchd, hosting

## Amendment (2026-06-21): adopt `report-host`, do not ship our own server

The original decision below proposed shipping a self-contained `Mix.install`
Phoenix LiveView server from this repo (`report-platform/report-server.exs` +
a `launchd` plist + `deploy.sh`). Live reconnaissance then established that a
**canonical platform already exists**: `report-host`, a packaged Phoenix
release source-tracked in **`EugOT/home-cordlab`** (`apps/report_host`),
deployed by the Rust installer `apply/cordlab-apply` and supervised by the
`home.cordillera.report-host` LaunchAgent on `himalayas` (the
`ai.secureinfra.*` namespace was retired on personal machines in the
2026-06-21 home-lab migration; it survives only as the MUW k3s cluster
identity in `EugOT/cluster-config`). report-host is already used by other
projects (pz, walcode, gitstore) which publish by writing a JSON snapshot.

**Revised decision:** ADOPT `report-host` as the single canonical platform.
claude-zig-quality does **not** run its own server; it publishes
`reports/claude-zig-quality.json` into report-host via `report-platform/
publish.ts`. The competing `report-server.exs` / plist / `deploy.sh` were
removed from this repo.

To make multiple projects coexist (report-host previously read a single
`current.json`, last-writer-wins), report-host gained a
`REPORT_HOST_REPORTS_DIR` + `/r/<slug>` index (implemented in
`EugOT/home-cordlab`'s `apps/report_host`, fully backward-compatible —
`current.json` remains an alias). The same-origin-JS and `launchd` lessons
below still hold and are why report-host's interactivity works.

The original analysis (context, alternatives, the interactivity/durability
findings) is retained verbatim below because it remains the rationale for the
*shape* of the platform; only "who hosts it" changed (a pre-existing release,
not a new in-repo server).

---

## Context

The toolkit's research/planning workflows emit structured JSON (research
findings, sequenced hardening plans, gate verdicts). These are far more
useful as an interactive page than as raw JSON. We want a durable, low-
friction way to view them: an index of reports, each interactive
(click-to-expand phases, plan/research tabs, risk badges), reachable from
any machine on the operator's meshnet.

Two attempts informed the decision:

1. **CDN-loaded LiveView (failed interactivity).** A single-file
   `Mix.install` Phoenix server that loaded `phoenix.js` /
   `phoenix_live_view.js` from a CDN and called `new
   LiveSocket(...).connect()` manually. The page rendered but `phx-click`
   was dead: the server logged `CONNECTED TO Phoenix.LiveView.Socket`
   (raw transport) but the **LiveView channel never joined**, so events
   never reached the server. Root cause: CDN/dep version drift and UMD
   global namespacing — a documented, reproducible failure mode.

2. **Client-side-JS fallback (works, but not LiveView).** Replacing
   `phx-click` with vanilla `onclick` toggles made the page interactive
   without a WebSocket, but gives up LiveView's server-driven model and
   doesn't scale to richer, stateful reports.

Live reconnaissance of the host (`himalayas`, Apple-Silicon Mac mini)
established the operating constraints: the meshnet is **NordVPN Meshnet,
not Tailscale** (no `tailscale serve`, no MagicDNS — peers use the raw
`100.100.39.44`); a prior report server was an **orphaned `nohup`** that
would not survive reboot; the host has **two `mise` install roots** (pin
the toolchain); and the internal disk is near-full (keep artifacts in
`$HOME`, not on the external volume which `launchd` may not see).

## Decision

Adopt a **Phoenix LiveView reports platform**, served on the meshnet and
supervised by `launchd`, with three correctness pillars:

1. **Same-origin vendored JS (the interactivity fix).** Serve the deps'
   own `priv/static/phoenix.min.js` and `phoenix_live_view.min.js` via
   `Plug.Static` (`from: {:phoenix, "priv/static"}`), so the client JS is
   always exactly the server's dep version. Combined with a
   `<meta name="csrf-token">`, the standard `new LiveSocket("/live",
   window.Phoenix.Socket, {params:{_csrf_token}})`, and
   `Application.put_env(:phoenix, :json_library, Jason)`, the LiveView
   channel joins and `phx-click` round-trips. This keeps a single-file
   `Mix.install` server (no mix project / esbuild) while getting reliable
   interactivity.

2. **`launchd` supervision (durability).** A `KeepAlive` + `RunAtLoad`
   LaunchAgent restarts the server on crash and at login. Logs and report
   data live under `~/zq-report/` because a LaunchAgent's
   `StandardErrorPath` must be writable at spawn time — an external
   `/Volumes` mount may be absent in `launchd`'s context and fails the job
   with exit 78 (`EX_CONFIG`), silently.

3. **Bind `0.0.0.0`, address by meshnet IP.** With NordVPN Meshnet there
   is no `serve`/MagicDNS layer; binding all interfaces makes the service
   reachable at `100.100.39.44:4000` (canonical) for meshnet peers and at
   the host LAN IP for same-LAN browsers.

Canonical surface: **`http://100.100.39.44:4000/`**, Elixir pinned to
`1.20.1-otp-29`.

Security: tailnet-only by construction; `secret_key_base` and signing
salts are generated and persisted `0600` (never hardcoded); `check_origin`
is an explicit allowlist; report names are path-traversal-guarded.

## Consequences

- **Positive:** Real, reliable LiveView interactivity from a single `.exs`
  file — no mix project, no esbuild, no node build step, no CDN dependency.
- **Positive:** The service is durable across reboots and self-heals on
  crash; one canonical URL for all reports.
- **Positive:** The same-origin-JS pattern is reusable for any future
  LiveView tool in this repo (eval dashboards, DORA metrics per ADR 0004).
- **Negative:** `Mix.install` recompiles ~15 deps on a cold cache (minutes)
  on first boot; the deploy script waits accordingly and the agent's
  `KeepAlive` covers a slow first start.
- **Negative:** Tied to the host's `launchd` + NordVPN specifics; porting
  to a Tailscale/Linux host would swap the supervision + exposure layer
  (the LiveView/same-origin core is portable).
- **Negative:** A long-lived listener on the meshnet is standing
  infrastructure to maintain; mitigated by it being tailnet-only and tiny.

## Alternatives considered

- **HTMX + tiny server (Elixir/Plug or Bun).** Interactivity via HTML
  fragments over plain HTTP — no WebSocket fragility. Viable and simpler
  operationally, but gives up LiveView's stateful server model the operator
  prefers for richer reports. Kept as the fallback if LiveView ops prove
  burdensome.
- **Static self-contained HTML (inline JS).** What the failed-LiveView
  attempt fell back to. Zero infra, but no shared platform/index and no
  server state; doesn't scale to a multi-report surface.
- **Full Phoenix mix project + esbuild release.** The canonical
  production path; rejected for this internal tool as too heavy vs the
  single-file `Mix.install` server, which — with same-origin vendored JS —
  achieves the same interactivity.
- **Tailscale `serve` for a clean HTTPS MagicDNS URL.** Not applicable:
  the host's meshnet is NordVPN, which has no equivalent.

## Validation

- LiveView interactivity verified end-to-end in a real browser over the
  meshnet: index → report navigation, phase expand/collapse, and plan↔
  research tab switching all round-trip over the WebSocket (the exact
  interactions that were dead with the CDN approach).
- `launchd` agent runs healthy (`launchctl list` shows it loaded, exit 0)
  and serves across reconnects.
- `report-server.exs` parses under the pinned Elixir; `deploy.sh` passes
  `bash -n`; the plist passes `plutil -lint`.

## References

- `report-platform/README.md` — operational guide + the same-origin-JS fix.
- `report-platform/{report-server.exs,ai.eugot.zq-reports.plist,deploy.sh}`.
- ADR 0004 (`0004-dora-metrics-tracking.md`) — a future consumer of this
  platform.
