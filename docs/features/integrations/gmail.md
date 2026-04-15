# Gmail Integration

> Unread emails → tasks.

## What it is

Surfaces unread Gmail messages as tasks — subject + sender. Clicking the task opens the message in Gmail's web UI.

## Setup

1. Enable the Gmail API in [Google Cloud Console](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
2. Create OAuth credentials for a desktop app.
3. Command Palette → "Add MCP Connection" → Gmail → complete OAuth flow.

## Power moves

- **Triage at canvas level.** Unread inbox lives next to your terminals — triage without leaving the workspace.
- **Filter by label.** Future release will expose label filtering; v1 pulls raw unread.
- **Auto-dispatch skeptically.** Be cautious wiring Gmail to an agent — random promo emails become prompts. Prefer manual dispatch or filter first.

## Tech notes

- Uses Gmail API `users.messages.list` with `q=is:unread`.
- OAuth token refresh handled via Google's standard flow; token cached per connection.
- Task text = `subject` + sender; `url` = `https://mail.google.com/mail/u/0/#inbox/${messageId}`.
- Privacy: only message metadata is pulled (subject + from), not body content. Opens in Gmail for the real read.

**Key files:** `src/stores/mcpStore.ts` (fetchGmailTasks).

## Related

- [MCP overview](./overview.md) · [Todo tile](../tiles/todo.md)
