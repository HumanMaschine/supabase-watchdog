# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0.0] - 2026-03-30

### Changed (post-release)
- Moved all source files into `src/` directory, `main.ts` remains at root
- Moved all test files into `tests/` directory
- Fixed Deploy to Deno button URL in README
- Removed `watchdog.config.yaml` from git tracking (was leaking project refs)
- Updated `.env.example` with all v0.2 environment variables

### Added
- Status dashboard at `/` with health matrix, stat cards, recent polls table
- `/healthz` JSON endpoint for external monitoring (Healthy/Late/Down states)
- Deno KV persistence for poll history, dedup state, health status, daily stats
- Telegram webhook transport for Deno Deploy (explicit via `WATCHDOG_TELEGRAM_MODE`)
- Environment variable config fallback (no YAML needed for Deno Deploy)
- Two-mode startup: setup page when unconfigured, dashboard when configured
- Setup page with per-variable status indicators and helper links
- Setup page auto-refresh (polls `/healthz`, redirects when configured)
- Supabase token validation on startup
- Optional dashboard auth via `WATCHDOG_DASHBOARD_TOKEN`
- Structured JSON logging (`logger.ts`)
- Dark mode support (follows OS `prefers-color-scheme`)
- Responsive layout (single-column below 640px)
- `DESIGN.md` with design system tokens
- "Deploy to Deno Deploy" button in README
- Docker KV volume mount documentation
- 39 tests across 6 test files

### Changed
- Extracted pipeline orchestration from `main.ts` to `pipeline.ts`
- `main.ts` is now a thin entry point (config, mode detection, service init)
- Config loading returns `ConfigResult` type instead of throwing on missing config
- Default sources updated from 6 to 7 (added `supavisor_logs`)
- Deduplication is now KV-backed (persists across process restarts)
- `lastPollTime` persists in KV (survives Deno Deploy cold starts)
- Dockerfile includes `--unstable-cron` and `--unstable-kv` flags

### Fixed
- Template rendering uses single-pass regex (prevents injection via project names)
- Webhook secret uses constant-time comparison
- Dashboard auth uses constant-time comparison and checks exempt paths first
- `parseInt` on env vars validates for NaN
- `WATCHDOG_TELEGRAM_MODE` validates against `webhook`/`polling` (rejects typos)
- Deletes existing webhook before starting polling mode (prevents silent command failure)
- `setupWebhook` and `deleteWebhook` consume response bodies (prevents resource leaks)
