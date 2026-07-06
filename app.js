/* =====================================================================
   WHERE IS ALEX · app
   - Loads schedule.json (built from the QGenda + any future .ics feeds)
   - Hero spotlights where Alex is right now / today
   - Upcoming list shows the days ahead (optionally the recent past too)
   - Multi-calendar aware: each source carries its own accent + legend chip
   ===================================================================== */

const TODAY = new Date();
const TODAY_STR = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, "0")}-${String(TODAY.getDate()).padStart(2, "0")}`;
const NOW_HHMM = `${String(TODAY.getHours()).padStart(2, "0")}${String(TODAY.getMinutes()).padStart(2, "0")}`;

let days = [];
let calMap = new Map();      // id -> { label, color, color2 }
let calendars = [];
let generatedAt = "";
let showPast = false;

/* ---------- Helpers ---------- */

// "0800" -> "8:00a", "1230" -> "12:30p"
function fmtTime(t) {
  if (!t && t !== 0) return "";
  const s = String(t).padStart(4, "0");
  const h = parseInt(s.slice(0, 2), 10);
  const m = s.slice(2);
  const ampm = h >= 12 ? "p" : "a";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m}${ampm}`;
}

function fmtTimeRange(a) {
  if (a.allDay) return "All day";
  if (a.startTime && a.endTime) return `${fmtTime(a.startTime)} – ${fmtTime(a.endTime)}`;
  return fmtTime(a.startTime);
}

function parseISO(iso) { return new Date(iso + "T12:00:00"); }

