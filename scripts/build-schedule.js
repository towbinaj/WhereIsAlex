#!/usr/bin/env node
/**
 * WHERE IS ALEX · schedule builder
 *
 * Builds schedule.json — the data the page reads — from one or more calendar
 * sources. Two source types are supported:
 *
 *   type: "qgenda-quicklink"  → a QGenda shared "Link/view" page. We load the
 *        page (which embeds the company + link keys and an antiforgery token),
 *        then call QGenda's quicklink API to pull the department schedule and
 *        keep only the entries for one staff member (Alex). No login, no
 *        secrets — everything needed is scraped from the public share page each
 *        run, so it keeps working even if QGenda rotates the internal keys.
 *
 *   type: "ics"               → a standard iCalendar (.ics) feed. Handy for
 *        adding a personal calendar later.
 *
 * Adding another calendar is a one-line change: add an entry to CALENDARS.
 * Each assignment is tagged with its calendar id so the page can color and
 * label it, with a legend appearing automatically once there's more than one.
 *
 * Zero runtime dependencies.
 *
 *   node scripts/build-schedule.js
 *   node scripts/build-schedule.js --file=path/to/local.ics   (parse a local ICS instead of fetching)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load a local, gitignored .env so `npm run build` works in dev without
// exporting vars each time. In CI, QGENDA_VIEW_URL comes from a GitHub Actions
// secret instead, so the share link is never committed to the repo.
function loadDotEnv() {
  try {
    const txt = readFileSync(join(__dirname, "..", ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* no .env file — rely on the real environment */ }
}
loadDotEnv();

/* ------------------------------------------------------------------ config */

const CALENDARS = [
  {
    id: "qgenda",
    label: "Work · QGenda",
    color: "#D54070",
    color2: "#CA5699",
    type: "qgenda-quicklink",
    // QGenda share link — kept OUT of source. Set QGENDA_VIEW_URL in a local
    // .env (gitignored) or as the QGENDA_VIEW_URL GitHub Actions secret.
    viewUrl: process.env.QGENDA_VIEW_URL,
    // Which staff member to keep — matched against last name or QGenda abbreviation.
    staff: "Towbin",
    // Assignment labels to drop entirely (pure status / scheduling artifacts
    // that don't say where Alex is). Leave empty to show everything.
    hideTasks: ["No Call", "Request a Shift"],
  },
  // Example — add a personal iCal calendar later:
  // {
  //   id: "personal", label: "Personal", color: "#59B8DA", color2: "#73B44A",
  //   type: "ics", url: "https://calendar.google.com/calendar/ical/.../basic.ics",
  // },
];

// Times without a zone are shown as-is; UTC ("Z") times in ICS feeds are
// converted to this zone. Cincinnati / CCHMC is US Eastern.
const DISPLAY_TZ = "America/New_York";

/* --------------------------------------------------------- task categories */
// Each assignment is tagged with a category so the page can show a matching
// icon: clinical | conference | call | office | away.
//
// Known labels are mapped exactly (authoritative). Anything not listed falls
// through to the keyword rules, then to the default. To reclassify a label,
// edit the map; to teach the fallback a new pattern, edit CATEGORY_KEYWORDS.
const TASK_CATEGORIES = {
  "ultrasound": "clinical",
  "fluoro": "clinical",
  "liberty": "clinical",
  "trunk 1": "clinical",
  "trunk 2": "clinical",
  "resource": "clinical",
  "solid tumor board": "conference",
  "tuberous sclerosis conf": "conference",
  "overnight beeper": "call",
  "eve 1": "call",
  "eve 3": "call",
  "weekend beeper": "call",
  "weekend mid": "call",
  "moonlighting shift": "call",
  "weekend/holiday late": "call",
  "weekend/holiday early": "call",
  "holiday late": "call",
  "holiday early": "call",
  "jeopardy": "call",
  "office": "office",
  "vacation": "away",
  "observed holiday": "away",
  "meeting": "away",
};

// Ordered keyword fallback for labels not in the map above. First match wins,
// so keep call/conference ahead of the broad "holiday" → away rule.
const CATEGORY_KEYWORDS = [
  ["call", ["beeper", "call", "jeopardy", "overnight", "pager", "opl", "late", "early"]],
  ["conference", ["board", "conf", "tumor", "rounds", "lecture", "didactic"]],
  ["office", ["office", "admin"]],
  ["away", ["vacation", "holiday", "pto", "leave", "away", "meeting", "off"]],
];
const DEFAULT_CATEGORY = "clinical";

