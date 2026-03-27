import type { WatchdogConfig, DailyStats, PollCycleRecord, SourceHealthStatus } from "./types.ts";
import type { WatchdogState } from "./state.ts";
import { parseDuration } from "./config.ts";
import { log } from "./logger.ts";

// ── Types ────────────────────────────────────────────────────────────

interface ServerOptions {
  mode: "setup" | "monitoring";
  state?: WatchdogState;
  config?: WatchdogConfig;
  missing?: string[];
  /** Callback for Telegram webhook updates. Returns HTTP status code. */
  onTelegramWebhook?: (update: unknown, secretHeader: string | null) => Promise<{ status: number }>;
  port?: number;
}

interface HealthzResponse {
  status: "setup_required" | "healthy" | "late" | "down";
  configured: boolean;
  last_poll?: { timestamp: string; ok: boolean } | null;
  uptime_since?: string | null;
  projects?: number;
  daily_stats?: DailyStats;
  missing?: string[];
}

// ── Health state machine ─────────────────────────────────────────────

function computeHealthStatus(
  lastPoll: { timestamp: string; ok: boolean } | null,
  intervalMs: number,
): "healthy" | "late" | "down" {
  if (!lastPoll) return "healthy"; // First boot, no polls yet

  const elapsed = Date.now() - new Date(lastPoll.timestamp).getTime();
  const lateThreshold = intervalMs * 2;
  const downThreshold = intervalMs * 5;

  if (!lastPoll.ok) {
    return elapsed > downThreshold ? "down" : "late";
  }

  if (elapsed > downThreshold) return "down";
  if (elapsed > lateThreshold) return "late";
  return "healthy";
}

// ── Template rendering ───────────────────────────────────────────────