function fmtDateLong(iso) {
  return parseISO(iso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}
function fmtDateShort(iso) {
  return parseISO(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function accentStyle(calId) {
  const c = calMap.get(calId);
  if (!c) return "";
  return `--accent:${c.color};--accent2:${c.color2 || c.color}`;
}

// A timed assignment is "on now" if today and the clock is within its window.
function isLiveNow(a, date) {
  if (date !== TODAY_STR || a.allDay || !a.startTime) return false;
  const end = a.endTime || "2359";
  return a.startTime <= NOW_HHMM && NOW_HHMM < end;
}

/* ---------- Icons ---------- */

const ICON_PIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

// Category icons — clinical | conference | call | office | away.
const CAT_ICONS = {
  clinical:   `<path d="M12 4v15"/><path d="M12 8c3.6 0 6.5 2.4 6.5 6"/><path d="M12 8c-3.6 0-6.5 2.4-6.5 6"/><path d="M12 12c2.8 0 5 2 5 4.6"/><path d="M12 12c-2.8 0-5 2-5 4.6"/>`, // chest x-ray (ribcage)
  conference: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`, // people
  call:       `<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>`, // phone
  office:     `<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>`, // briefcase
  away:       `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`, // sun
};

const CAT_LABEL = { clinical: "Clinical", conference: "Conference", call: "Call", office: "Office", away: "Away" };

function catIconHTML(category) {
  const body = CAT_ICONS[category];
  if (!body) return "";
  return `<span class="cat-icon cat-icon--${category}" role="img" aria-label="${CAT_LABEL[category] || ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg></span>`;
}

/* ---------- Render: shared meta bits ---------- */

function metaTimeHTML(a) {
  return `<span class="meta-item"><span class="meta-icon">${ICON_CLOCK}</span>${escapeHTML(fmtTimeRange(a))}</span>`;
}
function metaLocationHTML(a) {
  if (!a.location) return "";
  return `<span class="meta-item">${ICON_PIN}${escapeHTML(a.location)}</span>`;
}
function calChipHTML(calId) {
  if (calendars.length <= 1) return "";
  const c = calMap.get(calId);
  if (!c) return "";
  return `<span class="cal-chip" style="${accentStyle(calId)}">${escapeHTML(c.label)}</span>`;
}

/* ---------- Render: Hero ---------- */

function heroAssignmentHTML(a, date) {
  return `
    <div class="hero__assignment">
      <h1 class="hero__title">${catIconHTML(a.category)}<span>${escapeHTML(a.title)}</span></h1>
      <div class="hero__meta">
        ${metaTimeHTML(a)}
        ${metaLocationHTML(a)}
        ${calChipHTML(a.calendar)}
      </div>
      ${a.notes ? `<p class="assignment__notes">${escapeHTML(a.notes)}</p>` : ""}
    </div>
  `;
}

function findDay(date) { return days.find((d) => d.date === date); }
function nextDayWithAssignments(afterDate) {
  return days.find((d) => d.date > afterDate && d.assignments.length);
}

function renderHero() {
  const hero = document.getElementById("hero");
  const today = findDay(TODAY_STR);

  if (today && today.assignments.length) {
    const anyLive = today.assignments.some((a) => isLiveNow(a, TODAY_STR));
    const accentCal = today.assignments[0].calendar;
    hero.setAttribute("style", accentStyle(accentCal));
    hero.innerHTML = `
      <div class="hero__status ${anyLive ? "hero__status--live" : ""}">
        <span class="hero__dot"></span>${anyLive ? "On now" : "Today"}
      </div>
      <p class="hero__date">${escapeHTML(fmtDateLong(TODAY_STR))}</p>
      <div class="hero__assignments">
        ${today.assignments.map((a) => heroAssignmentHTML(a, TODAY_STR)).join("")}
      </div>
    `;
    return;
  }

  // Nothing today — reassure, and tease the next known assignment.
  const next = nextDayWithAssignments(TODAY_STR);
  const accentCal = next?.assignments[0]?.calendar;
  hero.setAttribute("style", accentCal ? accentStyle(accentCal) : "");
  const nextHTML = next
    ? `
      <div class="hero__nextup">
        <span class="hero__nextup-label">Next up · ${escapeHTML(fmtDateShort(next.date))}</span>
        ${heroAssignmentHTML(next.assignments[0], next.date)}
      </div>`
    : "";
  hero.innerHTML = `
    <div class="hero__status"><span class="hero__dot"></span>Today</div>
    <p class="hero__date">${escapeHTML(fmtDateLong(TODAY_STR))}</p>
    <p class="hero__empty">Nothing scheduled.</p>
    ${nextHTML}
  `;
}

/* ---------- Render: Upcoming day list ---------- */

function assignmentRowHTML(a) {
  return `
    <div class="assignment assignment--${a.category}" style="${accentStyle(a.calendar)}">
      <h3 class="assignment__title">${catIconHTML(a.category)}<span>${escapeHTML(a.title)}</span></h3>
      <div class="assignment__meta">
        ${metaTimeHTML(a)}
        ${metaLocationHTML(a)}
        ${calChipHTML(a.calendar)}
      </div>
      ${a.notes ? `<p class="assignment__notes">${escapeHTML(a.notes)}</p>` : ""}
    </div>
  `;
}

function dayHTML(d) {
  const dt = parseISO(d.date);
  const weekday = dt.toLocaleDateString("en-US", { weekday: "short" });
  const num = dt.getDate();
  const month = dt.toLocaleDateString("en-US", { month: "short" });
  const isToday = d.date === TODAY_STR;
  return `
    <li class="day ${isToday ? "day--today" : ""}" id="day-${d.date}">
      <div class="day__date">
        <span class="day__weekday">${isToday ? "Today" : weekday}</span>
        <span class="day__num">${num}</span>
        <span class="day__month">${month}</span>
      </div>
      <div class="day__items">
        ${d.assignments.map(assignmentRowHTML).join("")}
      </div>
    </li>
  `;
}

function renderDayList() {
  const list = document.getElementById("daylist");
  const visible = days.filter((d) => (showPast || d.date >= TODAY_STR) && d.assignments.length);
  list.innerHTML = visible.length
    ? visible.map(dayHTML).join("")
    : `<li class="daylist__empty">No assignments to show${showPast ? "" : " — check back soon"}.</li>`;
}

/* ---------- Render: Legend ---------- */

function renderLegend() {
  const el = document.getElementById("legend");
  if (calendars.length <= 1) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = calendars
    .map((c) => `<span class="cal-chip" style="--accent:${c.color};--accent2:${c.color2 || c.color}">${escapeHTML(c.label)}</span>`)
    .join("");
}

/* ---------- Jumper ---------- */

function fmtCount(n) { return `${n} assignment${n === 1 ? "" : "s"}`; }

function populateJumper() {
  const list = document.getElementById("jumperList");
  const items = days.filter((d) => (showPast || d.date >= TODAY_STR) && d.assignments.length);

  let html = "";
  let lastMonth = "";
  for (const d of items) {
    const month = parseISO(d.date).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    if (month !== lastMonth) { html += `<li class="jumper__month">${month}</li>`; lastMonth = month; }
    const isToday = d.date === TODAY_STR;
    html += `
      <li class="jumper__item">
        <button data-date="${d.date}" class="${isToday ? "is-current" : ""}">
          <span>${escapeHTML(fmtDateShort(d.date))}${isToday ? " · Today" : ""}</span>
          <span class="day-meta">${fmtCount(d.assignments.length)}</span>
        </button>
      </li>`;
  }
  list.innerHTML = html || `<li class="jumper__empty">No days to show.</li>`;

  const pastCount = days.filter((d) => d.date < TODAY_STR && d.assignments.length).length;
  const toggle = document.getElementById("jumperPastToggle");
  toggle.hidden = pastCount === 0;
  toggle.textContent = showPast ? "Hide past days" : `Show ${pastCount} past day${pastCount === 1 ? "" : "s"}`;

  list.querySelectorAll("button[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("jumperDialog").close();
      scrollToDay(btn.dataset.date);
    });
  });

  const cur = list.querySelector(".is-current") || list.querySelector("button[data-date]");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function scrollToDay(date) {
  const el = document.getElementById(`day-${date}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.animate(
      [{ backgroundColor: "rgba(89,184,218,0.18)" }, { backgroundColor: "transparent" }],
      { duration: 1400, easing: "ease-out" }
    );
  }
}

/* ---------- Footer ---------- */

function setLastUpdated(iso) {
  const el = document.getElementById("lastUpdated");
  if (!el) return;
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) { el.textContent = ""; return; }
  const stamp = d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
  el.textContent = `Updated ${stamp}`;
}

/* ---------- Wiring ---------- */

function renderAll() {
  renderHero();
  renderLegend();
  renderDayList();
}

function setupNav() {
  document.getElementById("todayBtn").addEventListener("click", () => {
    const target = findDay(TODAY_STR)?.assignments.length ? TODAY_STR
      : nextDayWithAssignments(TODAY_STR)?.date;
    if (target) scrollToDay(target);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  const dialog = document.getElementById("jumperDialog");
  document.getElementById("jumpBtn").addEventListener("click", () => {
    populateJumper();
    dialog.showModal();
  });
  document.getElementById("jumperPastToggle").addEventListener("click", () => {
    showPast = !showPast;
    renderDayList();
    populateJumper();
  });

  document.getElementById("themeBtn").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "ink" ? "paper" : "ink";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("wia-theme", next); } catch (e) { /* ignore */ }
  });
}

/* ---------- Boot ---------- */

async function boot() {
  try {
    const res = await fetch("schedule.json", { cache: "no-cache" });
    const data = await res.json();
    days = data.days || [];
    calendars = data.calendars || [];
    generatedAt = data._generatedAt || "";
  } catch (err) {
    console.warn("Could not load schedule.json.", err);
    days = [];
  }

  calMap = new Map(calendars.map((c) => [c.id, c]));
  days.sort((a, b) => a.date.localeCompare(b.date));

  setupNav();
  renderAll();
  setLastUpdated(generatedAt);
}

boot();
