# Codex Monitor

Codex Monitor is a local-first desktop application for inspecting Codex token usage across machines and verifying the real upstream model used by Codex. Prompts, responses, tool output, and source code never enter usage snapshots or Hub synchronization.

## Features

- Codex session, model, project, cache, reasoning and output-token analytics
- Persistent history that survives deletion of source sessions
- Authenticated LAN hub, UDP discovery, SSE live updates and persistent offline replay
- Native Windows, macOS and Linux desktop builds plus a headless Node/Docker agent
- Account-scoped model discovery using the active local Codex login
- Live model verification with strict requested/upstream identity comparison, latency, response status and token usage
- Persistent model heartbeats with change-only desktop notifications
- Dense token composition, rate-limit, yearly activity, session and per-device analytics
- Compact Linear/Raycast-inspired desktop interface with light, dark and reduced-motion modes

## Development

Requirements: Node.js 22.15+ and pnpm.

```bash
pnpm install
pnpm dev
```

## Multi-device synchronization

The simplest setup needs no terminal:

1. On one desktop, open **Settings → LAN synchronization**, choose **Host a Hub**, enter a shared secret of at least 16 characters, and apply.
2. On every other Windows, macOS or Linux desktop, choose **Join a Hub**, enter the same secret, select **Discover LAN**, and apply.
3. Open **Devices** to see online state, platform, last synchronization and per-device totals. Device names can be edited and stale devices can be removed there.

The secret is encrypted with the operating system credential service. UDP port `17322` is used only to advertise the Hub; snapshots and the live SSE stream use authenticated TCP port `17321`. If discovery is blocked by a firewall or VLAN, enter `http://<hub-ip>:17321` manually. VPN addresses from Tailscale or ZeroTier work in the same field.

The desktop and headless agent keep a bounded SQLite upload queue. A device that loses connectivity continues collecting locally and replays snapshots in sequence after reconnecting. Device sequence numbers persist across restarts so a Hub never accepts an older state over a newer one.

Run a standalone LAN Hub instead of hosting it in the desktop:

```bash
CODEX_MONITOR_SECRET=replace-with-a-long-secret pnpm dev:hub
```

PowerShell:

```powershell
$env:CODEX_MONITOR_SECRET = "replace-with-a-long-secret"
pnpm dev:hub
```

Run a headless collector:

```bash
CODEX_MONITOR_HUB_URL=http://192.168.1.10:17321 \
CODEX_MONITOR_SECRET=replace-with-a-long-secret pnpm agent
```

`CODEX_MONITOR_HUB_URL` is optional for the headless agent when UDP discovery can reach the Hub. `CODEX_MONITOR_SECRET` is always required. Supported optional variables are:

- `CODEX_MONITOR_DEVICE_NAME` and `CODEX_MONITOR_DEVICE_ID`
- `CODEX_MONITOR_EXTRA_ROOTS` for additional Codex session roots
- `CODEX_MONITOR_STATE_DIR` for queue and retained-history storage
- `CODEX_MONITOR_SCAN_INTERVAL_MS` for the periodic full scan
- `CODEX_MONITOR_DISCOVERY=0` to disable Hub advertisement

Build a containerized headless agent:

```bash
docker build -f apps/agent/Dockerfile -t codex-monitor-agent .
docker run -d --restart unless-stopped \
  -e CODEX_MONITOR_SECRET=replace-with-a-long-secret \
  -e CODEX_MONITOR_HUB_URL=http://192.168.1.10:17321 \
  -v "$HOME/.codex:/codex:ro" -v codex-monitor-agent:/data \
  codex-monitor-agent
```

## Platform builds

```bash
pnpm --filter @codex-monitor/desktop dist:win
pnpm --filter @codex-monitor/desktop dist:mac
pnpm --filter @codex-monitor/desktop dist:linux
```

Windows outputs NSIS and portable executables, macOS outputs DMG and ZIP packages, and Linux outputs AppImage and DEB packages. x64 and arm64 artifacts use architecture-qualified filenames. Tags matching `v*` trigger the GitHub Actions release workflow and publish all three operating-system builds.

Build and verify everything locally:

```bash
pnpm verify
pnpm --filter @codex-monitor/desktop dist
```

## Privacy

Only numeric usage and bounded metadata (device, model, project hash, session id and timestamps) are synchronized. Authentication files and conversation content are not read into snapshots. Model checks use a fixed `OK` prompt inside Electron's isolated main process; credentials are never exposed to the renderer or Hub.

The model catalog and verification adapter follows the account-scoped discovery and strict upstream-model comparison approach used by [codex-model-tester](https://github.com/X-Immortal/codex-model-tester). Codex private endpoints are treated as an optional, failure-isolated enhancement.

## License

MIT
