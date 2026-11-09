# What the hourly routine does

The cloud routine that keeps the Claude tracker current reads this file and
follows it. Its own prompt carries only the artifact's URL; everything else is
here, so the procedure can be corrected with a commit rather than by editing a
routine.

**Why this job exists.** The artifact page cannot fetch anything. Its sandbox
runs under `default-src 'none'`, so even a request to cdnjs is refused — pointing
the page straight at the feed was tried and the browser blocked it. The page's
own database is the only way figures reach it, and only a Claude session can
write that database. GitHub Actions publishes the figures every five minutes;
this job carries them the last step.

Use the **ArtifactData** tool for every database call, with the artifact URL from
your prompt. Reply with one line.

## 1. Where the feed is, and the key to read it

ArtifactData `get`, collection `config`, doc_id `cloudfeed`. It holds:

- `url` — the published feed
- `key` — its password

If that document is missing, stop and say so. Do not guess either value, and do
not write them into any file in this repository.

## 2. Turn the feed into documents

```
node feed-to-claude.js "<url>" "<key>" claude-feed
```

It fetches the feed, decrypts it, and writes one JSON file per document under
`claude-feed/`, plus `claude-feed/PLAN.json` listing every collection, `doc_id`
and `file_path`. If it exits non-zero, stop and report its last line — a partial
write is worse than a late one.

## 3. Read the current versions

For each of `campaigns`, `snapshots`, `daily`, `sierra` and `creatives`, call
ArtifactData `list` with that collection and note each document's `version`. A
write to a document that already exists is refused without the right
`if_version`, which is the point: it means two writers can never silently
overwrite each other.

## 4. Apply the writes

One ArtifactData `batch`, using the entries in `PLAN.json`:

- `op`: `"set"` for every document, with its `collection`, `doc_id` and
  `file_path` exactly as the plan gives them
- `if_version`: the version from step 3 for a document that already exists;
  leave it out entirely for one that does not
- a batch takes at most 50 entries — if the plan is longer, send it in several
  batches, each all-or-nothing

Then **delete** any document in `creatives` whose id is not in `PLAN.json`'s
`live` list: those ads have stopped running, and the tab should only ever show
what is live. Pin each delete with its version too.

If a write is refused because a version moved, re-list that collection and redo
only that write. Never pass `force`.

## What this job must not touch

- **`config/live`** — leave it absent. It is what the page itself would read, and
  the page cannot fetch, so setting it only produces an error banner.
- **The `quality` field on any lead** (Deal, Qualified, Junk). Those are typed in
  by hand and exist nowhere else. `feed-to-claude.js` does not write them and the
  page merges the database's own tags over the feed, so there is nothing to do
  here except not interfere.
- **`config/cloudfeed`** — read it, never rewrite it.

## The one line you reply with

Something like:

> Updated — this week $345.99, 3 leads; figures as of 21:09 UTC; 3 ads live.

Take the figures from `PLAN.json` (`figuresAt`) and from the campaign documents
you wrote. If anything was skipped or refused, say which, plainly.
