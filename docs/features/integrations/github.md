# GitHub Integration

> Assigned issues + PRs → tasks.

## What it is

Pulls GitHub issues and pull requests assigned to you (optionally scoped to a single repo). Each becomes a task with a direct link back to the GitHub page.

## Setup

1. Create a [Personal Access Token](https://github.com/settings/tokens) with `repo` (private) or `public_repo` (public) scope.
2. Command Palette → "Add MCP Connection" → GitHub → paste token.
3. Optional: enter **Repo** as `owner/name` to scope — leave blank for all assigned across your account.

## Power moves

- **Single-repo triage.** Scope to one repo, wire Todo → Claude. Every new PR auto-prompts Claude with the title + URL.
- **Unscoped firehose.** Leave the repo field blank for everything assigned to you across all repos — useful for multi-project maintainers.
- **Combine with Git tile.** GitHub issues in Todo, local branch state in the [Git tile](../tiles/git.md) — stay aware of both remote tickets and local changes.

## Tech notes

- URL builder: `buildGitHubIssuesUrl(repo?)`:
  - With repo: `https://api.github.com/repos/${owner}/${name}/issues?state=open&per_page=20` — repo validated against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
  - Without: `https://api.github.com/issues?filter=assigned&state=open&per_page=20`.
- Header: `Authorization: Bearer ${token}`, `Accept: application/vnd.github.v3+json`.
- Response filters include both issues and PRs (`pull_request` key present). Task text is `#${number} ${title}`; `url` = `html_url`.
- Backoff + per-connection error toasts apply.

**Key files:** `src/stores/mcpStore.ts` (buildGitHubIssuesUrl, fetchGitHubTasks).

## Related

- [MCP overview](./overview.md) · [Todo tile](../tiles/todo.md) · [Git tile](../tiles/git.md)
