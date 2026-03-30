# DESIGN.md — Supabase Watchdog

Minimal design system for the monitoring dashboard.

## Typography

- **Primary:** `system-ui, -apple-system, sans-serif`
- **Monospace:** `'SF Mono', 'Fira Code', ui-monospace, monospace`
- **Scale:** 11px labels, 12px small/mono, 13px table, 14px body, 16px banner, 18px h2, 24px h1/numbers

## Spacing

- **Base unit:** 4px
- **Scale:** 4, 8, 12, 16, 20, 24, 32, 48
- **Card padding:** 12px
- **Section gap:** 24px
- **Page padding:** 24px

## Colors (CSS variables)

```css
:root {
  --text:            #1a1a1a;
  --text-secondary:  #666;
  --text-muted:      #999;
  --bg:              #fafafa;
  --bg-card:         #fff;
  --border:          #e0e0e0;
  --status-ok:       #16a34a;
  --status-warn:     #eab308;
  --status-error:    #ef4444;
  --status-muted:    #9ca3af;
  --accent:          #3b82f6;
}
```

### Dark mode (`prefers-color-scheme: dark`)

```css
:root {
  --text:            #e5e5e5;
  --text-secondary:  #a3a3a3;
  --text-muted:      #737373;
  --bg:              #171717;
  --bg-card:         #262626;
  --border:          #404040;
  --status-ok:       #22c55e;
  --status-warn:     #facc15;
  --status-error:    #f87171;
  --status-muted:    #6b7280;
  --accent:          #60a5fa;
}
```

## Border Radius

- **Default:** 4px
- **Cards/banners:** 6px

## Status Indicators

- **Healthy:** green dot + "Healthy" text, subtle green background tint (3-5% opacity)
- **Late:** yellow dot + "Late" text, subtle amber background tint
- **Down:** red dot + "Down" text, subtle red background tint
- **Status dots:** 8px circles with matching border. Always paired with aria-label for a11y.

## Contrast

All text colors meet WCAG AA (4.5:1 minimum). Note: `--status-ok` in light mode uses `#16a34a` (not `#22c55e`) for sufficient contrast on white backgrounds.

## Responsive

- **Breakpoint:** 640px
- **< 640px:** stat cards → 2×2 grid, health matrix scrolls horizontally, polls table hides Duration column
- **Min-width:** 320px (iPhone SE)

## Accessibility

- Semantic HTML: `<main>`, `<header>`, `<table>` with `<th scope>`
- Status dots use `aria-label` (not color-only)
- Touch targets: 44px min height on interactive elements
- Keyboard: natural tab order, no custom focus traps

## UI Classifier

This is an **APP UI** — calm surface hierarchy, dense but readable, utility language, minimal chrome. Not a marketing page.
