# Turning the cloud runner on

Everything in this folder is ready to go. What is left are the three things only
you can do, because they involve your own logins: sign in to GitHub, make the
repository, and paste the secrets. Twenty minutes, once.

The two passwords the runner needs have already been invented and written to
**`KEYS - new, paste into GitHub.txt`** in this folder. Keep that file; it is
never committed and never leaves this computer on its own.

---

## 1. Sign in to GitHub

```bash
gh auth login
```

Pick **GitHub.com → HTTPS → Login with a web browser** and follow it. If you have
no account yet, make one first at github.com — the free tier is all this needs.

## 2. Make the repository and push

```bash
cd "C:/Users/1221j/Desktop/claude-edits/pillar-tracker-cloud" && gh repo create mclaren-pillar-tracker --public --source=. --push
```

**Public** is what makes the runs free. Nothing readable goes in: the figures are
published encrypted, the working files travel inside `state.enc`, and your logins
are GitHub secrets. See "Why it is safe on a public address" in the README.

## 3. Turn Pages on

On the repository page: **Settings → Pages → Build and deployment → Source:
GitHub Actions**.

Your address becomes `https://<your-username>.github.io/mclaren-pillar-tracker/`
and the figures land at `.../data.enc.json`.

## 4. Paste the secrets

**Settings → Secrets and variables → Actions → Secrets → New repository secret.**
Eight of them. Paste each value yourself — nothing here reads them for you.

| Secret | Where the value is |
|---|---|
| `META_TOKEN` | the one line in `Desktop/Meta Ads Tracker/meta-token.txt` |
| `SIERRA_API_KEY` | the one line in `Desktop/Meta Ads Tracker/sierra-api-key.txt` |
| `SIERRA_SITE` | the site name you type on Sierra's own login screen |
| `SIERRA_USER` | your Sierra username |
| `SIERRA_PASS` | your Sierra password |
| `SIERRA_HOST` | `client11.sierrainteractivedev.com` |
| `PAGE_PASSWORD` | from `KEYS - new, paste into GitHub.txt` |
| `STATE_KEY` | from the same file |

Then **Variables → New repository variable**:

| Variable | Value |
|---|---|
| `DATA_URL` | `https://<your-username>.github.io/mclaren-pillar-tracker/data.enc.json` |

## 5. Start it

**Actions → Refresh the tracker → Run workflow**, with *Run the full audit*
ticked. Watch this one all the way through — about ten minutes, mostly
installing Chromium. It should end with `199 checks, 0 mismatches` or similar.

## 6. Point the tracker at it

Come back here and say **"the feed is live at `<the DATA_URL>`"**. That writes one
small record into the tracker's own database — the address and the password —
and from that moment the page fetches the figures itself every five minutes, for
you and for everyone you have shared the link with, with this laptop closed.

Nothing about the page needs rebuilding when the figures change. The address and
the password are the only things it has to be told, and they are told once.

---

## What then runs, and how often

| | How often | What it does | How long |
|---|---|---|---|
| Figures | every 5 min, 7am–10pm | Meta spend, leads, and the running ads | ~1 min |
| Sierra | every 30 min, 7am–10pm | calls, texts, emails, who is waiting | ~8 min |
| Audit | once a day, 7am | ~200 figures put back to Meta, to the cent | ~12 min |

GitHub's scheduler is best-effort and runs late when it is busy, so read "every
five minutes" as "usually within five to fifteen". The page keeps asking on its
own five-minute beat regardless, so it picks up a new publish as soon as there
is one.

**A failed check publishes nothing.** The tracker keeps showing the last figures
that matched Meta, and the run says why on its summary page. Turn on email for
failed Actions runs under your GitHub **Settings → Notifications → Actions**.

## The things that expire quietly

| What | How often | What you see |
|---|---|---|
| Meta access token | ~60 days | every run fails on `pull-meta.js` |
| Sierra's Facebook link | 60 days | new leads stop appearing in Sierra at all |
| Sierra password | when you change it | the Sierra step says it could not sign in |

GitHub also pauses scheduled runs on a repository nobody has touched for 60
days. The daily backup commit normally counts as touching it; if the runs ever
stop by themselves, open Actions and press *Run workflow* once.