async function loadTemplate(name: string): Promise<string> {
  const path = new URL(`./${name}`, import.meta.url).pathname;
  return await Deno.readTextFile(path);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ── Setup page rendering ─────────────────────────────────────────────

function renderSetupPage(missing: string[]): string {
  const allVars = [
    { name: "SUPABASE_ACCESS_TOKEN", desc: "Supabase personal access token", link: "https://supabase.com/dashboard/account/tokens" },
    { name: "TELEGRAM_BOT_TOKEN", desc: "Telegram bot token", link: "https://t.me/BotFather" },
    { name: "TELEGRAM_CHAT_ID", desc: "Telegram chat/group ID", link: "https://t.me/userinfobot" },
    { name: "WATCHDOG_PROJECTS", desc: 'Project refs — format: "ref:name,ref:name"', link: "" },
  ];

  const optionalVars = [
    { name: "WATCHDOG_BASE_URL", desc: "Public URL for webhook mode (e.g. https://your-app.deno.dev)" },
    { name: "WATCHDOG_TELEGRAM_MODE", desc: '"webhook" or "polling" (default: polling)' },
    { name: "WATCHDOG_DASHBOARD_TOKEN", desc: "Optional token to protect this dashboard" },
    { name: "WATCHDOG_INTERVAL", desc: "Polling interval (default: 5m)" },
  ];

  const requiredRows = allVars.map((v) => {
    const isSet = !missing.includes(v.name);
    const icon = isSet ? "&#x2705;" : "&#x274C;";
    const linkHtml = v.link ? ` <a href="${v.link}" target="_blank" rel="noopener">[get it]</a>` : "";
    return `<tr><td>${icon}</td><td><code>${v.name}</code></td><td>${v.desc}${linkHtml}</td></tr>`;
  }).join("\n");

  const optionalRows = optionalVars.map((v) => {
    const val = Deno.env.get(v.name);
    const icon = val ? "&#x2705;" : "&#x2796;";
    return `<tr><td>${icon}</td><td><code>${v.name}</code></td><td>${v.desc}</td></tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Supabase Watchdog — Setup</title>
<style>
:root {
  --text: #1a1a1a; --text-secondary: #666; --text-muted: #999;
  --bg: #fafafa; --bg-card: #fff; --border: #e0e0e0;
  --status-warn: #eab308; --accent: #3b82f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --text: #e5e5e5; --text-secondary: #a3a3a3; --text-muted: #737373;
    --bg: #171717; --bg-card: #262626; --border: #404040;
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 24px; max-width: 700px; margin: 0 auto; line-height: 1.5; }
h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
.version { font-size: 12px; color: var(--text-muted); margin-bottom: 24px; }
.banner { background: rgba(234, 179, 8, 0.08); border: 1px solid var(--status-warn); border-radius: 6px; padding: 16px 20px; margin-bottom: 24px; }
.banner h2 { font-size: 16px; color: var(--status-warn); margin-bottom: 4px; }
.banner p { font-size: 14px; color: var(--text-secondary); }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px; }
th { text-align: left; font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 8px; border-bottom: 2px solid var(--border); }
td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
td:first-child { width: 30px; text-align: center; }
code { font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace; font-size: 13px; background: var(--bg); padding: 1px 4px; border-radius: 3px; }
a { color: var(--accent); }
.hint { font-size: 13px; color: var(--text-secondary); margin-top: 16px; padding: 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; }
.footer { font-size: 11px; color: var(--text-muted); text-align: center; margin-top: 32px; }
</style>
</head>
<body>
<h1>Supabase Watchdog</h1>
<div class="version">Setup Required</div>
<div class="banner">
  <h2>&#x26A0; Configuration Needed</h2>
  <p>Set the required environment variables to start monitoring.</p>
</div>
<h3 style="font-size:14px; margin-bottom:8px;">Required</h3>
<table>
  <thead><tr><th></th><th>Variable</th><th>Description</th></tr></thead>
  <tbody>${requiredRows}</tbody>
</table>
<h3 style="font-size:14px; margin-bottom:8px;">Optional</h3>
<table>
  <thead><tr><th></th><th>Variable</th><th>Description</th></tr></thead>
  <tbody>${optionalRows}</tbody>
</table>
<div class="hint">
  <strong>Deno Deploy:</strong> Add env vars in your project settings. The app restarts automatically after changes.<br>
  <strong>Docker:</strong> Copy <code>watchdog.config.example.yaml</code> to <code>watchdog.config.yaml</code> and fill in your values.
</div>
<div class="footer">Supabase Watchdog</div>
<script>
// Poll /healthz every 5s. When configured, redirect to dashboard.
setInterval(async () => {
  try {
    const r = await fetch("/healthz");
    const d = await r.json();
    if (d.configured) window.location.reload();
  } catch {}
}, 5000);
</script>
</body>
</html>`;
}

// ── Dashboard rendering ──────────────────────────────────────────────

async function renderDashboard(
  state: WatchdogState,
  config: WatchdogConfig,
  intervalMs: number,
): Promise<string> {
  const [lastPoll, stats, recentPolls, healthMatrix, startedAt] = await Promise.all([
    state.getLastPollTime(),
    state.getDailyStats(),
    state.getRecentPolls(20),
    state.getHealthMatrix(),
    state.getStartedAt(),
  ]);

  const healthStatus = computeHealthStatus(lastPoll, intervalMs);

  try {
    const template = await loadTemplate("dashboard.html");
    const vars = buildDashboardVars(healthStatus, lastPoll, stats, recentPolls, healthMatrix, config, startedAt);
    return renderTemplate(template, vars);
  } catch (err) {
    log.error("dashboard_template_error", { error: String(err) });
    return renderFallbackDashboard(healthStatus);
  }
}

function buildDashboardVars(
  healthStatus: string,
  lastPoll: { timestamp: string; ok: boolean } | null,
  stats: DailyStats,
  recentPolls: PollCycleRecord[],
  healthMatrix: Map<string, Map<string, SourceHealthStatus>>,
  config: WatchdogConfig,
  startedAt: string | null,
): Record<string, string> {
  const statusColors: Record<string, string> = {
    healthy: "#16a34a",
    late: "#eab308",
    down: "#ef4444",
  };
  const statusLabels: Record<string, string> = {
    healthy: "Healthy — watchdog is running",
    late: "Late — last poll exceeded expected interval",
    down: "Down — multiple poll failures or extended silence",
  };

  const lastPollAgo = lastPoll
    ? formatTimeAgo(new Date(lastPoll.timestamp))
    : "never";

  const uptimeStr = startedAt
    ? formatTimeAgo(new Date(startedAt))
    : "unknown";

  // Build health matrix HTML
  const sources = config.polling.sources;
  const sourceHeaders = sources.map((s) =>
    `<div class="matrix-cell header">${s.replace("_logs", "").replace("postgrest", "API")}</div>`
  ).join("\n");

  let matrixRows = "";
  for (const project of config.projects) {
    matrixRows += `<div class="matrix-cell project">${escapeHtml(project.name)}</div>\n`;
    for (const source of sources) {
      const status = healthMatrix.get(project.ref)?.get(source);
      const dotClass = status ? (status.ok ? "ok" : "err") : "";
      const label = status ? (status.ok ? "OK" : "Error") : "No data";
      matrixRows += `<div class="matrix-cell"><span class="dot ${dotClass}" aria-label="${label}"></span></div>\n`;
    }
  }

  // Build recent polls table HTML
  let pollRows = "";
  if (recentPolls.length === 0) {
    pollRows = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">No polls completed yet. First poll scheduled soon.</td></tr>`;
  } else {
    for (const poll of recentPolls) {
      const time = new Date(poll.started_at).toLocaleTimeString("en-US", { hour12: false });
      const duration = `${(poll.duration_ms / 1000).toFixed(1)}s`;
      const badge = poll.ok
        ? `<span class="badge ok">OK</span>`
        : `<span class="badge errors">${poll.errors_found} error${poll.errors_found !== 1 ? "s" : ""}</span>`;
      pollRows += `<tr><td class="mono">${time}</td><td class="mono">${duration}</td><td>${badge}</td><td>${poll.errors_found}</td><td>${poll.alerts_sent}</td></tr>\n`;
    }
  }

  const statusBgOpacity = healthStatus === "healthy" ? "0.03" : healthStatus === "late" ? "0.05" : "0.05";

  return {
    STATUS_COLOR: statusColors[healthStatus] || "#9ca3af",
    STATUS_BG_OPACITY: statusBgOpacity,
    STATUS_LABEL: statusLabels[healthStatus] || "Unknown",
    LAST_POLL_AGO: lastPollAgo,
    UPTIME: uptimeStr,
    INTERVAL: config.polling.interval,
    POLLS_TODAY: String(stats.polls),
    ERRORS_TODAY: String(stats.errors_found),
    ALERTS_TODAY: String(stats.alerts_sent),
    PROJECT_COUNT: String(config.projects.length),
    SOURCE_HEADERS: sourceHeaders,
    MATRIX_ROWS: matrixRows,
    MATRIX_COLS: String(sources.length + 1),
    POLL_ROWS: pollRows,
  };
}

function renderFallbackDashboard(status: string): string {
  return `<!DOCTYPE html><html><head><title>Supabase Watchdog</title></head>
<body style="font-family:system-ui;padding:24px;max-width:600px;margin:0 auto;">
<h1>Supabase Watchdog</h1>
<p>Dashboard rendering failed. Check logs for details.</p>
<p>Status: ${escapeHtml(status)}</p>
<p><a href="/healthz">/healthz</a> for JSON status.</p>
</body></html>`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

// ── Auth middleware ──────────────────────────────────────────────────

function checkAuth(request: Request, dashboardToken: string | undefined): Response | null {
  if (!dashboardToken) return null; // No auth configured

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (queryToken === dashboardToken || bearerToken === dashboardToken) {
    return null; // Auth passed
  }

  // /healthz is always accessible (for external monitors)
  if (url.pathname === "/healthz") return null;
  // Webhook endpoint uses its own auth (Telegram secret token)
  if (url.pathname === "/telegram-webhook") return null;

  return new Response("Unauthorized", { status: 401 });
}

// ── Server ───────────────────────────────────────────────────────────

export function startServer(options: ServerOptions): void {
  const { mode, state, config, missing, onTelegramWebhook, port = 8000 } = options;

  let intervalMs = 300_000;
  if (config) {
    try {
      intervalMs = parseDuration(config.polling.interval);
    } catch {
      // fallback to 5 minutes
    }
  }

  Deno.serve({ port, onListen: ({ hostname, port }) => {
    log.info("server_started", { hostname, port, mode });
  }}, async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Auth check (skips /healthz and /telegram-webhook)
    if (mode === "monitoring" && config?.dashboard_token) {
      const authResponse = checkAuth(request, config.dashboard_token);
      if (authResponse) return authResponse;
    }

    // Setup mode: only serve setup page and healthz
    if (mode === "setup") {
      if (url.pathname === "/healthz") {
        const body: HealthzResponse = {
          status: "setup_required",
          configured: false,
          missing,
        };
        return Response.json(body);
      }
      return new Response(renderSetupPage(missing || []), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Monitoring mode routes
    switch (url.pathname) {
      case "/": {
        if (!state || !config) {
          return new Response("State unavailable", { status: 503 });
        }
        const html = await renderDashboard(state, config, intervalMs);
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      case "/healthz": {
        if (!state || !config) {
          return Response.json({ status: "error", configured: true });
        }
        const [lastPoll, stats, startedAt] = await Promise.all([
          state.getLastPollTime(),
          state.getDailyStats(),
          state.getStartedAt(),
        ]);
        const healthStatus = computeHealthStatus(lastPoll, intervalMs);
        const body: HealthzResponse = {
          status: healthStatus,
          configured: true,
          last_poll: lastPoll,
          uptime_since: startedAt,
          projects: config.projects.length,
          daily_stats: stats,
        };
        return Response.json(body);
      }

      case "/telegram-webhook": {
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }
        if (!onTelegramWebhook) {
          return new Response("Webhook not configured", { status: 404 });
        }
        try {
          const update = await request.json();
          const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
          const result = await onTelegramWebhook(update, secretHeader);
          return new Response("OK", { status: result.status });
        } catch (err) {
          log.error("webhook_handler_error", { error: String(err) });
          return new Response("Internal error", { status: 500 });
        }
      }

      default:
        return new Response("Not found", { status: 404 });
    }
  });
}
