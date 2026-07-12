# CLAUDE.md — working notes for Where's Alex

Context for anyone (human or a fresh Claude Code session) picking this up later.
The `README.md` covers the *what* and the config knobs; this file covers the
non-obvious, hard-won, and operational bits that aren't self-evident from the code.

## What this is

A static GitHub Pages site that shows one physician's (Alex Towbin's) work
schedule so people can find him. Data comes from the department's public QGenda
share link, filtered to one person. No backend, no framework, zero runtime deps.

Live: https://towbinaj.github.io/WhereIsAlex/ · Repo: towbinaj/WhereIsAlex

## Working rhythm (how changes get made)

1. Edit config/code (most content changes are one-liners — see "Where things live").
2. `node scripts/build-schedule.js` — re-fetches QGenda and rewrites `schedule.json`.
3. Verify locally: `npm run serve` (port 5174), open the preview, check the change.
4. Commit + push to `main`.
5. The Pages deploy publishes automatically. **Verify it went live** (curl the URL
   or hard-refresh — browser cache is 10 min).
6. If the deploy flaked (see Operational quirks), re-run it.

## Where things live (the config surface)

Nearly all content behavior is config at the top of `scripts/build-schedule.js`:

- `CALENDARS` — the QGenda source: `staff` (whose entries to keep), `hideTasks`
  (labels to drop entirely). `viewUrl` comes from `process.env.QGENDA_VIEW_URL`.
- `TASK_CATEGORIES` (exact label → category) + `CATEGORY_KEYWORDS` (ordered keyword
  fallback) — classify each shift into clinical | call | conference | office | away.
  **Classification runs on the RELABELED title**, so map keys must match post-rename.
- `RELABEL_TASKS` — display renames (e.g. `us → Ultrasound`, `vacation → Off`).
  Applied before classification. Case-only renames don't need a category-map change
  (keys are lowercased); real renames do.
- `DISPLAY_TZ` — Eastern; only used to convert UTC times in ICS feeds.

In the frontend:
- Category **icons**: `CAT_ICONS` in `app.js`. Category **colors**: `.cat-icon--*`
  and `.assignment--*` in `styles.css` (stops from the brand gradient).
- **Horizons**: `LIST_HORIZON_DAYS` in `app.js` (~6 weeks) caps the Upcoming list and
  Jump-to. The **Days off** dialog keys on `title === "Off"` (vacation/meeting only,
  not holidays). **Year stats** tallies the whole fiscal year.
- **Fiscal year** = Jul 1 – Jun 30, computed in `build-schedule.js` (`fiscalYear()`).

## The QGenda pipeline — how it works, and how to re-derive it if it breaks

This is the fragile part. QGenda has **no public API**; this was reverse-engineered
from the share page. If QGenda changes their frontend, the fastest fix is to open the
share link in a browser with DevTools → Network, watch the XHR POSTs the page fires on
load, and copy their URLs/headers/bodies. Below is what those currently are.

**Flow (all in `buildFromQuicklink` / `loadQuicklinkContext`):**

1. GET the public share page (`QGENDA_VIEW_URL`). The public `linkKey` in that URL is
   **not** the one the API uses. Scrape from the returned HTML:
   - `data-bundle-settings` attribute — HTML-entity-encoded JSON. There are **multiple**
     such blobs; the schedule one is the blob whose `pageSettings.companyKey` is set.
     From it: `pageSettings.companyKey`, `pageSettings.linkKey` (the **internal** key the
     API path uses), `calendarOptions.startDate`, `selectedTimeZoneId`, `weekStartDay`.
   - Hidden input `id="RequestVerificationToken"` (a `CfDJ…` antiforgery token) and the
     `.AspNetCore.Antiforgery.*` Set-Cookie. Token + cookie are paired — use both from
     the same GET.

