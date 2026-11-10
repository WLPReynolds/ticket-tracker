// util.js — Date keys, London time helpers, escapeHtml, clamps, distanceKm, showToast, closeAllModals, openExternalLink.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// A filled circle with a white checkmark, GitHub-style — used to show a
// delay repay claim's status inline. Green for confirmed, grey for
// started-but-not-yet-confirmed.
function checkCircleIcon(color){
  return `<svg viewBox="0 0 16 16" width="15" height="15" style="vertical-align:-2px;"><circle cx="8" cy="8" r="8" fill="${color}"/><path d="M4.3 8.3 L6.8 10.6 L11.6 5.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
}

function fmtKey(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function parseKey(k){
  const [y,m,d] = k.split('-').map(Number);
  return new Date(y, m-1, d);
}
function isWeekend(d){
  const wd = d.getDay(); // 0 Sun, 6 Sat
  return wd === 0 || wd === 6;
}
function addDays(d, n){
  const nd = new Date(d);
  nd.setDate(nd.getDate()+n);
  return nd;
}
// UK regulated fares changes have long landed on the first Sunday of
// March, but the exact date does occasionally shift and there's
// sometimes a gap between the January announcement and the March
// implementation — so this computes it fresh for whatever year is
// actually current rather than hard-coding a specific date.
function getFirstSundayOfMarch(year){
  const d = new Date(year, 2, 1); // 1 March
  const offsetToSunday = (7 - d.getDay()) % 7; // 0 if 1 March is itself a Sunday
  d.setDate(1 + offsetToSunday);
  return d;
}
function dayNameShort(d){
  return d.toLocaleDateString('en-GB', { weekday: 'short' });
}
function dateLabel(d){
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
function dateLabelShort(d){
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function clampPollBeforeDepartureMin(v){
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 5;
  return Math.min(POLL_BEFORE_DEPARTURE_MIN_MAX, Math.round(n));
}
function clampPollCheckInIntervalMin(v){
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 15;
  return Math.min(POLL_CHECK_IN_INTERVAL_MIN_MAX, Math.round(n));
}

// ---------------------------------------------------------------------
// Avanti planned carriage formation — REMOVED (2026-09-16)
// ---------------------------------------------------------------------
// Previously filled the gap when Darwin's formation.coaches[] is absent
// (which for Avanti is always) using Avanti's own periodically-published
// static "Train Plan" file. Removed on Wayne's request: in practice it
// was consistently wrong — showing a 9-coach "planned" formation on
// services he was actually riding as 11 coaches, with only occasional
// 9. Whatever this static file represents (an alternative/fallback
// formation, an out-of-date diagram, or something else), it wasn't
// tracking what's actually running, and a confidently-labelled wrong
// answer is worse than showing nothing.
//
// No replacement needed: buildFormationHtml() below already shows live
// formation.coaches[] whenever a service actually reports it. If Avanti
// ever starts populating that field (or any live "length" field Darwin
// exposes), it appears automatically with no further changes — that was
// always the higher-priority source; this section only ever ran when it
// had nothing to show.
//
// Removed in full: CURRENT_FORMATION_PLAN, FORMATION_LETTERING,
// plannedFormationData/plannedFormationFetchPromise, loadPlannedFormationData,
// dayTypeForDate, findPlannedFormationEntry, letteringKeyForVariant,
// lettersForPlannedEntry, buildPlannedFormationHtml,
// maybeFlagLiveAvantiFormationDetected, isFormationPlanStale, and the
// eager loadPlannedFormationData() call. The bundled
// formation-plan-may-2026-tt.json asset is no longer fetched by this file
// and can be deleted from the repo whenever convenient — not removed as
// part of this change since deleting files is outside what editing
// index.html can do.

// Haversine formula — great-circle distance between two lat/lon points, in km.
function distanceKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
// A real anchor-tag click, not window.open() — on a PWA running in
// standalone/installed mode, Android Chrome sometimes treats a
// JS-triggered window.open() as a transient in-app overlay (closing it
// destroys it entirely, with no way back), whereas a genuine link click
// is occasionally handled as a proper external navigation into the
// actual browser instead — independently switchable, the way opening a
// link normally works. Not guaranteed either way; this is a real
// platform behaviour outside what a web app can fully dictate, worth
// trying rather than promising it'll definitely change anything.
function openExternalLink(url){
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
function clampGeofenceRadius(v){
  const n = Number(v);
  if (!Number.isFinite(n) || n < GEOFENCE_RADIUS_MIN_M) return GEOFENCE_RADIUS_MIN_M;
  return Math.min(GEOFENCE_RADIUS_MAX_M, Math.round(n));
}

// Shows a local notification via the service worker, which is the more
// reliable path for installed PWAs on Android compared to the plain
// Notification constructor.
async function showLocalNotification(title, body, tag){
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try{
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag, renotify: false });
  }catch(e){ /* notification failed silently — not critical */ }
}

// Closes any currently-open modal sheet — used so tapping a different
// bottom-nav tab swaps screens cleanly rather than stacking them.
function closeAllModals(){
  // A plain .remove() below would rip out train-progress's DOM node
  // without going through its own cleanup — leaving its refresh timer
  // and visibility listener running invisibly in the background. Give it
  // a chance to close itself properly first.
  if (activeTrainProgressCleanup){
    activeTrainProgressCleanup();
    activeTrainProgressCleanup = null;
  }
  document.querySelectorAll('.modal-overlay').forEach(o => o.remove());
}

function escapeHtml(s){
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// How many minutes from now until an "HH:MM" scheduled time, same-day —
// same simple local-clock diff checkLikelyTrain/checkLikelyArrival
// already use elsewhere (see their own nowMinutes lines), not the
// Worker's UTC/BST-aware ukLocalTimeToEpoch, since this only ever runs
// in the browser's own local timezone. Returns null for anything that
// doesn't parse, and a negative number for a time already passed today
// — callers deciding whether a service is likely just "not yet
// activated" should only act on a positive result; a negative one means
// the service should already be running; assumes today's date, so this
// is not meant for a schedTime that's actually for tomorrow.
function minutesUntilLocalTime(hhmm){
  if (typeof hhmm !== 'string' || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [hh, mm] = hhmm.split(':').map(Number);
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return (hh * 60 + mm) - nowMinutes;
}

// Gets a one-off position without prompting unnecessarily — only called
// when we're already inside a relevant time window, so the permission
// prompt (if it appears at all) shows up with context, not on every
// random app open.
function getCurrentPositionOnce(){
  return new Promise((resolve) => {
    if (!navigator.geolocation){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// ---- UK wall-clock helpers ----------------------------------------------
// Darwin sends every schedule/live time as UK wall-clock, but the device
// running this app isn't guaranteed to be in the UK's own timezone (e.g.
// while travelling). Building "h:m today" via Date.setHours()/getHours()
// implicitly trusts the device's own zone, which silently drifted every
// schedule time, countdown, and clock label by exactly the device/UK
// offset — found live while Wayne was a timezone ahead of the UK on
// holiday. These helpers resolve UK wall-clock values against a real,
// zone-correct instant instead, via Intl's own BST/GMT transition dates
// rather than a hand-rolled DST rule.

// The UK's own UTC offset, in minutes, at the given real instant —
// +60 during BST, 0 during GMT.
function londonOffsetMinutes(date){
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', timeZoneName: 'shortOffset'
  }).formatToParts(date);
  const tz = parts.find(p => p.type === 'timeZoneName');
  const m = tz && tz.value.match(/GMT([+-]\d+)?/);
  return (m && m[1] ? parseInt(m[1], 10) : 0) * 60;
}

// year/month(1-based)/day/hour/minute as they actually read on a UK wall
// clock at the given real instant — the zone-correct equivalent of
// date.getFullYear()/getMonth()/getDate()/getHours()/getMinutes(), which
// only ever give the device's own zone.
function londonParts(date){
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const get = t => parseInt(parts.find(p => p.type === t).value, 10);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

// 'YYYY-MM-DD' for the given real instant's UK calendar day — the
// zone-correct equivalent of fmtKey(new Date()) for anything keyed
// against "today" as the UK, not the device, understands it.
function londonDateKey(date){
  const p = londonParts(date);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}

// The real instant for "h:m UK wall-clock time, on referenceDate's own
// UK calendar day" — the zone-correct replacement for
// `new Date(referenceDate); d.setHours(h, m, 0, 0)`, which silently set
// h:m against the device's own zone instead of the UK's. Builds a UTC
// guess first, then corrects using the real UK offset for that
// approximate instant — right for all but the rare instant of the
// BST/GMT transition itself, which doesn't matter here.
function londonWallClockOn(referenceDate, h, m){
  const { year, month, day } = londonParts(referenceDate);
  const guessUtc = Date.UTC(year, month - 1, day, h, m, 0, 0);
  const offsetMin = londonOffsetMinutes(new Date(guessUtc));
  return new Date(guessUtc - offsetMin * 60000);
}

// Converts a train's live status (etd/eta, or "On time") for today into
// an actual Date object, so it can be compared against the current time.
function liveTimeToDate(hhmm, referenceDate){
  if (!hhmm || hhmm.length < 4) return null;
  const h = parseInt(hhmm.slice(0,2), 10), m = parseInt(hhmm.slice(2,4), 10);
  if (isNaN(h) || isNaN(m)) return null;
  return londonWallClockOn(referenceDate, h, m);
}

// A bare "HH:MM" could plausibly belong to yesterday, today, or tomorrow
// relative to referenceDate — this picks whichever is actually closest.
// Extracted from the midnight-crossing fix in buildTrainProgress (still
// used there for the first calling point) so the same reasoning can be
// reused anywhere else a scheduled time needs to be compared against
// "now" — e.g. the polling cadence, which had its own, simpler
// same-day-only version of this that broke for a service due just after
// midnight.
function closestDateForTime(hhmm, referenceDate){
  const base = liveTimeToDate(hhmm, referenceDate);
  if (!base) return null;
  let best = base, bestDiff = Math.abs(best.getTime() - referenceDate.getTime());
  const h = parseInt(hhmm.slice(0,2), 10), m = parseInt(hhmm.slice(2,4), 10);
  for (const dayOffset of [-1, 1]){
    // Shift the real instant by a whole day first, then re-resolve h:m
    // against *that* instant's own UK calendar day — correct regardless
    // of the device's zone, unlike mutating date/hour components directly.
    const shiftedRef = new Date(referenceDate.getTime() + dayOffset * 24*60*60*1000);
    const candidate = londonWallClockOn(shiftedRef, h, m);
    const diff = Math.abs(candidate.getTime() - referenceDate.getTime());
    if (diff < bestDiff){ bestDiff = diff; best = candidate; }
  }
  return best;
}

// Unlike closestDateForTime (nearest in either direction — right for
// "what's the sched time near this known moment"), Emergency Routes
// leg-chaining needs strictly forward resolution: "the next occurrence
// of this clock time at or after cursor" — e.g. a 00:12 service found
// while cursor is 23:50 the evening before must resolve to *tomorrow's*
// 00:12, never today's (which already passed). Accepts "HH:MM" (Darwin's
// std/sta/et/at format) or plain "HHMM".
function nextDateForTime(timeStr, cursor){
  if (!timeStr) return null;
  const clean = timeStr.replace(':', '');
  let d = liveTimeToDate(clean, cursor);
  if (!d) return null;
  if (d.getTime() < cursor.getTime()) d = new Date(d.getTime() + 24*60*60*1000);
  return d;
}

// One-off transient toast, e.g. for showing a decoded delay reason after
// tapping a delay cell. Stacks harmlessly if called again before the
// previous one has faded — each call owns its own element and timer —
// though callers should generally avoid firing several in a row.
let toastDismissTimer = null;
function showToast(text){
  const existing = document.getElementById('app-toast');
  if (existing){
    existing.remove();
    if (toastDismissTimer){ clearTimeout(toastDismissTimer); toastDismissTimer = null; }
  }
  const el = document.createElement('div');
  el.id = 'app-toast';
  el.className = 'app-toast';
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  const dismiss = () => {
    el.classList.remove('visible');
    setTimeout(() => { if (el.isConnected) el.remove(); }, 200);
  };
  el.addEventListener('click', dismiss, { once: true });
  toastDismissTimer = setTimeout(dismiss, 4500);
}
