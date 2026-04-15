# Jira Integration

> JQL-filtered tickets → tasks.

## What it is

Pulls Jira tickets matching a JQL query (default: assigned to you, not done). Each ticket becomes a task with a direct URL to the Jira browse page.

## Setup

1. Get an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Command Palette → "Add MCP Connection" → Jira → enter:
   - **Host** — e.g. `your-org.atlassian.net` (no `https://`)
   - **Email** — your Atlassian email
   - **API Token** — the one you just generated
3. Save.

## Power moves

- **Custom JQL.** A future release will expose the JQL field; currently fixed to `assignee=currentUser() AND status!=Done`.
- **Cross-project visibility.** Jira ties to your account, not a single project — all assigned tickets across Jira projects arrive.
- **Auto-dispatch.** Wire Todo → Claude with memory describing your codebase. Tickets become prompts with full implementation context.

## Tech notes

- URL builders:
  - Search: `buildJiraSearchUrl(host)` → `https://${host}/rest/api/3/search?jql=...&maxResults=20`
  - Browse (task.url): `buildJiraBrowseUrl(host, key)` → `https://${host}/browse/${encoded-key}`
- Host normalized to lowercase, validated `^[a-z0-9.-]{1,253}$`, rejects leading/trailing dot and `..`.
- Auth: Basic auth with `btoa(email + ':' + token)`.
- Ticket keys are URL-encoded to prevent path injection from an accidentally-weird key.

**Key files:** `src/stores/mcpStore.ts` (buildJiraSearchUrl, buildJiraBrowseUrl, fetchJiraTasks).

## Related

- [MCP overview](./overview.md) · [Todo tile](../tiles/todo.md)
