# TODOS

## P2 — Docker KV persistence documentation
**What:** Add README section explaining Deno KV volume mount for Docker (`-v watchdog-data:/app/.deno-kv`).
**Why:** Deno KV on Docker uses local filesystem. Container restart = state loss (poll history, dedupe, health).
**Context:** Depends on v0.2 shipping the KV layer. Users running Docker without volume mount will lose all KV state on restart.
**Effort:** S (human: ~30 min / CC: ~5 min)
**Depends on:** v0.2 (KV layer)

## P3 — Dynamic README health badge
**What:** `/badge` endpoint returning SVG showing watchdog status (healthy/late/down/setup_required).
**Why:** Cool show-off factor for open-source projects. Users embed in their project READMEs.
**Context:** Dashboard already shows status. Badge is a vanity feature — fun but not essential. Deferred from v0.2 cherry-pick ceremony.
**Effort:** S (human: ~2 hours / CC: ~5 min)
**Depends on:** v0.2 (HTTP server + health state machine)
