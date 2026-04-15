# Auto-Complete Detection

> Detect "the agent is done" without waiting for process exit.

## What it is

Two complementary triggers mark an agent's status as `done` so wires can fire while the agent process is still alive (and can be re-prompted):

1. **DONE sentinel** — configurable regex matched against output.
2. **Idle threshold** — no new output for N milliseconds after substantial activity.

## How it works in practice

- Agent starts → status `working`.
- First 3 seconds are a grace period (banner, welcome text, etc. ignored).
- Agent outputs text. Idle timer tracks time since last byte.
- Either: output contains `DONE` / `✅ DONE` / `[DONE]` / `## Done` → status → `done`.
- Or: no output for `idleThresholdMs` (default 8 s) after some activity → status → `done`.
- User sends next prompt → agent starts producing output again → status → `working` (loop).

## Power moves

- **Custom sentinel.** Edit `tile.doneSentinel` (regex string) to match your own completion marker. Useful if you train an agent to emit `FINAL_ANSWER:` or similar.
- **Tighten idle for impatience.** Drop `idleThresholdMs` to 3000 if your agents are fast and you want chains to fire quickly.
- **Disable for specific tiles.** Set `tile.autoComplete = false` if you want the agent to stay `working` until you manually mark done.
- **Chain amplification.** With auto-complete, a 3-agent chain runs hands-free — each agent's `done` fires the next without human intervention.

## Tech notes

- Default sentinel regex: `/(?:^|\n)\s*(?:[✅✓]\s*|\[|##\s*)?DONE(?:\]|!|\.)?\s*(?:$|\n|\r)/`. Case-insensitive multi-line.
- Idle detection uses a byte counter + timestamp. Small bursts (<10 bytes in 10 ms) don't reset the timer — prevents flapping on cursor movements or control sequences.
- Bad regex in `doneSentinel` is silently caught in try/catch — the tile gracefully falls back to idle-only detection.
- Status committed to `prevAgentStatusRef` at the top of each engine run — prevents re-entry if handlers re-trigger a subscription.

**Key files:** `src/components/tiles/AgentTile.tsx` (auto-complete detector), `src/hooks/useWiringEngine.ts` (status-transition handlers).

## Related

- [Agent tile](../tiles/agent.md) · [Agent-chain wire](../wiring/agent-chain.md) · [Refresh-trigger wire](../wiring/refresh-trigger.md)
