---
type: phase
domain: mvp
phase: 6
status: done
parent: "[[mvp/plan]]"
depends_on:
  - "[[mvp/phases/phase-4-orchestration]]"
tags:
  - watchdog/mvp
  - watchdog/phase
---

> [!nav] Navigation
> **Parent:** [[mvp/plan|MVP Implementation Plan]]
> **Spec:** [[mvp/spec|MVP Spec]]
> **Depends on:** [[mvp/phases/phase-4-orchestration|Phase 4: Orchestration]]
> **Prev:** [[mvp/phases/phase-5-bot-commands|Phase 5: Bot Commands]]
> **Next:** (none — final MVP phase)

# Watchdog — Phase 6: Deployment & Docs

## Context

```
vision-spec
  └── mvp/spec
        └── mvp/plan
              Phase 1: Foundation & Config  ✓
              Phase 2: Supabase Source      ✓
              Phase 3: Telegram Channel     ✓
              Phase 4: Orchestration        ✓
              Phase 5: Bot Commands         ✓
              ► Phase 6: Deployment & Docs (this document)
```

Supabase Watchdog is a lightweight error monitoring tool that polls the Supabase Management API for error-level events and delivers alerts to notification channels. This is the final MVP phase — it wraps the working application with deployment infrastructure and user-facing documentation.

Phases 1–5 built the complete application: config loading with YAML parsing and env interpolation (Phase 1), Supabase Management API source poller (Phase 2), Telegram channel with HTML alert formatting (Phase 3), `main.ts` orchestration with `Deno.cron()` scheduling and deduplication (Phase 4), and interactive bot commands — `/check`, `/errors`, `/status`, `/help` (Phase 5). The application is fully functional: it polls, deduplicates, processes, sends alerts, and responds to commands. But it lacks a `Dockerfile`, a `README`, and the deployment polish needed for someone to go from "clone" to "running" in under 5 minutes.

This phase creates the Dockerfile for self-hosted deployment, the `.env.example` template, the `README.md` with a complete setup guide, and finalises the `deno.json` tasks. After this phase, the MVP is complete and ready for public release.

No further phases follow — this is the end of the MVP plan. Future work (additional channels, smarts, AI analysis) belongs to new domains.

---

## Scope Boundaries

### This phase DOES:

- Create `Dockerfile` with a multi-stage build for Docker deployment
- Create `.env.example` listing all required environment variables with descriptions
- Create `README.md` with setup guide, configuration reference, deployment instructions (Deno Deploy + Docker + local), and bot command reference
- Add a `deploy` task to `deno.json` for Deno Deploy convenience
- Review and finalize `watchdog.config.example.yaml` (already complete from Phase 1 — verify it documents all options)

### This phase does NOT:

- Add CI/CD pipelines (GitHub Actions, etc.) — future enhancement
- Create automated tests — future enhancement
- Add a LICENSE file — pending open question from vision spec about MIT vs. other
- Implement additional notification channels — future channels domain
- Add a web dashboard or UI — future consideration
- Publish to any package registry or container registry — done manually after release

### Boundary details:

- The `README.md` is a practical setup guide, not marketing material. It should get a developer from zero to receiving alerts as quickly as possible.
- The `Dockerfile` assumes the user has already created `watchdog.config.yaml` and will mount it or build it into the image. It does not bake in any config.
- The `.env.example` is complementary to `watchdog.config.example.yaml` — the config file references `${ENV_VAR}` patterns, and `.env.example` documents what those variables should contain.

---

## Project Integration

This phase creates three new files and modifies one existing file. All new files are project-root documentation/deployment artifacts that don't affect the TypeScript source.

### Files modified

```
deno.json   ← Add "deploy" task
```

### New files

```
Dockerfile       ← Multi-stage Docker build
.env.example     ← Environment variable template
README.md        ← Setup guide and documentation
```

### Dependencies to add

No new dependencies.

---

