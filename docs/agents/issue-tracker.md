# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on `txc0ld/tmx`.

## Conventions

- Create issues with `gh issue create --title "..." --body "..."`.
- Read issues with `gh issue view <number> --comments`.
- List issues with `gh issue list --state open --json number,title,body,labels,comments`.
- Comment with `gh issue comment <number> --body "..."`.
- Apply labels with `gh issue edit <number> --add-label "..."`.
- Remove labels with `gh issue edit <number> --remove-label "..."`.
- Close with `gh issue close <number> --comment "..."`.

Run `gh` commands from inside this clone so the repo is inferred from `origin`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `txc0ld/tmx`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
