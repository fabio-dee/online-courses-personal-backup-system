# Fork notes

This repository originated as a personal fork of [balmasi/skool-downloader](https://github.com/balmasi/skool-downloader) and is now maintained as an **independent downstream project**. Upstream is a read-only reference — useful fixes are cherry-picked when wanted, but this fork's `main` does not track upstream linearly anymore. The repo is renamed (`online-courses-personal-backup-system`) to avoid advertising itself as a Skool-specific downloader in search results.

## Branches

### Proposed upstream (open PRs)

- **`pr/reliability-fixes`** → upstream PR [#5](https://github.com/balmasi/skool-downloader/pull/5)
  4 bug-fix commits: platform-specific yt-dlp binary, fragment concurrency 16→4, member-only course filter fix, `.DS_Store` gitignore. Small, low-blast-radius.

- **`pr/update-detection`** → upstream PR [#6](https://github.com/balmasi/skool-downloader/pull/6)
  Stacked on `pr/reliability-fixes`. Adds content + video fingerprinting and an `--update` flag so re-runs only re-download genuinely-changed lessons. 5 additional commits.

- **`fix/download-reliability`** → upstream PR [#3](https://github.com/balmasi/skool-downloader/pull/3)
  The original combined form of the above two PRs. Left open because the maintainer may prefer the combined form; whichever merges first will trigger the others to close.

### Published but not yet proposed upstream

- **`feat/run-log-report`** (rebased on `pr/update-detection`)
  5 additional commits on top of PR #6: `skool log` subcommand, `NEW`/`UPDATED` badges in the generated `index.html` offline viewer, run-log + query-log modules, RunStats wiring in the lesson flow, and a fallback for missing video fingerprints (trust-local bootstrap).
  Usable today — pull the branch and `npm run build`. Will be proposed upstream after PRs #5 and #6 land.

## Downstream tooling (separate repo)

Python pipeline for turning a Skool scrape into an Obsidian-ready vault (Haiku tagging, wikilinks, Maps of Content) lives at **[fabio-dee/course-to-obsidian](https://github.com/fabio-dee/course-to-obsidian)**. It's a downstream adapter, not an upstream contribution. The `scripts/` directory on some branches of this fork still contains the Python files for convenience; the authoritative versions live in `course-to-obsidian`.

## Trunk & integration

`main` on `origin-public` is the authoritative trunk and already contains the integrated work from PRs #5, #6, and `feat/run-log-report`, plus downstream-only features (pinned-post fallback, rescrape helper). New features are developed on `feat/*` branches off `main` and merged back via `git merge --no-ff`. The private remote (`origin-private`) is a passive mirror of public — kept in sync via the `git pushboth` alias.

The frozen PR branches (`pr/reliability-fixes`, `pr/update-detection`, `fix/download-reliability`, `feat/run-log-report`) are left intact. They still back the open upstream PRs. They are never force-pushed or re-committed onto — if upstream ever merges one, the content already lives on `main` and no action is needed here.

## Cherry-picking upstream fixes

```bash
git fetch upstream
git log upstream/main --oneline --not main   # what's new upstream
git cherry-pick <sha>
git pushboth main
```
