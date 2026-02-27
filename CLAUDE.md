# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Supabase Watchdog is an open-source error monitoring and alerting tool for Supabase projects. It polls the Supabase Management API for error logs across all services (Edge Functions, Auth, Postgres, Storage, Realtime, API Gateway) and sends alerts via Telegram (with Discord/Slack planned). Targets Pro-plan users who lack native alerting without $599+/month Team plans.

**Status:** Pre-implementation (design/planning phase). Vision spec is complete; no source code exists yet.

## Tech Stack

- **Runtime:** Deno (uses `Deno.cron()` for scheduling)
- **Language:** TypeScript
- **Deployment:** Deno Deploy (primary), Docker, or any Deno runtime
- **Configuration:** YAML (`watchdog.config.yaml`)

## Architecture

Three-layer plugin pipeline: **Sources → Processors → Channels**

- **Sources** (`sources/`) — poll external APIs for errors. MVP: Supabase Management API.
- **Processors** (`processors/`) — transform/enrich error events before delivery. MVP: passthrough.
- **Channels** (`channels/`) — deliver alerts to users. MVP: Telegram bot (alerts + interactive commands).

Core data flow: `Cron trigger → Source.poll() → Deduplicate/filter → Processor.process() → Channel.send()`

Key interfaces defined in vision spec: `ErrorEvent`, `Source`, `Processor`, `ProcessedEvent`, `Channel`.

## Planned Project Structure

```
main.ts              # Entry point: cron setup, bot init, orchestration
config.ts            # Config loading and validation
types.ts             # Shared interfaces
sources/mod.ts       # Source interface
sources/supabase.ts  # Management API poller
processors/mod.ts    # Processor interface
processors/passthrough.ts
channels/mod.ts      # Channel interface
channels/telegram.ts # Telegram bot (alerts + commands)
```

## Documentation System

Documentation lives in `docs/` as an Obsidian vault with wikilink navigation. Use the `/doc` skill to create and manage documents — it handles frontmatter, navigation callouts, bidirectional links, and template structure.

Document types: **spec** (design), **plan** (implementation roadmap), **phase** (build brief), **addendum** (enhancement delta). See `.claude/skills/doc/skill.md` for the full schema and templates.

Key rule: original docs are history — never delete completed phase briefs. Use addendums for enhancements, new phase briefs (e.g., `3b`) for reworks.

## Technical Constraints

- **Supabase Management API:** 120 req/min rate limit (org-wide), max 24h query window, endpoint is experimental
- **Telegram:** 30 msg/sec to different chats, 20 msg/min to same group, 4096 char message limit
- **Security:** Supabase access token has full org management access — must be env var, never in config. Tool is read-only.

## Environment Variables

```
SUPABASE_ACCESS_TOKEN   # From supabase.com/dashboard/account/tokens
TELEGRAM_BOT_TOKEN      # Telegram bot token
TELEGRAM_CHAT_ID        # Target chat/group ID
```
