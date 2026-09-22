# Codex Monitor

Codex Monitor is a local-first desktop application for inspecting Codex token usage across machines and verifying the real upstream model used by Codex. Prompts, responses, tool output, and source code never enter usage snapshots or Hub synchronization.

## Features

- Codex session, model, project, cache, reasoning and output-token analytics
- Persistent history that survives deletion of source sessions
- Authenticated LAN hub, SSE live updates and offline agent upload queue
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

Run a LAN hub:

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

Set the same two variables before `pnpm dev` or before launching the packaged desktop application to make that desktop upload its local snapshot and subscribe to the fleet SSE stream.

Build and verify everything:

```bash
pnpm verify
pnpm --filter @codex-monitor/desktop dist
```

## Privacy

Only numeric usage and bounded metadata (device, model, project hash, session id and timestamps) are synchronized. Authentication files and conversation content are not read into snapshots. Model checks use a fixed `OK` prompt inside Electron's isolated main process; credentials are never exposed to the renderer or Hub.

The model catalog and verification adapter follows the account-scoped discovery and strict upstream-model comparison approach used by [codex-model-tester](https://github.com/X-Immortal/codex-model-tester). Codex private endpoints are treated as an optional, failure-isolated enhancement.

## License

MIT
