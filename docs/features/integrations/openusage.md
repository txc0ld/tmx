# OpenUsage Integration

> Real-time LLM API usage + cost.

## What it is

Optional external service ([openusage.dev](https://openusage.dev)) that tracks your LLM API usage across providers (OpenAI, Anthropic, etc.). When connected, TerminalX's [Usage tile](../tiles/usage.md) shows a live panel with per-provider token counts and dollar spend.

## Setup

1. Sign up at OpenUsage.
2. Run their local agent / set up API access per their docs.
3. Default endpoint is `http://127.0.0.1:6736/v1/usage` (local daemon). Configurable if you run their cloud version.
4. Nothing to enter in the TerminalX UI — it fetches on a schedule when present.

## Power moves

- **Multi-provider visibility.** One panel for OpenAI + Anthropic + whatever else you're calling. Compare burn rate across models.
- **Cost sanity.** After a day of heavy agent use, glance at the Usage tile — catch runaway costs before the monthly bill arrives.
- **Pair with internal tracker.** OpenUsage shows real API cost; TerminalX's internal estimator shows session tokens. Cross-reference.

## Tech notes

- Fetched via the [HTTP proxy](./http-proxy.md): `httpFetch({ url: 'http://127.0.0.1:6736/v1/usage', method: 'GET' })`. HTTP-to-loopback is explicitly allowed by the proxy's SSRF rules.
- Parsed as `OpenUsageProvider[]` — array of `{ name, tokens, cost, ... }`. Invalid responses (non-array, parse errors) set `openUsageError` and hide the panel.
- Polled every 30 s when the Usage tile is mounted. No background polling if no Usage tile exists.
- `openUsageConnected` flag drives the tile's "connected / error" indicator.

**Key files:** `src/stores/usageStore.ts` (fetchOpenUsage), `src/components/tiles/UsageTile.tsx`.

## Related

- [Usage tile](../tiles/usage.md) · [HTTP proxy](./http-proxy.md) · [MCP overview](./overview.md)
