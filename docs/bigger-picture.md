---
type: spec
domain: vision
status: draft
version: 0.2.0
parent: "[[vision-spec]]"
tags:
  - watchdog/vision
  - watchdog/strategy
---

> [!nav] Navigation
> **Parent:** [[vision-spec|Vision Spec]]

# Supabase Watchdog — Bigger Picture

**Last Updated:** 2026-03-26
**Status:** Draft

---

## The Gap

Supabase has no built-in alerting for error logs. The existing options for Pro-plan users ($25/mo) are:

| Approach | What it covers | Cost |
|---|---|---|
| Supabase Log Drains | All services (push-based) | $60/mo per drain + external alerting tool |
| Sentry | App-layer only (SDK instrumentation) | Free tier available, but no Supabase service coverage |
| Grafana / Datadog | Postgres metrics only | Free self-hosted, but no Auth/Edge/Storage/Realtime |
| Supabase Team plan | Everything | $599/mo |

**No existing tool polls the Supabase Management API for cross-service error logs and sends alerts.** This is an unoccupied niche.

Supabase Watchdog fills it: unified error monitoring across all six Supabase services (Edge Functions, Auth, Postgres, Storage, Realtime, API Gateway), delivered as alerts — for free.

---

## Distribution Model

The project is **fully self-hosted**. Users bring their own accounts, tokens, and infrastructure. There is no central server, no shared database, and no hosting costs for the maintainer.

Each user provides:
- A Deno Deploy account (free) or their own Docker host
- A Supabase personal access token
- A Telegram bot token (and later Discord/Slack credentials)

What the project ships:
- Source code + documentation
- YAML config template
- Dockerfile for containerized deployment
- "Deploy to Deno Deploy" button for one-click setup

### One-Click Deploy

A deploy button in the README sends users straight to Deno Deploy:

```markdown
[![Deploy on Deno](https://deno.com/button)](https://console.deno.com/new?clone=https://github.com/<org>/supabase-watchdog)
```

This clones the repo to the user's GitHub, creates a Deno Deploy project, and deploys automatically. The user then adds three environment variables in the Deno Deploy dashboard. No config file to host, no infrastructure to maintain.

**Limitation:** Unlike Heroku or Vercel, Deno Deploy's button does not prompt for environment variables during the flow. A first-run check in the app that detects missing env vars and shows setup instructions (instead of crashing) would smooth this out.

### Hosting Options for End Users

| Option | Best for | Tradeoffs |
|---|---|---|
| **Deno Deploy** (recommended) | Most users — zero infrastructure | Free tier (1M req/mo), native `Deno.cron()`, one-click deploy |
| **Docker** | Users wanting full control or private networks | Requires always-on host (VPS, home server) |
| **Any Deno runtime** | Power users, custom setups | Manual process management |

The key constraint is that this is a **polling application** — it needs to run continuously or on a cron schedule. Deno Deploy handles this natively. Serverless scale-to-zero platforms are not a fit unless they support persistent cron.

---

## Evolution Beyond MVP

The MVP delivers Telegram-only alerting with YAML config. The bigger picture expands along two axes: **more channels** and **a lightweight UI**.

### More Alert Channels

Adding Discord, Slack, and webhook support broadens the audience significantly. The plugin architecture (Sources → Processors → Channels) already supports this — each channel is a single file implementing the `Channel` interface.

| Channel | Priority | Complexity | Audience impact |
|---|---|---|---|
| Discord webhook | High | Low (HTTP POST) | Large — many dev teams use Discord |
| Slack webhook | High | Low (HTTP POST) | Large — standard for professional teams |
| Generic webhook | Medium | Low | Enables custom integrations (PagerDuty, Opsgenie, etc.) |
| Email digest | Low | Medium (SMTP or API) | Useful for daily/weekly summaries |

### Minimal Status Dashboard

Not a full monitoring UI — a lightweight web page served by the same Deno process that handles two problems:

1. **Setup wizard** — guides users through adding env vars and config after one-click deploy (solves the Deno Deploy UX gap)
2. **Status page** — shows whether polling is active, last poll time, recent errors found, alerts sent

This keeps the project lightweight while making it feel polished. Deno Deploy serves HTTP natively, so this adds near-zero infrastructure cost.

**Explicitly out of scope:** error history charts, log viewer, alert rule builder, user auth. That's a different product (Sentry, Betterstack, etc.).

### AI-Powered Analysis (Roadmap)

The processor layer is designed for this. Future processors could:
- Classify error severity automatically
- Generate root cause hypotheses
- Suggest fixes based on error patterns
- Power natural language queries against Supabase logs via the Telegram bot

---

## Roadmap Overview

```
v0.1 (MVP) ✅ — Telegram alerting, YAML config, Deno Deploy + Docker
    │
v0.2 — Additional channels (Discord, Slack, webhooks)
    │
v0.3 — Minimal status dashboard + setup wizard
    │
v0.4 — Smarter alerting (cross-window dedup, error grouping, severity levels, history)
    │
v0.5 — AI-powered error analysis (LLM processor plugin)
    │
v0.6 — Conversational analytics (natural language log queries via Telegram)
    │
v0.7 — AI agent integration (codebase-aware triage, auto-fix PRs)
```

---

## Competitive Position

Supabase Watchdog is the only free, open-source tool that provides cross-service error alerting for Supabase Pro-plan users. The competitive moat is narrow (the Management API is public), but the project has first-mover advantage in an underserved niche.

**Strengths:**
- Only tool that monitors all six Supabase log sources via the Management API
- Free and self-hosted — no vendor lock-in, no recurring cost
- One-click deploy lowers the barrier to near zero
- Plugin architecture supports community-contributed channels and processors

**Risks:**
- Supabase could ship native alerting on Pro plans (most likely long-term outcome)
- The Management API logs endpoint is marked experimental and could change
- Log Drains dropping in price ($60/mo currently) could reduce the value proposition

**Mitigation:** Stay lightweight, stay free, move fast. If Supabase ships native alerting, the project still has value as a multi-project unified view with AI analysis — features Supabase is unlikely to build.

---

## Open Questions

| # | Question | Context |
|---|---|---|
| 1 | **Project name** | "Supabase Watchdog" works but references Supabase directly. Alternatives: `supawatch`, `supamon`. Generic name allows future expansion to other platforms. |
| 2 | **License** | MIT for maximum adoption? AGPL to ensure contributions stay open? |
| 3 | **State persistence** | Deno KV (free on Deno Deploy) for dedup/history, or keep stateless? Needed for the status dashboard. |
| 4 | **Config format** | YAML works for power users but conflicts with one-click deploy simplicity. Should the dashboard replace YAML config entirely? |
| 5 | **Supabase Marketplace** | Listing on "Made with Supabase" / Supabase integrations page would drive adoption. Worth pursuing after v0.2. |