## 1. Dockerfile

Multi-stage build using the official Deno Docker image. The build stage caches dependencies, and the runtime stage copies only what's needed.

```dockerfile
FROM denoland/deno:latest AS builder

WORKDIR /app

# Copy dependency manifest first for layer caching
COPY deno.json .
RUN deno install

# Copy source
COPY . .

# Cache dependencies
RUN deno cache main.ts

# --- Runtime stage ---

FROM denoland/deno:latest

WORKDIR /app

COPY --from=builder /app .

# Deno permissions: read config, access env vars, network for API calls
CMD ["deno", "run", "--allow-read", "--allow-env", "--allow-net", "main.ts"]
```

### 1.1 Usage

```bash
# Build
docker build -t supabase-watchdog .

# Run (mount config, pass env vars)
docker run -d \
  --name watchdog \
  -e SUPABASE_ACCESS_TOKEN=sbp_... \
  -e TELEGRAM_BOT_TOKEN=123456:ABC... \
  -e TELEGRAM_CHAT_ID=-100... \
  -v ./watchdog.config.yaml:/app/watchdog.config.yaml:ro \
  supabase-watchdog
```

### 1.2 Design Notes

- Uses `denoland/deno:latest` — the official Deno image, based on Debian slim.
- Two-stage build keeps the final image clean, though for Deno the benefit is mainly dependency caching.
- Config file is mounted at runtime (`-v`), not baked into the image — keeps secrets out of the image layer.
- The `--allow-read` permission is scoped to the workdir by default. `--allow-env` and `--allow-net` are needed for config interpolation and API calls.

---

## 2. Environment Variable Template

`.env.example` documents every environment variable the application expects:

```bash
# Supabase Watchdog — Environment Variables
# Copy this file to .env and fill in your values.

# Supabase personal access token
# Generate at: https://supabase.com/dashboard/account/tokens
SUPABASE_ACCESS_TOKEN=sbp_your_token_here

# Telegram bot token
# Create a bot via @BotFather on Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# Telegram chat or group ID where alerts will be sent
# Tip: send a message to your bot, then visit:
# https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
# Look for "chat":{"id": ...} in the response
TELEGRAM_CHAT_ID=-1001234567890
```

---

## 3. deno.json Updates

Add a `deploy` task for Deno Deploy. The existing `dev` and `start` tasks are already correct.

```jsonc
{
  "tasks": {
    "dev": "deno run --allow-read --allow-env --allow-net --watch main.ts",
    "start": "deno run --allow-read --allow-env --allow-net main.ts",
    "deploy": "deployctl deploy --prod main.ts"
  }
}
```

The `deploy` task assumes `deployctl` is installed globally. Users configure the Deno Deploy project via `deployctl` flags or the Deno Deploy dashboard.

---

## 4. README.md

The README follows a practical structure: what it is → quick start → detailed setup → deployment → commands → configuration reference.

### 4.1 Structure

```
# Supabase Watchdog

One-line description + key value props.

## Features
Bullet list of what it does.

## Quick Start
Numbered steps: clone → configure → run. Minimal path to first alert.

## Prerequisites
- Deno
- Supabase account with personal access token
- Telegram bot

## Setup

### 1. Clone & Configure
### 2. Create a Telegram Bot
### 3. Get Your Chat ID
### 4. Set Environment Variables
### 5. Edit Configuration

## Deployment

### Deno Deploy (Recommended)
### Docker
### Local / Any Deno Runtime

## Bot Commands
Table of /check, /errors, /status, /help with descriptions and examples.

## Configuration Reference
Full annotated config with every field, defaults, and descriptions.

## Architecture
Brief overview of the Source → Processor → Channel pipeline.

## Limitations
- 5-minute polling delay (not real-time)
- 24-hour max query window
- 120 req/min Management API rate limit
- Telegram only (MVP)

## License
TBD (pending open question)
```

### 4.2 Quick Start Section

