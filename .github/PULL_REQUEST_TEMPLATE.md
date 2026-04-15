## What

<!-- One-line summary of what this PR does -->

## Why

<!-- Motivation. What problem does this solve? -->

## How

<!-- High-level approach. Key files touched. -->

## Screenshots / GIFs

<!-- For UI changes, show before/after -->

## Testing

<!-- How did you test this? -->

- [ ] `npx tsc --noEmit` passes
- [ ] `pnpm tauri build` succeeds
- [ ] Tested on: <!-- Windows / macOS / Linux -->

## Checklist

- [ ] Code follows patterns in [CLAUDE.md](../CLAUDE.md)
- [ ] No inline `|| []` or `?? []` in Zustand selectors
- [ ] All Tauri calls routed through `utils/ipc.ts`
- [ ] No hardcoded colors (uses `colors.*` from tokens)
- [ ] New features added to `FEATURES.md`
- [ ] Architecture changes documented in `CLAUDE.md`
- [ ] Changelog entry added in `CHANGELOG.md`
