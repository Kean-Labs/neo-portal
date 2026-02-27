# OpenClaw Monitor Portal

Local dashboard for multi-agent OpenClaw runs on your Mac mini:

- Agent status (busy/idle/error)
- Jobs and sessions
- Token usage per agent
- Token usage per model
- 24-hour usage history (stored in SQLite)

## Run portal

```bash
npm run dev
```

Open: <http://localhost:4040>

## Optional API protection

Set a token before starting server:

```bash
PORTAL_API_TOKEN='your-secret-token' npm run dev
```

In the UI, enter the same token in the `API token` field and click `Save`.

For scripts/curl use `Authorization: Bearer <token>`.

## Storage

Events are persisted in SQLite (Node built-in `node:sqlite`):

- default DB path: `data/openclaw-metrics.db`
- customize with `OPENCLAW_DB_FILE=/absolute/path/file.db`

When server starts, it restores state from SQLite automatically.

## Push events directly

Endpoint:

- `POST /api/events`

Example:

```bash
./examples/push-event.sh
```

If token is enabled:

```bash
PORTAL_API_TOKEN='your-secret-token' ./examples/push-event.sh
```

## OpenClaw log collector (multi-agent forwarder)

Use this to ship events from an OpenClaw log file into the portal.

```bash
OPENCLAW_LOG_FILE=/path/to/openclaw.log \
PORTAL_URL=http://localhost:4040/api/events \
PORTAL_API_TOKEN='your-secret-token' \
npm run collector
```

The collector accepts:

1. One JSON event per line (recommended)
2. Loose key/value lines, e.g.:

```text
ts=2026-02-27T10:00:00Z type=heartbeat agentId=planner-1 model=gpt-4.1 jobId=job-1 sessionId=sess-1 inputTokens=120 outputTokens=55 cachedTokens=10
```

## Event shape

```json
{
  "ts": "2026-02-27T10:00:00.000Z",
  "type": "heartbeat",
  "agentId": "planner-1",
  "model": "gpt-4.1",
  "host": "mac-mini",
  "status": "busy",
  "jobId": "job-1001",
  "jobStatus": "running",
  "sessionId": "sess-9001",
  "sessionStatus": "active",
  "usage": {
    "inputTokens": 120,
    "outputTokens": 40,
    "cachedTokens": 10
  }
}
```

## API

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/history?hours=24` (1..168)
- `POST /api/events` (single event, array, or `{ "events": [...] }`)

If `PORTAL_API_TOKEN` is set, all API routes except `/api/health` require auth.
