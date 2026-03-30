# Supabase Watchdog

Lightweight error monitoring for Supabase projects. Polls the Supabase Management API for error-level events across all services and delivers alerts to Telegram. Includes a status dashboard and one-click deploy.

Built for Pro-plan users who need alerting without a $599+/month Team plan.

[![Deploy to Deno Deploy](https://deno.com/deno-deploy-button.svg)](https://dash.deno.com/new?url=https://github.com/HumanMaschine/supabase-watchdog&entrypoint=main.ts)

## Features

- Monitors all Supabase log sources: Edge Functions, Auth, Postgres, Storage, Realtime, API Gateway, Supavisor
- Status dashboard with health matrix, poll history, and daily stats
- `/healthz` JSON endpoint for external monitoring
- Telegram alerts with HTML formatting and rate limiting
- Interactive bot commands (`/check`, `/errors`, `/status`, `/help`)
- Cross-restart deduplication via Deno KV persistence
- Webhook support for Deno Deploy (auto or explicit mode)
- Two config paths: YAML for Docker, environment variables for Deno Deploy
- One-click deploy to Deno Deploy with guided setup page
- Dark mode (follows OS preference)

## Quick Start — Deno Deploy (Recommended)

1. Click the **Deploy to Deno Deploy** button above
2. The app starts and shows a setup page at your deploy URL
3. Add environment variables in the Deno Deploy dashboard:
   - `SUPABASE_ACCESS_TOKEN` — [get it here](https://supabase.com/dashboard/account/tokens)
   - `TELEGRAM_BOT_TOKEN` — [create via @BotFather](https://t.me/BotFather)
   - `TELEGRAM_CHAT_ID` — [find via @userinfobot](https://t.me/userinfobot)
   - `WATCHDOG_PROJECTS` — format: `ref:name,ref:name`
   - `WATCHDOG_TELEGRAM_MODE` — set to `webhook` for Deno Deploy
   - `WATCHDOG_BASE_URL` — your deploy URL (e.g. `https://your-app.deno.dev`)
4. The app restarts automatically and begins monitoring

## Quick Start — Docker / Local

1. **Clone and configure**
   ```bash
   git clone https://github.com/HumanMaschine/supabase-watchdog
   cd supabase-watchdog
   cp watchdog.config.example.yaml watchdog.config.yaml
   # Edit watchdog.config.yaml with your project refs
   ```

2. **Set environment variables**
   ```bash
   export SUPABASE_ACCESS_TOKEN="sbp_your_token"
   export TELEGRAM_BOT_TOKEN="your_bot_token"
   export TELEGRAM_CHAT_ID="your_chat_id"
   ```

3. **Run**
   ```bash
   deno task start
   ```

## Prerequisites

- [Deno](https://deno.land/) v2.x or later
- A Supabase account with a [personal access token](https://supabase.com/dashboard/account/tokens)
- A Telegram bot (created via [@BotFather](https://t.me/BotFather))

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your Chat ID

1. Add your bot to a group, or send it a direct message
2. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Look for `"chat":{"id": ...}` in the response — that number is your chat ID
4. Group IDs are negative (e.g. `-1001234567890`), personal chats are positive

### 3. Get Your Supabase Access Token

1. Go to [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
2. Generate a new personal access token
3. This token has full org management access — treat it as a secret

### 4. Set Environment Variables

Copy the example and fill in your values:

```bash
cp .env.example .env
```

Or export directly:

```bash
export SUPABASE_ACCESS_TOKEN="sbp_..."
export TELEGRAM_BOT_TOKEN="123456:ABC..."
export TELEGRAM_CHAT_ID="-100..."
```

### 5. Edit Configuration

```bash
cp watchdog.config.example.yaml watchdog.config.yaml
```

At minimum, update the `projects` section with your project ref(s). Find your project ref in the Supabase dashboard URL: `https://supabase.com/dashboard/project/<ref>`.

```yaml
projects:
  - ref: "abcdefghijkl"
    name: "my-app-prod"
```

## Deployment

### Deno Deploy (Recommended)

Deno Deploy natively supports `Deno.cron()`, making it the simplest deployment option.

1. Install [`deployctl`](https://docs.deno.com/deploy/manual/deployctl):
   ```bash
   deno install -gArf jsr:@deno/deployctl
   ```

2. Set environment variables in the [Deno Deploy dashboard](https://dash.deno.com/) under your project's settings

3. Deploy:
   ```bash
   deno task deploy
   ```

   Or link your GitHub repo in the Deno Deploy dashboard for automatic deploys on push.

### Docker

Build and run with Docker:

```bash
# Build the image
docker build -t supabase-watchdog .

# Run with env vars, mounted config, and persistent KV storage
docker run -d \
  --name watchdog \
  -e SUPABASE_ACCESS_TOKEN=sbp_... \
  -e TELEGRAM_BOT_TOKEN=123456:ABC... \
  -e TELEGRAM_CHAT_ID=-100... \
  -v ./watchdog.config.yaml:/app/watchdog.config.yaml:ro \
  -v watchdog-data:/app/.deno-kv \
  supabase-watchdog
```

**Docker Compose example:**

```yaml
services:
  watchdog:
    build: .
    restart: unless-stopped
    environment:
      - SUPABASE_ACCESS_TOKEN=sbp_...
      - TELEGRAM_BOT_TOKEN=123456:ABC...
      - TELEGRAM_CHAT_ID=-100...
    volumes:
      - ./watchdog.config.yaml:/app/watchdog.config.yaml:ro
      - watchdog-data:/app/.deno-kv

volumes:
  watchdog-data:
```

> **Note:** The `watchdog-data` volume persists poll history, dedup state, and health status across container restarts. Without it, KV data resets on every restart.

```bash
docker compose up -d
```

### Local / Any Deno Runtime

```bash
# Development (with watch mode — restarts on file changes)
deno task dev

# Production
deno task start
```

## Bot Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/check` | Poll all projects for errors now | `/check` |
| `/check <project>` | Poll a specific project by name or ref | `/check my-app-prod` |
| `/errors <timeframe>` | Show errors from last N minutes/hours | `/errors 30m`, `/errors 2h` |
| `/status` | Show monitoring status | `/status` |
| `/help` | List available commands | `/help` |

## Configuration Reference

All configuration lives in `watchdog.config.yaml`. Environment variables are referenced with `${VAR_NAME}` syntax and resolved at startup.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `supabase.access_token` | string (env ref) | **required** | Supabase personal access token |
| `projects[].ref` | string | **required** | 12+ char project reference ID |
| `projects[].name` | string | **required** | Human-readable project name |
| `projects[].severity` | string | (none) | Minimum severity to alert: `info`, `warning`, `error`, `critical` |
| `polling.interval` | duration | `"5m"` | Polling frequency (e.g., `"5m"`, `"1h"`) |
| `polling.sources` | string[] | all 7 sources | Which log sources to query |
| `filters.min_status_code` | number | `500` | Minimum HTTP status code for errors |
| `filters.ignore_patterns` | string[] | `[]` | Patterns to exclude (substring match) |
| `filters.max_alerts_per_interval` | number | `20` | Max alerts per poll cycle |
| `channels.telegram.bot_token` | string (env ref) | **required** | Telegram bot token |
| `channels.telegram.chat_id` | string (env ref) | **required** | Target chat/group ID |

### Available Log Sources

- `edge_logs` — Edge Functions
- `auth_logs` — Authentication (GoTrue)
- `postgres_logs` — PostgreSQL
- `storage_logs` — Storage
- `realtime_logs` — Realtime
- `postgrest_logs` — PostgREST (API Gateway)
- `supavisor_logs` — Supavisor (connection pooler)

## Architecture

```
                    ┌─── SETUP MODE: serve setup page at /
                    │
main.ts → config → ─┤
                    │
                    └─── MONITORING MODE:
                         ├── Deno.cron() → pipeline.runPollCycle()
                         │     Source.poll() → Dedup (KV) → Process → Send → Log (KV)
                         ├── HTTP server: / (dashboard), /healthz, /telegram-webhook
                         └── Telegram bot (webhook or long-polling)
```

- **Sources** (`sources/`) — poll external APIs for errors. Currently: Supabase Management API.
- **Processors** (`processors/`) — transform/enrich error events. Currently: passthrough.
- **Channels** (`channels/`) — deliver alerts. Telegram (alerts + interactive bot commands).
- **State** (`state.ts`) — Deno KV persistence for poll history, dedup, health status, daily stats.

## Troubleshooting

**Bot not receiving messages / commands not working**
- Make sure you sent a message to the bot first (or added it to the group) before checking `getUpdates`
- Verify `TELEGRAM_CHAT_ID` matches the chat where you're sending commands
- If using a group, make sure the bot has permission to read messages (disable privacy mode via BotFather: `/setprivacy` → Disable)

**"environment variable is not set" error on startup**
- Ensure all three env vars are exported: `SUPABASE_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- If using Docker, pass them with `-e` flags or in your compose file
- Check for typos in your `watchdog.config.yaml` `${...}` references

**No alerts received but no errors either**
- Run `/check` in Telegram to trigger an immediate poll
- Check that your `projects[].ref` matches your actual Supabase project ref (12+ alphanumeric chars from the dashboard URL)
- Lower `filters.min_status_code` temporarily (e.g., to `400`) to catch more events

**Rate limit errors from Supabase API**
- The Management API allows 120 requests per minute (org-wide). If you monitor many projects, increase `polling.interval`
- Each project queries multiple log sources per poll cycle

## Limitations

- **5-minute default polling delay** — not real-time monitoring. Adjust `polling.interval` as needed (minimum 1 minute).
- **24-hour max query window** — the Supabase Management API only returns logs from the last 24 hours.
- **120 req/min rate limit** — shared across all Management API consumers in your org.
- **Telegram only** — v0.2 supports Telegram as the sole notification channel. Discord, Slack, and webhooks are planned for v0.3.

## License

TBD