The quick start should be copy-pasteable:

```markdown
## Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/<org>/supabase-watchdog
   cd supabase-watchdog
   ```

2. **Configure**
   ```bash
   cp watchdog.config.example.yaml watchdog.config.yaml
   # Edit watchdog.config.yaml with your project refs
   ```

3. **Set environment variables**
   ```bash
   export SUPABASE_ACCESS_TOKEN="sbp_your_token"
   export TELEGRAM_BOT_TOKEN="your_bot_token"
   export TELEGRAM_CHAT_ID="your_chat_id"
   ```

4. **Run**
   ```bash
   deno task start
   ```
```

### 4.3 Bot Commands Section

```markdown
## Bot Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/check` | Poll all projects for errors now | `/check` |
| `/check <project>` | Poll a specific project by name or ref | `/check my-app-prod` |
| `/errors <timeframe>` | Show errors from last N minutes/hours | `/errors 30m`, `/errors 2h` |
| `/status` | Show monitoring status | `/status` |
| `/help` | List available commands | `/help` |
```

### 4.4 Configuration Reference Section

Document every field with its type, default, and description. This should mirror the config types from `types.ts` but in human-readable table form:

```markdown
## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `supabase.access_token` | string (env ref) | **required** | Supabase personal access token |
| `projects[].ref` | string | **required** | 12+ char project reference ID |
| `projects[].name` | string | **required** | Human-readable project name |
| `projects[].severity` | string | (none) | Minimum severity to alert: info, warning, error, critical |
| `polling.interval` | duration | `"5m"` | Polling frequency (e.g., "5m", "1h") |
| `polling.sources` | string[] | all 6 sources | Which log sources to query |
| `filters.min_status_code` | number | `500` | Minimum HTTP status code for errors |
| `filters.ignore_patterns` | string[] | `[]` | Patterns to exclude (substring match) |
| `filters.max_alerts_per_interval` | number | `20` | Max alerts per poll cycle |
| `channels.telegram.bot_token` | string (env ref) | **required** | Telegram bot token |
| `channels.telegram.chat_id` | string (env ref) | **required** | Target chat/group ID |
```

### 4.5 Deployment Sections

**Deno Deploy:**
- Install `deployctl`
- Set environment variables in the Deno Deploy dashboard
- Run `deno task deploy` or link to GitHub for auto-deploys
- Note: `Deno.cron()` is natively supported

**Docker:**
- `docker build` and `docker run` commands with env vars and config mount
- Optional `docker-compose.yaml` example (inline in README, not a separate file)

**Local:**
- `deno task dev` for development with watch mode
- `deno task start` for production

---

## 5. Final Verification Checklist

Before considering the MVP complete, verify:

- [ ] `deno task start` runs without errors (with valid config + env vars)
- [ ] Cron triggers polls on schedule
- [ ] Telegram alerts are received with correct formatting
- [ ] `/check`, `/errors 5m`, `/status`, `/help` commands work
- [ ] `docker build` succeeds
- [ ] `docker run` starts and polls correctly
- [ ] `watchdog.config.example.yaml` documents all options
- [ ] `.env.example` lists all required variables
- [ ] `README.md` quick start is copy-pasteable

---

## Open Questions

| # | Question | Status | Leaning |
|---|----------|--------|---------|
| 1 | Should the README include a `docker-compose.yaml` example inline, or create a separate `docker-compose.yaml` file? | Open | Inline in README for MVP. A separate file adds clutter for a single-service stack. |
| 2 | Should the Dockerfile pin a specific Deno version (e.g., `denoland/deno:2.1.4`) or use `latest`? | Open | Pin a specific version for reproducibility. Update the version in the brief once a version is chosen. |
| 3 | Should the README include a "Troubleshooting" section for common issues (wrong token, bot not receiving messages, rate limits)? | Open | Yes — even a short FAQ section would save users time. Include 3–4 common issues. |
