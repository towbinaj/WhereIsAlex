# Where's Alex

A small, fast page that answers one question: **where's Alex right now, and where will Alex be next.** It reads Alex's QGenda work schedule (via the department's public share link) and shows today's assignment front-and-center, with the days ahead below. Designed as a sibling to the SPARK calendar — same paper/ink theme, IBM Plex + JetBrains Mono type, gradient brand accents.

> Maintainer notes — the reverse-engineered QGenda pipeline, local/secret setup, and operational gotchas — are in [`CLAUDE.md`](CLAUDE.md). Read that before a bigger change.

## How it works

```
QGenda share link ──► scripts/build-schedule.js ──► schedule.json ──► index.html + app.js
                      (scrape keys + call API)        (committed)        (static page)
```

- **`scripts/build-schedule.js`** loads each configured calendar and writes `schedule.json`. It supports two source types:
  - **`qgenda-quicklink`** — the QGenda shared *Link/view* page. The script loads that public page (which embeds the company key, internal link key, and an antiforgery token), then calls QGenda's quicklink API to pull the whole department schedule and keeps only Alex's entries. **No login, no stored secrets** — everything it needs is scraped from the share page on each run, so it keeps working even if QGenda rotates the internal keys.
  - **`ics`** — a standard iCalendar feed (a hand-rolled RFC 5545 parser, UTC→Eastern conversion). Handy for adding a personal calendar later.
- **`schedule.json`** is committed so the page loads instantly. A GitHub Action rebuilds it hourly.
- **`index.html` / `styles.css` / `app.js`** are a static site — the "Today" hero plus the upcoming day list. No build step, no framework.

> The original QGenda **iCal** link (`…/ical?key=…`) is dead — it returns an empty/404 response even in a browser, so it was replaced by the share-link pipeline above, which pulls the same data.

## Run locally

`npm run build` needs the QGenda share URL in a gitignored `.env` at the repo root — see [Configuring the QGenda source](#configuring-the-qgenda-source). On a fresh machine you must recreate it (the value lives in the `QGENDA_VIEW_URL` GitHub secret, which can't be read back — get the link from QGenda). `npm run serve` works without it.

```bash
npm run serve      # static preview at http://localhost:5174
npm run build      # re-fetch QGenda and rebuild schedule.json (needs .env)
```

Test the parser against a downloaded `.ics` without hitting the network:

```bash
node scripts/build-schedule.js --file=path/to/downloaded.ics
```

## Deploy (GitHub Pages)

1. Create a GitHub repo and push these files.
2. **Settings → Pages** → deploy from the `main` branch, root.
3. Add the `QGENDA_VIEW_URL` **Actions secret** (`gh secret set QGENDA_VIEW_URL`).
4. The included workflow (`.github/workflows/refresh-schedule.yml`) rebuilds `schedule.json` **twice daily (noon & midnight Eastern)** and commits it back only when the data changed. It pushes with the repo's default `GITHUB_TOKEN`.

The page is marked `noindex` so it stays out of search engines; anyone with the link can view it.

> **Deploy flakes:** GitHub's "pages build and deployment" run sometimes fails with *"Deployment failed, try again later"* — a GitHub-side hiccup, not your files. Just re-run it. See `CLAUDE.md` for this and other operational notes.

## Configuring the QGenda source

The `qgenda` entry in `CALENDARS` (top of `scripts/build-schedule.js`) has a few knobs:

```js
{
  id: "qgenda", label: "Work · QGenda", color: "#D54070", color2: "#CA5699",
  type: "qgenda-quicklink",
  viewUrl: process.env.QGENDA_VIEW_URL,   // set via .env / GitHub secret, not committed
  staff: "Towbin",     // matched against last name or QGenda abbreviation
  weeks: 10,           // how many weeks forward to pull
  hideTasks: [],       // assignment labels to drop, e.g. ["No Call", "JEOPARDY", "Request a Shift"]
}
```

- **`QGENDA_VIEW_URL`** — the QGenda `Link/view` share URL is **not** stored in the code. Provide it via:
  - **Local:** a gitignored `.env` file at the repo root — `QGENDA_VIEW_URL=https://app.qgenda.com/Link/view?linkKey=…&landingPageId=…`
  - **CI:** a repo **Actions secret** named `QGENDA_VIEW_URL` (`gh secret set QGENDA_VIEW_URL`), which the workflow passes to the build step.
  If the share link is ever regenerated, update those two places — nothing in the code changes.
- **`staff`** picks whose entries to keep out of the department schedule.
- **`hideTasks`** removes pure call-pool / bookkeeping labels that don't say where Alex actually is. Leave empty to show everything.

### Fiscal year & views

The build fetches the **current fiscal year (Jul 1 – Jun 30)** in one shot — QGenda serves past schedule data, so elapsed months stay in `schedule.json` alongside upcoming ones. The page then slices that data three ways:

- **Upcoming list** + **Jump to…** — near-term only (`LIST_HORIZON_DAYS` in `app.js`, ~6 weeks).
- **Days off** button — every upcoming day off across the whole year, as merged date ranges.
- **Year stats** button (footer) — a fiscal-year shift tally by category and label, with a running "done" count for shifts already elapsed.

### Assignment icons

Each assignment gets a category icon: **clinical** (pulse), **conference** (people), **call** (phone), **office** (briefcase), **away** (sun). Categories are assigned in `scripts/build-schedule.js` — `TASK_CATEGORIES` maps known labels exactly, and `CATEGORY_KEYWORDS` is an ordered keyword fallback so new/unseen labels still get sorted. To reclassify a label, edit the map.

### Icons / favicons

- **Browser tab:** `assets/favicon.svg` — the pin with a **transparent** center, so it adapts to any tab color.
- **iOS home screen / installed PWA:** `assets/apple-touch-icon.png` (+ `icon-192.png` / `icon-512.png`) — the pin on an **opaque paper chip** (iOS composites transparent icons onto black, so home-screen icons need a solid background). Regenerate from `assets/icon-chip.svg`:
  ```sh
  qlmanage -t -s 1024 -o /tmp icon-chip.svg
  sips -z 180 180 /tmp/icon-chip.svg.png --out apple-touch-icon.png
  sips -z 192 192 /tmp/icon-chip.svg.png --out icon-192.png
  sips -z 512 512 /tmp/icon-chip.svg.png --out icon-512.png
  ```

## Adding another calendar later

Add an entry to `CALENDARS` — an `ics` feed or another quicklink:

```js
{ id: "personal", label: "Personal", color: "#59B8DA", color2: "#73B44A", type: "ics", url: "https://…/basic.ics" }
```

Each assignment is tagged with its calendar's `id`, so cards pick up that source's accent color and a legend appears automatically once there's more than one.

Displayed times come straight from QGenda in **US Eastern**; ICS feeds' UTC times are converted using `DISPLAY_TZ` in the build script.
