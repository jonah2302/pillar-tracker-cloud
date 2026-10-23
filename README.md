# Marketing Pillar Tracker — the cloud copy

The tracker, running without your laptop and without Claude. GitHub pulls Meta and
Sierra every fifteen minutes, checks every figure against Meta, and publishes the
numbers. The file you share fetches them when someone opens it, so it is never out
of date, no matter how long ago you sent it.

Free: public repository, so GitHub charges nothing for the runs.

---

## How the pieces fit

```
every 15 min, 7am–10pm                 GitHub Actions, free
  pull-meta.js ........ spend and leads, every week checked against Meta
  verify-periods.js ... month and all-time totals, to the cent
  pull-leads.js ....... lead names
  sierra-api.js ....... new leads and their agent, from Sierra's API
  cloud-sierra.js ..... calls, texts, emails — headless Chromium signed in to Sierra
  build-from-data.js .. rebuilds the tracker
  audit-meta.js ....... once a day: ~130 questions put back to Meta
  make-live.js ........ locks the numbers, publishes them
                                   |
                        docs/data.enc.json  →  GitHub Pages (public address, unreadable)
                                   |
         "Marketing Pillar Tracker (live).html"  ←  the file you share, holds the key
```

**If any check fails, nothing is published.** The file keeps showing the last
numbers that matched Meta, and the run says why on its summary page.

### Why it is safe on a public address

The repository has to be public for the runs to be free, so nothing readable is ever
put in it:

- **The figures** are published encrypted (AES-256-GCM, key stretched with PBKDF2).
  The public address holds ciphertext and nothing else.
- **The key** lives in one place: the HTML file you hand to people. It is never
  committed and never published.
- **The working files** — lead names, agents, who was called — are carried between
  runs inside `state.enc`, locked with a different key.
- **`config.json` goes in there too**, because it names your ad account, your
  campaigns (listing addresses and all), your agents and your weekly spend. The
  public half of the repository is code that could belong to anybody.
- **Your logins** are GitHub secrets. The run writes them to disk, uses them, and
  deletes them in the same job.

So: whoever has the file sees the figures, exactly as if you had emailed them a
spreadsheet. Whoever finds the address sees nothing. Treat the file the way you
would treat the numbers.

---

## Setting it up — once

### 1. Take everything the laptop already knows with you

The lead names, the agents, the client counts and Deal tags you have typed in — the
cloud starts from those rather than from nothing. Invent your `STATE_KEY` now, and
lock this folder's working files with it:

```bash
STATE_KEY="<the long one you just invented>" node state.js pack
```

That writes `state.enc`. It is the only form those files are ever committed in, and
it is the same key you will paste into GitHub in step 4.

### 2. Make the repository

Create a **public** repository on GitHub and push this folder to it. Public is what
makes the runs free; everything sensitive is encrypted before it goes in.

```bash
git init
git add .
git commit -m "Marketing Pillar Tracker, running in the cloud"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

### 3. Turn Pages on

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Your address will be `https://<you>.github.io/<repo>/`. The numbers land at
`https://<you>.github.io/<repo>/data.enc.json`.

### 4. Add the secrets

**Settings → Secrets and variables → Actions → Secrets → New repository secret.**
Paste each value yourself; nothing here reads them from your computer.

| Secret | What it is |
|---|---|
| `META_TOKEN` | the Meta access token — the first line of `meta-token.txt` on your laptop |
| `SIERRA_API_KEY` | the first line of `sierra-api-key.txt` |
| `SIERRA_SITE` | the site name you type on Sierra's login screen |
| `SIERRA_USER` | your Sierra username |
| `SIERRA_PASS` | your Sierra password |
| `SIERRA_HOST` | optional — only if your Sierra address ever changes; otherwise it comes from `config.json` inside `state.enc` |
| `PAGE_PASSWORD` | invent a long one. It locks the figures and goes into the file you share |
| `STATE_KEY` | invent another long one. It locks the working files between runs |

Then **Variables → New repository variable**:

| Variable | Value |
|---|---|
| `DATA_URL` | `https://<you>.github.io/<repo>/data.enc.json` |

### 5. Start it

**Actions → Refresh the tracker → Run workflow**, with *Run the full audit* ticked.
Watch it once, all the way through. The first run takes about ten minutes, mostly
installing Chromium.

If the Sierra step reports it could not sign in, everything else still publishes —
the Sierra follow-up section just keeps its last reading until the login works.

### 6. Build the file you share

On your own computer, once:

```bash
DATA_URL="https://<you>.github.io/<repo>/data.enc.json" PAGE_PASSWORD="<the same one>" node make-live.js --page
```

Out comes **`Marketing Pillar Tracker (live).html`**. That is the thing you send
people. Email it, drop it in Drive, put it on a desktop — it fetches the current
figures every time it is opened, from anywhere, forever, with nothing running on
anyone's machine.

Build it again only if you change `PAGE_PASSWORD` or the tracker's own design. New
figures need no new file.

---

## Living with it

**Seeing the numbers.** Open the file. Hit Refresh in it for a fresh fetch.

**When something breaks.** The Actions tab shows a red run with the reason at the
top. Nothing is published by a failed run, so a broken morning shows yesterday's
good numbers rather than today's wrong ones. Turn on email notifications for failed
Actions runs: your GitHub **Settings → Notifications → Actions**.

**Things that expire, silently.**

| What | How often | What you see |
|---|---|---|
| Meta access token | ~60 days | every run fails on `pull-meta.js` |
| Sierra's Facebook link | 60 days | new leads stop appearing in Sierra at all |
| Sierra password | when you change it | the Sierra step reports it could not sign in |

**If Sierra adds two-factor sign-in**, the headless login stops working and that
one section goes stale. Everything else carries on. The fix at that point is to ask
Sierra support for API access to lead activity — there is a `/leads/activity` route
on their API that an ordinary key cannot reach.

**GitHub pauses scheduled runs** on a repository nobody has touched for 60 days.
The daily backup commit normally counts as touching it; if runs ever stop on their
own, open Actions and press *Run workflow* once.

**Changes typed into the file** — client counts, Deal and Qualified tags, notes —
are kept in that browser, on that computer, and are not sent anywhere. They survive
new figures arriving. They do not travel to other people's copies.

---

## Running it by hand

```bash
npm install
npx playwright install chromium

export META_TOKEN=... SIERRA_API_KEY=... SIERRA_SITE=... SIERRA_USER=... SIERRA_PASS=...
export STATE_KEY=... PAGE_PASSWORD=... DATA_URL=https://<you>.github.io/<repo>/data.enc.json

node state.js unpack       # open the working files
node cloud-run.js --quick  # or: node cloud-run.js   for the full audit
node state.js pack         # lock them again
```

| File | What it does |
|---|---|
| `cloud-run.js` | one whole update, and the decision not to publish when a check fails |
| `cloud-sierra.js` | signs in to Sierra headless and takes the follow-up reading |
| `make-live.js` | locks the figures (`--data`) and builds the file you share (`--page`) |
| `state.js` | locks and unlocks the working files between runs |
| `config.json` | the ad account, the first day counted, campaigns left out, agents hidden |

The pulling, checking and building scripts are the same ones that run on the laptop,
unchanged, so both copies produce the same numbers from the same data.