// Relabel certain assignments before display (keyed by lowercased label).
// e.g. "VACATION" → "Off" so the public page doesn't broadcast travel dates —
// it just reads like any ordinary day off.
const RELABEL_TASKS = {
  "vacation": "Off",
  "meeting": "Off",
  "us": "Ultrasound",
  "resource person": "Resource",
  "trunk 1 (m-f)": "Trunk 1",
  "trunk 2 (m-f)": "Trunk 2",
  "jeopardy": "Jeopardy",
  "office": "Office",
  "opl we/hol beeper": "Weekend Beeper",
  "weekend/holiday early": "Weekend/Holiday Early",
  "weekend/holiday late": "Weekend/Holiday Late",
};
function relabelTask(title) {
  return RELABEL_TASKS[String(title || "").trim().toLowerCase()] || title;
}

function classifyTask(title) {
  const t = String(title || "").trim().toLowerCase();
  if (TASK_CATEGORIES[t]) return TASK_CATEGORIES[t];
  for (const [cat, kws] of CATEGORY_KEYWORDS) {
    if (kws.some((k) => t.includes(k))) return cat;
  }
  return DEFAULT_CATEGORY;
}

/* ------------------------------------------------------------------- args */

function parseArgs() {
  const out = { file: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--file=")) out.file = a.slice("--file=".length);
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");

/* ============================================================================
   QGenda quicklink source
   ========================================================================== */

// Minimal HTML-entity decode for the attribute-embedded JSON blob.
function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Pull the bits we need out of the share page: the company/link keys and the
// schedule start date (from #react-app's data-bundle-settings), the antiforgery
// token (a hidden input), and the session cookies (Set-Cookie).
async function loadQuicklinkContext(viewUrl) {
  const res = await fetch(viewUrl, {
    redirect: "follow",
    headers: { "User-Agent": "WhereIsAlex/1.0", Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`view page ${res.status} ${res.statusText}`);
  const html = await res.text();

  const cookies = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .join("; ");

  // The page carries more than one data-bundle-settings blob; the schedule one
  // (on #react-app) is the blob that actually contains pageSettings.
  let settings = null;
  for (const m of html.matchAll(/data-bundle-settings="([^"]+)"/g)) {
    try {
      const parsed = JSON.parse(decodeEntities(m[1]));
      if (parsed && parsed.pageSettings && parsed.pageSettings.companyKey) { settings = parsed; break; }
    } catch { /* not this one */ }
  }
  if (!settings) throw new Error("could not find schedule bundle settings on share page");
  const ps = settings.pageSettings || {};
  const co = settings.calendarOptions || {};

  const tokenMatch = html.match(/id="RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!tokenMatch) throw new Error("could not find antiforgery token on share page");

  if (!ps.companyKey || !ps.linkKey) throw new Error("share page missing company/link keys");

  return {
    companyKey: ps.companyKey,
    linkKey: ps.linkKey,
    startDate: co.startDate || `${new Date().getFullYear()}-01-01T00:00:00`,
    timeZoneId: co.selectedTimeZoneId || "Eastern Standard Time",
    weekStartDay: co.weekStartDay ?? 0,
    token: tokenMatch[1],
    cookies,
    viewUrl,
  };
}

// Authenticated POST to a quicklink API endpoint.
async function qgPost(ctx, path, body) {
  const res = await fetch(`https://app.qgenda.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, */*",
      "User-Agent": "WhereIsAlex/1.0",
      RequestVerificationToken: ctx.token,
      "X-QGenda-CompanyKey": ctx.companyKey,
      "X-QGenda-QuickLinkKey": ctx.linkKey,
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://app.qgenda.com",
      Referer: ctx.viewUrl,
      Cookie: ctx.cookies,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

// "2026-07-12T21:30:00" → "2130"; null/empty → null.
function isoToHHMM(iso) {
  if (!iso) return null;
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}${m[2]}` : null;
}

async function buildFromQuicklink(cal) {
  if (!cal.viewUrl) {
    throw new Error(
      "QGENDA_VIEW_URL is not set — add it to a local .env file or the QGENDA_VIEW_URL GitHub Actions secret"
    );
  }
  const ctx = await loadQuicklinkContext(cal.viewUrl);
  console.log(`  [${cal.id}] company=${ctx.companyKey.slice(0, 8)}… link=${ctx.linkKey.slice(0, 8)}… start=${ctx.startDate.slice(0, 10)}`);

  // Fetch the whole current fiscal year (Jul 1 – Jun 30) so the shift tally is
  // complete — including months already elapsed. QGenda serves past schedule
  // data, so anchoring the start to the FY works all year long.
  const fy = fiscalYear(todayISO());
  const commonStart = `${sundayOnOrBefore(fy.start)}T00:00:00`;
  const fyWeeks = weeksBetween(commonStart.slice(0, 10), fy.end);
  console.log(`  [${cal.id}] FY ${fy.label}: fetching ${commonStart.slice(0, 10)} + ${fyWeeks}w`);

  const [sched, staff, taskData] = await Promise.all([
    qgPost(ctx, `/Link/${ctx.linkKey}/ScheduleView/GetQuickLinkScheduleDisplayItems`, {
      companyKey: ctx.companyKey,
      linkAccessKey: "",
      includePublishedOpens: true,
      startDate: commonStart,
      timeRangeUnitType: 1, // weeks
      rangeValue: fyWeeks,
      scheduleViewType: 1,
      selectedTimeZoneId: ctx.timeZoneId,
      weekStartDay: ctx.weekStartDay,
      scheduleSortingType: 0,
      hideOpenScheduleEntries: false,
      hideUnassigned: false,
    }),
    qgPost(ctx, `/Link/${ctx.linkKey}/QuickLinkPage/LinkStaff`, {
      linkAccessKey: "",
      startDate: commonStart,
      includeVoalte: "false",
      companyStaffMemberKeys: null,
    }),
    qgPost(ctx, `/Link/${ctx.linkKey}/QuickLinkPage/LinkTasks`, {
      linkAccessKey: "",
      startDate: commonStart,
      endDate: addWeeksISO(commonStart, fyWeeks),
    }),
  ]);

  const want = String(cal.staff || "").toLowerCase();
  const me = (staff || []).find(
    (s) =>
      String(s.lastName || "").toLowerCase() === want ||
      String(s.abbreviation || "").toLowerCase() === want
  );
  if (!me) throw new Error(`staff member "${cal.staff}" not found in this schedule`);

  const taskName = new Map((taskData.tasks || []).map((t) => [t.taskKey, t.name || t.displayName || t.abbreviation || ""]));
  const hide = new Set((cal.hideTasks || []).map((s) => s.toLowerCase()));

  const records = [];
  for (const it of sched.items || []) {
    if (it.staffMemberKey !== me.staffMemberKey) continue;
    if (it.isStruck) continue; // crossed-off in QGenda = canceled / no longer active
    const title = (taskName.get(it.taskKey) || "").trim();
    if (!title || hide.has(title.toLowerCase())) continue;
    const startTime = isoToHHMM(it.startTime);
    records.push({
      calendar: cal.id,
      date: it.date.slice(0, 10),
      title,
      location: "",
      notes: (it.note || "").trim(),
      allDay: !startTime,
      startTime,
      endTime: isoToHHMM(it.endTime),
      uid: it.displayKey || it.scheduleEntryKey || `${it.taskKey}-${it.date}`,
    });
  }
  console.log(`  [${cal.id}] ${me.firstName} ${me.lastName}: ${records.length} assignments`);
  return records;
}

// startISO + N weeks, as an ISO datetime string.
function addWeeksISO(startISO, weeks) {
  const [y, mo, d] = startISO.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + weeks * 7));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T00:00:00`;
}

/* ============================================================================
   ICS source (RFC 5545 basics) — for future personal calendars
   ========================================================================== */

function unfold(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
}
function unescapeText(v) {
  return String(v ?? "")
    .replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}
function parseKey(rawKey) {
  const parts = rawKey.split(";");
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: parts[0].toUpperCase(), params };
}
function parseEvents(text) {
  const lines = unfold(text).split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const { name, params } = parseKey(line.slice(0, colon));
    if (!(name in cur)) cur[name] = { value: line.slice(colon + 1), params };
  }
  return events;
}
function utcToZoned(y, mo, d, h, mi) {
  const inst = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(inst);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}${get("minute")}` };
}
function parseDateProp(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, time: null, allDay: true } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) { const zn = utcToZoned(+y, +mo, +d, +h, +mi); return { date: zn.date, time: zn.time, allDay: false }; }
  return { date: `${y}-${mo}-${d}`, time: `${h}${mi}`, allDay: false };
}
function nextISODate(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function eventToAssignments(ev, calId) {
  const start = parseDateProp(ev.DTSTART);
  if (!start) return [];
  const end = parseDateProp(ev.DTEND);
  const base = {
    calendar: calId,
    title: unescapeText(ev.SUMMARY?.value) || "Assignment",
    location: unescapeText(ev.LOCATION?.value) || "",
    notes: unescapeText(ev.DESCRIPTION?.value) || "",
    uid: ev.UID?.value || `${ev.SUMMARY?.value}-${start.date}`,
  };
  const out = [];
  if (start.allDay) {
    const lastExclusive = end?.date && end.date > start.date ? end.date : nextISODate(start.date);
    let cursor = start.date, guard = 0;
    while (cursor < lastExclusive && guard++ < 400) {
      out.push({ date: cursor, allDay: true, startTime: null, endTime: null, ...base });
      cursor = nextISODate(cursor);
    }
    if (!out.length) out.push({ date: start.date, allDay: true, startTime: null, endTime: null, ...base });
  } else {
    out.push({
      date: start.date, allDay: false, startTime: start.time,
      endTime: end && end.date === start.date ? end.time : end?.time ?? null, ...base,
    });
  }
  return out;
}
async function buildFromICS(cal, localFile) {
  let ics;
  if (localFile) {
    console.log(`  [${cal.id}] reading local file ${localFile}`);
    ics = readFileSync(localFile, "utf8");
  } else {
    console.log(`  [${cal.id}] fetching ${cal.url}`);
    const res = await fetch(cal.url, {
      redirect: "follow",
      headers: { Accept: "text/calendar, */*", "User-Agent": "WhereIsAlex/1.0" },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    ics = await res.text();
  }
  if (!/BEGIN:VCALENDAR/i.test(ics)) throw new Error("not an iCalendar document");
  const events = parseEvents(ics);
  console.log(`  [${cal.id}] parsed ${events.length} events`);
  const records = [];
  for (const ev of events) records.push(...eventToAssignments(ev, cal.id));
  return records;
}

/* ------------------------------------------------------------ shared tail */

function todayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Fiscal year runs Jul 1 – Jun 30. Returns the FY window containing `todayISO`.
function fiscalYear(iso) {
  const [y, m] = iso.split("-").map(Number);
  const startYear = m >= 7 ? y : y - 1;
  return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30`, label: `${startYear}–${startYear + 1}` };
}

// The Sunday on or before `iso` (QGenda weeks start Sunday, weekStartDay=0).
function sundayOnOrBefore(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Whole weeks needed to span [fromISO, toISO] inclusive.
function weeksBetween(fromISO, toISO) {
  const a = new Date(fromISO + "T00:00:00Z"), b = new Date(toISO + "T00:00:00Z");
  return Math.ceil((b - a) / (7 * 86400000)) + 1;
}

async function main() {
  const { file } = parseArgs();
  const all = [];
  let anySucceeded = false;

  for (const cal of CALENDARS) {
    try {
      let recs;
      if (file) recs = await buildFromICS(cal, file); // --file forces a local ICS parse
      else if (cal.type === "qgenda-quicklink") recs = await buildFromQuicklink(cal);
      else recs = await buildFromICS(cal);
      all.push(...recs);
      anySucceeded = true;
    } catch (err) {
      console.warn(`  ✗ [${cal.id}] ${err.message} — skipping this calendar`);
    }
    if (file) break;
  }

  if (!anySucceeded) {
    console.error("✗ No calendar could be loaded. Leaving the existing schedule.json in place.");
    process.exit(1);
  }

  // Relabel (e.g. VACATION → Off), then tag each assignment with its category.
  for (const a of all) {
    a.title = relabelTask(a.title);
    a.category = classifyTask(a.title);
  }

  // Dedupe (same uid + day) and group into days.
  const seen = new Set();
  const byDate = new Map();
  for (const a of all) {
    const k = `${a.calendar}|${a.uid}|${a.date}|${a.startTime ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!byDate.has(a.date)) byDate.set(a.date, []);
    byDate.get(a.date).push(a);
  }

  // Keep the whole current fiscal year (Jul 1 – Jun 30): elapsed months feed
  // the shift tally; upcoming months feed the list and days-off view.
  const fy = fiscalYear(todayISO());

  const days = [...byDate.entries()]
    .filter(([date]) => date >= fy.start && date <= fy.end)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, assignments]) => ({
      date,
      assignments: assignments.sort((x, y) => {
        if (x.allDay !== y.allDay) return x.allDay ? -1 : 1;
        return (x.startTime ?? "").localeCompare(y.startTime ?? "");
      }),
    }));

  const total = days.reduce((n, d) => n + d.assignments.length, 0);
  console.log(`→ FY ${fy.label}: ${days.length} days, ${total} assignments`);

  const out = {
    _generatedAt: new Date().toISOString(),
    person: "Alex",
    displayTimeZone: DISPLAY_TZ,
    fiscalYear: { start: fy.start, end: fy.end, label: fy.label },
    calendars: CALENDARS.map(({ id, label, color, color2 }) => ({ id, label, color, color2 })),
    days,
  };
  const outPath = join(__dirname, "..", "schedule.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`→ wrote ${outPath}`);
}

main().catch((err) => { console.error("✗", err.message); process.exit(1); });