2. POST to the endpoints below. **Required headers** (missing any → HTTP 401):
   `RequestVerificationToken`, `X-QGenda-CompanyKey`, `X-QGenda-QuickLinkKey`
   (= internal linkKey), `X-Requested-With: XMLHttpRequest`, plus the antiforgery Cookie.
   (These header names came from the `mainlayout` JS bundle's `initializeCompanyHeaders`
   / `initializeQuickLinkHeaders`; the endpoints from the `quickLinksPage` bundle; the
   staff/task endpoints from the `QuickLinksSendMessageModal` chunk.)

3. Three POSTs (path uses the internal linkKey):
   - `…/ScheduleView/GetQuickLinkScheduleDisplayItems` — body needs `startDate`,
     `timeRangeUnitType: 1` (weeks) and `rangeValue: <weeks>`. **Gotcha: use `rangeValue`,
     not an `endDate` — sending `endDate` returns `items: []`.** `startDate` may be in the
     **past** (QGenda serves history — that's how the fiscal-year tally stays complete).
     Returns `items[]` with `staffMemberKey`, `taskKey`, `date`, `startTime`/`endTime`
     (local wall-clock, no tz conversion), `isStruck`, `note`.
   - `…/QuickLinkPage/LinkStaff` — returns staff objects; match Towbin by `lastName`/
     `abbreviation` to get his `staffMemberKey`.
   - `…/QuickLinkPage/LinkTasks` — returns `tasks[]`; map `taskKey → name` for titles.

4. Join: keep items for Towbin's `staffMemberKey`, **drop `isStruck`** (crossed-off =
   canceled), title = task name, then relabel/classify.

Everything needed is scraped fresh each run, so it survives QGenda rotating the internal
keys. It does **not** survive them changing endpoint names, header names, or the bundle
structure — that needs the DevTools re-derivation above.

## Local setup / where the secret lives

The share URL is **deliberately not in the repo** (it exposes the whole department —
see Privacy). To build locally you must provide it:

- Create a gitignored `.env` at the repo root:
  `QGENDA_VIEW_URL=https://app.qgenda.com/Link/view?linkKey=…&landingPageId=…`
- Without it, the build errors: "QGENDA_VIEW_URL is not set".
- **On a fresh machine** the `.env` won't exist. The value is also stored as the GitHub
  Actions secret `QGENDA_VIEW_URL`, but GitHub won't reveal a secret's value. Recover the
  URL from QGenda directly (the CCHMC Radiology "*Master – *Full by Staff" quicklink) or
  wherever it's saved. CI doesn't need `.env` — it reads the secret.

## Operational quirks

- **Pages deploys flake.** The GitHub-managed "pages build and deployment" run
  intermittently fails with *"Deployment failed, try again later"* — a GitHub-side
  hiccup, not your files. Just re-run it (`gh run rerun <id>` or Actions → Re-run jobs).
  This happened several times during development; it's expected, not a bug in the repo.
- **Refresh schedule** (`.github/workflows/refresh-schedule.yml`) runs at 04/05/16/17
  UTC; an in-job guard skips all but the two that land on noon/midnight US Eastern
  (DST-proof). It commits `schedule.json` only when the schedule data actually changed.
- The "pages build and deployment" workflow is **GitHub-managed** (not a file here) and
  emits a Node 20 deprecation warning we can't fix. Our own workflow is on
  `checkout@v5` / `setup-node@v5` / Node 22 and is clean.
- `schedule.json` is committed so the site loads instantly; the Action keeps it fresh.

## Privacy / security notes (deliberate choices — don't undo casually)

- Published `schedule.json` contains **only Towbin** — no other staff, no phone numbers,
  no `note` leakage. The build filters before writing.
- `VACATION`/`MEETING` are relabeled to a neutral **"Off"** so the public page doesn't
  broadcast travel dates. The Days-off view shows these but not Observed Holidays.
- The page is `noindex` and shared by link. The underlying department share link (in the
  secret) exposes the whole department's schedule **and staff phone/pager numbers** via
  its API — that's QGenda's configuration, not this app's, and nothing here can change it.
- The share URL was previously committed (it's in git history); rotating the QGenda link
  is the only way to fully retire the exposed one.
