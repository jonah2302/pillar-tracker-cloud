# One link, always current

The goal: a link you click — on the laptop, on your phone — that shows the
figures as they are right now, with nothing of yours running and nobody awake.

This folder is that. A Cloudflare Worker pulls Meta every minute and serves
both the figures and the tracker page itself, so opening the link fetches the
current numbers as it loads.

## Why it had to move off GitHub

GitHub Actions does the real work and keeps doing it. What it cannot do is run
often. `refresh.yml` asks for a run every five minutes — about 170 a day — and
GitHub delivers between four and ten. On 18 Nov the published figures were four
and a half hours old and nothing had gone wrong: the scheduler simply never
fired. Five minutes is also GitHub's documented floor, so "every minute" was
never on offer there at any price.

Cloudflare's cron does fire, on the minute, free.

| | runs | does |
|---|---|---|
| **This worker** | every minute | Meta spend, leads, day columns, live/paused |
| **GitHub Actions** | every 30 min | all of the above **plus** Sierra and the ad artwork |
| **GitHub Actions** | once a day | the full audit — every week and month back to Meta, to the cent |

The worker never builds a payload from nothing. It takes the last full one
Actions published as its base and overwrites four things per row: `spent`,
`leads`, the `days` map, and `status` where Meta's own on/off switch disagrees.
The pillar, the segment, the audience notes, the lead list, the client count,
Sierra, the artwork, the weekly history — all carried through untouched.

If the worker stops, you see the last Actions build. If Actions stops, the
worker keeps the figures current on yesterday's base. Neither failing takes the
tracker down.

## What it costs

Nothing. Free Workers: 100,000 requests a day and one-minute cron. This uses
~1,440 cron runs plus however often you open the link. KV's free allowance
covers one 650 KB value rewritten every minute and the 1.6 MB page read back.
You need a Cloudflare account, free to create — the only new thing.

## Setting it up

Eight commands, once. After this it runs on its own.

```powershell
cd C:\Users\1221j\Desktop\claude-edits\pillar-tracker-cloud\worker
```

**1. Sign in.** Opens a browser once.

```powershell
npx wrangler login
```

**2. Make the store.**

```powershell
npx wrangler kv namespace create FEED
```

It prints an `id`. Paste it into `wrangler.toml` over `PASTE_THE_KV_ID_HERE`.

**3. The three secrets.** Each asks for one value, pasted, not echoed.

```powershell
npx wrangler secret put META_TOKEN
```

```powershell
npx wrangler secret put PAGE_PASSWORD
```

```powershell
npx wrangler secret put PAGE_PATH
```

- `META_TOKEN` — the same long-lived Meta token GitHub holds.
- `PAGE_PASSWORD` — from `KEYS - keep private.txt`. It **must** be the key the
  published feed opens with, or the page will say the figures do not match it.
- `PAGE_PATH` — the secret half of your link. Use this, freshly generated:

  ```
  vqBbO_7FU4Kb7uOwgDcyLP46
  ```

**4. Put the worker up.**

```powershell
npx wrangler deploy
```

It prints a URL ending `.workers.dev`. Everything below uses it.

**5. Wait a minute, then check the figures are flowing.**

```powershell
curl https://pillar-tracker-feed.<your-subdomain>.workers.dev/health
```

Expect `ok — last run 40s ago`, then this week's spend and lead count. If it
says `FAILING`, the next line says why in plain words — an expired Meta token
and a mismatched page password both name themselves.

**6. Build the page and upload it.** One command does all three steps: builds
the HTML against the worker, turns its refresh down to a minute, and puts it in
KV.

```powershell
$env:PAGE_PASSWORD = '<the key from KEYS - keep private.txt>'
```

```powershell
node publish-page.cjs https://pillar-tracker-feed.<your-subdomain>.workers.dev
```

**7. Your link.** Bookmark it on the laptop and the phone:

```
https://pillar-tracker-feed.<your-subdomain>.workers.dev/t/vqBbO_7FU4Kb7uOwgDcyLP46
```

It fetches as it opens, so it is current every time you click it, and refreshes
itself every minute while you leave it sitting there.

**8. Last, once that link is working:** drop the five-minute cron from
`.github/workflows/refresh.yml`. It is wasted effort now — the worker owns the
fast figures, and every run costs a slow Pages deploy for numbers that are
already current. Keep the `2,32` Sierra run and the daily audit as they are.

## Keep the link private

The page carries the key that opens the feed, so **the address is the secret** —
the same bargain as emailing the file, except a link can be bookmarked. Anyone
with the link sees the figures and the lead names. A wrong guess at the path
gets the same `404` as any other junk, so guessing tells them nothing, and the
page is served `noindex` and `no-referrer` so it cannot leak into a search
engine or into the logs of a site you click through to.

The feed at `/feed` is open, but it is ciphertext — useless without the key.

To change the link later: `npx wrangler secret put PAGE_PATH` with a new value.
The old one 404s immediately.

## What this does NOT reach: the Claude artifact

The tracker at `claude.ai/artifact/YaMvD5CJees2JjvCrgFYZz` is a different thing
from this page, and it **cannot** be made to update by itself.

A published artifact runs in a sandbox with no network capability — the whole
list it may be granted is `artifact, assets, comments, db, dictation, downloads,
files, mcp, room, sample, self, user`, and none of them is "fetch a URL". The
page's own `liveFetch` code is dead there; pointing it at a feed was tried
before and the browser refused it, which is why `config/live` is deliberately
left absent.

Figures reach the artifact one way only: a Claude session writing its database,
which is what the hourly routine in `ROUTINE.md` does. Every minute would mean
1,440 Claude sessions a day — not free, and not sensible.

So the link above is the one that is always current. If you want the artifact
closer to current as well, the routine can run every 15 minutes instead of
hourly; against a worker-fed base those figures would be ~15 minutes old rather
than today's five and a half hours.

## Keeping the two halves honest

Both sides must count a lead the same way and exclude the same campaigns. After
any edit to `config.json`:

```powershell
node sync-config.cjs
```

Then deploy again. The checks:

```powershell
npm run check
```

`verify-crypto.cjs` proves the worker's lock and `make-live.js`'s lock are the
same lock, both directions, accents and quotes included — so a feed sealed by
either half opens in the page. `verify-shape.mjs` downloads the live feed, turns
its day columns back into the rows Meta would have sent, runs them through the
worker's own aggregation, and checks it lands on the same 72 days to the cent
and the same spend and leads on all 9 rows, with nothing hand-typed moved. Both
pass as of 18 Nov 2026.

Neither can test the Meta call itself — there is no token on this machine. That
is what step 5 is for.

## Watching it

```powershell
npx wrangler tail
```

Live log. A minute that fails changes nothing anyone can see — the stored feed
is still the last good one and the next minute tries again — so `/health` is the
better check: it goes red only once the feed is more than ten minutes old.
