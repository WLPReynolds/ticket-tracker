// train-status.js — Point status, Staff overrides, journey-state notifications, formation display.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// Builds the "where is this train now" timeline: every calling point in
// order, with a marker showing roughly where the train sits between the
// last-passed and next-due point, and any delay/cancellation reason
// shown alongside the relevant station. This is deliberately a simple
// ordered list, not a geographic map — no station coordinates needed
// beyond what Darwin already tells us about calling order and timing.
// Works out a plain-language status for one calling point, using
// whatever Darwin actually gave us — a literal status word ("On time",
// "Delayed", "Cancelled") or a specific time to compare against schedule.
function describePointStatus(schedTime, liveTime, isCancelled){
  if (isCancelled) return { text: 'Cancelled', color: '#ff8b7e', minutesLate: null, minutesEarly: 0, confirmed: true };
  // No live time at all, or it's identical to schedule because that's
  // literally what got used as the fallback — this is the one case where
  // we genuinely don't know anything, as opposed to every branch below,
  // where Darwin gave us something real (even if just a status word).
  if (!liveTime || liveTime === schedTime) return { text: 'On time', color: 'var(--good)', minutesLate: 0, minutesEarly: 0, confirmed: false };
  if (liveTime === 'On time') return { text: 'On time', color: 'var(--good)', minutesLate: 0, minutesEarly: 0, confirmed: true };
  if (liveTime === 'Delayed') return { text: 'Delayed', color: '#ff8b7e', minutesLate: null, minutesEarly: 0, confirmed: true };
  if (!liveTime.includes(':')) return { text: liveTime, color: 'var(--ink-dim)', minutesLate: null, minutesEarly: 0, confirmed: true };
  // A live time with no scheduled time to compare against — Darwin has
  // occasionally been seen to omit it on a given poll for a given point.
  // Show what we've got rather than crashing the whole refresh over it.
  if (!schedTime || !schedTime.includes(':')) return { text: liveTime, color: 'var(--ink-dim)', minutesLate: null, minutesEarly: 0, confirmed: true };

  const schedMins = parseInt(schedTime.slice(0,2),10)*60 + parseInt(schedTime.slice(3,5),10);
  const liveMins = parseInt(liveTime.slice(0,2),10)*60 + parseInt(liveTime.slice(3,5),10);
  let diff = liveMins - schedMins;
  // Both times are bare clock values with no date attached, so a point
  // that genuinely crosses midnight (scheduled 23:58, actual 00:01)
  // produces a huge, nonsensical raw difference. No real single-point
  // delay or early-running figure is ever going to be anywhere near 12
  // hours, so treat a difference bigger than that as a midnight wrap and
  // fold it back to the smallest equivalent difference instead.
  if (diff > 720) diff -= 1440;
  else if (diff < -720) diff += 1440;
  if (diff === 0) return { text: 'On time', color: 'var(--good)', minutesLate: 0, minutesEarly: 0, confirmed: true };
  if (diff < 0){
    // Genuinely left ahead of schedule — rare, but worth calling out
    // distinctly rather than folding into "on time", since an early
    // departure is the one case where that label could actively mislead
    // someone who isn't already on the platform.
    return { text: `${Math.abs(diff)} min early`, color: '#7fb8e0', minutesLate: 0, minutesEarly: Math.abs(diff), confirmed: true };
  }
  return { text: `${diff} min late`, color: '#ff8b7e', minutesLate: diff, minutesEarly: 0, confirmed: true };
}

// Remembers the last genuinely CONFIRMED status Darwin gave for a given
// point on a given service, and falls back to it whenever a later poll
// omits the live field entirely. Darwin doesn't reliably repeat a live
// time on every single poll for every point — without this, a point
// that's already been confirmed (delayed, early, or on time) could
// silently regress back to looking unconfirmed the moment one poll
// happens to leave the field blank, even though nothing about the
// train's actual status changed. Confirmed data always overwrites the
// cache immediately, so a genuine change (delay easing off, or getting
// worse) is never held back by this — only a gap in reporting is.
// In-memory only, for the lifetime of the page — same tradeoff already
// accepted for the weather cache further down. That also means it can't
// retroactively fix a point that's already regressed in an
// already-open session before this existed; it needs to observe one
// more real confirmation to start protecting a point from then on.
// Persisted (see loadData/saveConfirmedPointStatusCache below) so it
// survives the app actually being closed and reopened, not just staying
// alive within one page session. Lifetime is deliberately tied to
// trackedTrains' own lifecycle (pruned in saveTrackedTrains, right
// alongside the same 6-hour age-based expiry it already uses) rather
// than to the calendar day — trackedTrains itself has a separate
// day-boundary clear that runs at app-load time, which is a real,
// pre-existing gap for a train tracked before midnight and still
// genuinely running after it (flagged for the backlog, not fixed here).
// Piggybacking a fresh midnight check onto this cache would only
// reproduce that same problem a second time, so this deliberately
// doesn't add one — an entry lives exactly as long as its tracked train
// does, on elapsed time and explicit removal only.
let confirmedPointStatusCache = new Map(); // `${serviceId}|${pointKey}` -> last confirmed describePointStatus() result

// Discards any cached point statuses whose service is no longer in
// trackedTrains — called from saveTrackedTrains() so this always stays
// in step with however that list already decided to shrink, whether
// that's the explicit remove button, the 5-item cap evicting the
// oldest, or its own 6-hour age filter. Never adds its own expiry
// logic on top; it only ever mirrors trackedTrains' current contents.
function pruneConfirmedPointStatusCache(){
  const liveServiceIds = new Set(trackedTrains.map(t => t.serviceId));
  for (const cacheKey of Array.from(confirmedPointStatusCache.keys())){
    const serviceId = cacheKey.slice(0, cacheKey.indexOf('|'));
    if (!liveServiceIds.has(serviceId)) confirmedPointStatusCache.delete(cacheKey);
  }
}
async function saveConfirmedPointStatusCache(){
  try{ localStorage.setItem('confirmed-point-status-cache', JSON.stringify(Array.from(confirmedPointStatusCache.entries()))); }
  catch(e){ /* save failed silently; will retry next change */ }
}

// Last confirmed { platform, hasConfirmed, boardType } seen at the
// *tracked-from* station for a journey, keyed by serviceId — this is
// deliberately just one point per journey (unlike confirmedPointStatusCache
// above, which is per calling-point), since it exists purely to answer
// "has platform or actual-departure/arrival status changed since we last
// checked", which is asked about independently for the tracked-from
// station and (see below) the tracked-to station of a journey, not just
// one point per journey. Same persistence and lifecycle pattern as
// confirmedPointStatusCache: saved to localStorage, pruned whenever
// trackedTrains shrinks, tied to that list's own lifetime rather than
// the calendar day.
let lastSeenJourneyState = new Map(); // `${serviceId}:${crs}` -> { platform, hasConfirmed, boardType }

// Same mirroring rule as pruneConfirmedPointStatusCache — this never
// adds its own expiry, it only ever tracks whatever trackedTrains
// currently contains. Keys are `${serviceId}:${crs}` now (one journey
// can hold both a from-station and a to-station entry), so the
// serviceId is recovered by splitting on the first colon — serviceId
// itself never contains one (SERVICE_ID_PATTERN in the Worker only
// allows letters/digits/underscore).
function pruneLastSeenJourneyState(){
  const liveServiceIds = new Set(trackedTrains.map(t => t.serviceId));
  for (const stateKey of Array.from(lastSeenJourneyState.keys())){
    const serviceId = stateKey.slice(0, stateKey.indexOf(':'));
    if (!liveServiceIds.has(serviceId)) lastSeenJourneyState.delete(stateKey);
  }
}
async function saveLastSeenJourneyState(){
  try{ localStorage.setItem('last-seen-journey-state', JSON.stringify(Array.from(lastSeenJourneyState.entries()))); }
  catch(e){ /* save failed silently; will retry next change */ }
}

// Same idea, one level up: the Staff board's own matched service for a
// journey, persisted so staffPlatformOverrides/staffLiveStatusOverrides
// (see openTrainProgress) can be rebuilt immediately on reopening a
// screen, rather than starting empty and waiting for the first poll to
// rediscover what was already known a moment ago (2026-08-26 — this is
// the exact gap Wayne found: platform/AT PLATFORM detail vanishing on
// close/reopen). One entry per serviceId, not per crs — the
// origin-anchored fetch's match already covers the entire journey in
// one object, so there's nothing to gain from splitting it the way
// lastSeenJourneyState splits per station. Stores only `crs` (which
// station the match's own top-level fields describe) and `match`
// itself — not the full raw board response, which can contain several
// unrelated services from the same board query.
let lastSeenStaffMatch = new Map(); // serviceId -> { crs, match }
function pruneLastSeenStaffMatch(){
  const liveServiceIds = new Set(trackedTrains.map(t => t.serviceId));
  for (const serviceId of Array.from(lastSeenStaffMatch.keys())){
    if (!liveServiceIds.has(serviceId)) lastSeenStaffMatch.delete(serviceId);
  }
}
async function saveLastSeenStaffMatch(){
  try{ localStorage.setItem('last-seen-staff-match', JSON.stringify(Array.from(lastSeenStaffMatch.entries()))); }
  catch(e){ /* save failed silently; will retry next change */ }
}

// Extracts just "HH:MM" from a Staff ISO timestamp ("...T08:09:01" ->
// "08:09") — the same bare-clock-time format schedTime/liveTime already
// use everywhere else in this file. Top-level (not inside
// openTrainProgress) because buildTrainProgress, a separate top-level
// function, needs it too — see its use there, closing backlog #7.
// True when HH:MM clock time a is earlier than b, folding a midnight
// wrap the same way describePointStatus does. False if either isn't a time.
function isClockTimeEarlier(a, b){
  if (typeof a !== 'string' || typeof b !== 'string' || !a.includes(':') || !b.includes(':')) return false;
  let diff = (parseInt(a.slice(0,2),10)*60 + parseInt(a.slice(3,5),10))
           - (parseInt(b.slice(0,2),10)*60 + parseInt(b.slice(3,5),10));
  if (diff > 720) diff -= 1440; else if (diff < -720) diff += 1440;
  return diff < 0;
}
function isoTimeToHHMM(iso){
  return (typeof iso === 'string' && iso.length >= 16) ? iso.slice(11, 16) : null;
}
// 2026-10-07 — like-for-like Staff lateness. Whole minutes between a Staff
// actual and Staff's OWN matching schedule (atd vs std, ata vs sta), seconds
// dropped exactly as isoTimeToHHMM always has (so 26s late is 0, 61s is 1),
// midnight wrap folded. null if either side is missing.
// Why: Darwin's calling-point `st` is the scheduled ARRIVAL for points after
// your boarding station, so measuring Staff's actual DEPARTURE against it
// counted the scheduled dwell as delay — found live at Crewe 2026-10-07
// (st 18:00 = sta, std 18:04, atd 18:04:26 shown as "4 min late").
function staffMinutesDiff(actualIso, schedIso){
  const a = isoTimeToHHMM(actualIso), s = isoTimeToHHMM(schedIso);
  if (!a || !s) return null;
  let diff = (parseInt(a.slice(0,2),10)*60 + parseInt(a.slice(3,5),10))
           - (parseInt(s.slice(0,2),10)*60 + parseInt(s.slice(3,5),10));
  if (diff > 720) diff -= 1440; else if (diff < -720) diff += 1440;
  return diff;
}
// HH:MM clock time shifted by a whole number of minutes, wrapping at midnight.
// Used to express a like-for-like Staff lateness against Darwin's own st, so
// describePointStatus (and everything else reading schedTime) keeps working
// unchanged while reporting the right number of minutes.
// 2026-10-07 — Live Progress time cell, option A: separate arrival and
// departure columns, scheduled on top and actual (or Staff's estimate)
// underneath, at stops where Staff's own scheduled arrival and departure
// differ (a real dwell, e.g. Crewe 18:00 / 18:04). Where Staff knows only
// one side (the service's origin or terminus), returns that single time
// with a small "arr"/"dep" label. Returns null — the row keeps its normal
// time display — when there's no Staff record, or when arrival and
// departure are the same minute (most short stops), so ordinary rows look
// exactly as before. Each column is measured like-for-like (ata vs sta,
// atd vs std) with staffMinutesDiff.
function buildStaffTimeColumnsHtml(status, isCancelled){
  if (!status || isCancelled) return null;
  const sta = isoTimeToHHMM(status.sta), std = isoTimeToHHMM(status.std);
  if (!sta && !std) return null;
  const column = (label, schedIso, actualIso, actualConfirmed, estIso) => {
    const sched = isoTimeToHHMM(schedIso);
    const shownIso = actualConfirmed ? actualIso : estIso;
    const shown = isoTimeToHHMM(shownIso);
    const diff = shown ? staffMinutesDiff(shownIso, schedIso) : null;
    const labelHtml = `<span style="display:block; font-size:11px; letter-spacing:0.4px; text-transform:uppercase; color:var(--ink-dim); opacity:0.8;">${label}</span>`;
    if (!shown || diff === null){
      return `<span style="display:inline-block; min-width:42px; vertical-align:top;">${labelHtml}<span>${sched}</span></span>`;
    }
    const color = diff > 0 ? '#ff8b7e' : 'var(--good)';
    const changed = shown !== sched;
    const schedHtml = changed
      ? `<span style="display:block; text-decoration:line-through; color:var(--ink-dim); font-size:13px;">${sched}</span>`
      : `<span style="display:block; color:var(--ink-dim); font-size:13px;">${sched}</span>`;
    return `<span style="display:inline-block; min-width:42px; vertical-align:top;">${labelHtml}${schedHtml}<span style="color:${color}; font-weight:${actualConfirmed ? 600 : 400};${actualConfirmed ? '' : ' font-style:italic;'}">${shown}</span></span>`;
  };
  const arrCol = sta ? column('arr', status.sta, status.ata, !!status.ataSpecified, status.etaSpecified ? status.eta : null) : '';
  const depCol = std ? column('dep', status.std, status.atd, !!status.atdSpecified, status.etdSpecified ? status.etd : null) : '';
  if (sta && std){
    if (sta === std) return null; // no dwell to show — leave the row as it was
    return `<span style="white-space:nowrap;">${arrCol}<span style="display:inline-block; width:6px;"></span>${depCol}</span>`;
  }
  return arrCol || depCol;
}
function shiftClockTime(hhmm, minutes){
  if (typeof hhmm !== 'string' || !hhmm.includes(':') || !Number.isFinite(minutes)) return null;
  let t = (parseInt(hhmm.slice(0,2),10)*60 + parseInt(hhmm.slice(3,5),10) + minutes) % 1440;
  if (t < 0) t += 1440;
  return `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(t % 60).padStart(2,'0')}`;
}

// Shared AT PLATFORM check, used both by the summary banner and the
// per-row pill (2026-08-26) — factored out after finding they'd been
// computed independently and could disagree: the banner still said
// "Currently between Carlisle and Glasgow Central" / "Running on
// time" while the very same row correctly showed AT PLATFORM, then
// NOT YET DEPARTED, because nothing tied the two together. Returns
// null when Staff doesn't show this crs as arrived-but-not-departed
// at all; otherwise { overrun } — same ataSpecified/atdSpecified/etd
// logic as the row pill, just reusable from both call sites now.
//
// staffDataAge staleness gate added 2026-08-26, following peer review
// after this session's changes: staffLiveStatusOverrides was previously
// left untouched on a failed fetch, an empty/no-match response, or an
// old persisted seed on reopen — with no upper bound on how long since
// stale data could keep pinning the walkback/fraction/pill/summary as
// if the train were still confirmed sitting somewhere it may well have
// left. Age is measured from whenever the maps were last genuinely
// populated from a real match (see refreshStaffPlatformData and the
// seed block in openTrainProgress) — not from "now", and not reset by a
// failed attempt — so several consecutive misses age the data out
// uniformly regardless of which of those three causes it was. Once
// stale, this returns null exactly as if Staff had no data at all,
// letting every consumer (walkback, fraction, pill, both summary
// checks) fall straight back to ordinary Darwin-only behaviour with no
// special-casing needed at any of those call sites.
//
// Also worth being precise about what a non-null result actually
// asserts: etd is Darwin's own prediction, not a guarantee, so
// "overrun: true" means "Staff recorded an arrival but no confirmed
// departure past its own predicted departure time" — not a physical
// certainty that the train is still sitting there. That's the right
// signal for this app's purposes (a real prediction having already
// passed with nothing confirmed since is worth surfacing), but it's a
// prediction-based inference, not direct confirmation, and the pill
// text should be read that way.
// overrunLatch (2026-08-27) — a caller-supplied, cross-poll Set<crs>
// that fixes a real flicker found live at Wolverhampton: Darwin's own
// etd for a train still sitting at a platform is a moving prediction,
// not a fixed fact, and it can get revised both later (pushing the
// "now > etd" comparison back to false) and earlier again on a
// following poll, purely as Darwin's estimate wobbles — with nothing
// about ataSpecified/atdSpecified themselves ever changing. Read
// literally each time, that wobble flipped the AT PLATFORM / NOT YET
// DEPARTED pill back and forth on a train that never actually moved.
// Once `overrun` has been genuinely true for a crs, the latch keeps it
// true regardless of a later etd revision — the pill can only clear by
// the ordinary route (atdSpecified finally true, or the crs ages out/
// stops being ataSpecified), both of which already delete the crs from
// the latch below. Passing null for overrunLatch (from any call site
// that doesn't have one) reproduces the old, un-latched behaviour
// exactly, so this is safe to leave optional.
function staffPlatformStatusFor(crs, staffLiveStatusOverrides, now, staffDataAge, overrunLatch){
  if (!crs) return null;
  if (!staffDataAge || (now - staffDataAge) > STAFF_DATA_MAX_AGE_MS){
    if (overrunLatch) overrunLatch.delete(crs);
    return null;
  }
  const s = staffLiveStatusOverrides[crs];
  if (!s || !s.ataSpecified || s.atdSpecified){
    if (overrunLatch) overrunLatch.delete(crs);
    return null;
  }
  // etdSpecified guard added alongside the latch: buildStaffLiveStatusOverrides
  // stores match.etd even when Staff didn't actually specify it for this
  // poll, so an unspecified/stale etd shouldn't be trusted as a real
  // prediction to compare "now" against.
  // Grace period (2026-09-29): Staff routinely takes several seconds to
  // log a departure, so "now > etd" alone fired within seconds of an
  // on-time departure (found live at Warrington Bank Quay, 16s past
  // etd) and latched a NOT YET DEPARTED pill onto a train that left on
  // time. Overrun now only counts once etd is STAFF_OVERRUN_GRACE_MS
  // behind us; until then it stays the calmer AT PLATFORM pill. Being
  // the single shared check, this covers the row pill and the summary
  // banner together.
  const etdDate = (s.etdSpecified && s.etd) ? new Date(s.etd) : null;
  let overrun = etdDate ? (now - etdDate) > STAFF_OVERRUN_GRACE_MS : false;
  if (overrunLatch){
    if (overrun) overrunLatch.add(crs);
    else if (overrunLatch.has(crs)) overrun = true;
  }
  return { overrun };
}

// Deliberately broader than staffPlatformStatusFor above — that one
// specifically means "still there right now" (ataSpecified but not yet
// atdSpecified); this one just means "Staff confirms the train reached
// this point at all", regardless of whether it's since also departed.
// Added 2026-08-26 to fix a genuinely different bug the earlier
// walkback exception didn't cover: an EARLY-running train (confirmed
// live — Birkdale, ata 70 seconds before its own scheduled time) can
// have Staff confirm arrival while Darwin's own forecast for that same
// point is still technically in the future (Darwin hadn't moved its
// estimate at all, still sitting at the original scheduled time). The
// forward pass that sets lastPassedIdx only ever advances once a
// point's own Darwin-based time has passed "now" — for an early train
// it simply never reaches the point Staff already confirms, so the
// walkback (which only ever pulls lastPassedIdx backward) never gets a
// chance to help; the blob stayed one stop behind while the summary
// text (which separately checks afterLast) correctly said otherwise.
// Same staleness gate as staffPlatformStatusFor, same reasoning.
function staffConfirmsArrival(crs, staffLiveStatusOverrides, now, staffDataAge){
  if (!crs) return false;
  if (!staffDataAge || (now - staffDataAge) > STAFF_DATA_MAX_AGE_MS) return false;
  const s = staffLiveStatusOverrides[crs];
  return !!(s && s.ataSpecified);
}

// Compares a fresh stationBoardForService result against what was last
// seen for this journey and fires exactly two kinds of notification:
// the platform changing (including being confirmed for the first time),
// and the point going from "not yet actual" to "actual" (departed, or
// arrived, depending on which board this came from). Everything else —
// an estimate shifting by a few minutes, delay-reason wording changing —
// is deliberately left alone; the progress screen itself already shows
// that visually, and it's not the kind of thing worth interrupting
// someone for. Written with no DOM access at all, so it's reusable
// as-is by a future Wear OS client polling the same Worker endpoint —
// only the notification mechanism at the end would ever need to differ.
// Stores the full fetched data (not just platform/hasConfirmed) since
// this same persisted state now doubles as the seed for boardOverrides
// when the progress screen is reopened — without it, a platform that
// had appeared would vanish again the instant you closed and reopened,
// because boardOverrides itself only ever lived in that screen's own
// closure and had nothing to rebuild itself from until the next poll.
// 2026-10-08 — notification wording. Title is the station the platform
// belongs to; body is "<time> from|to <other end>: <event>". Previously the
// title named the event and the body the whole route, so a Wigan arrival
// platform read like a Crewe one. `label` is the train screen's displayLabel:
// "HH:MM Origin→Dest"; if it doesn't parse (unexpected shape) the old
// "label: event" body is used under the station title.
function journeyNotifyBody(label, boardType, event){
  const m = /^(\S+)\s+(.+?)→(.+)$/.exec(label || '');
  if (!m) return `${label}: ${event}`;
  const time = m[1], origin = m[2].trim(), dest = m[3].trim();
  // Departure board: you're at the origin, train heads to dest.
  // Arrival board: you're at the destination, train comes from origin.
  return boardType === 'dep' ? `${time} to ${dest}: ${event}` : `${time} from ${origin}: ${event}`;
}
function diffAndNotifyJourneyState(stateKey, label, boardType, freshData, stationName){
  if (!stateKey || !freshData) return;

  const isDeparture = boardType === 'dep';
  const platform = freshData.platform || null;
  const hasConfirmed = !!(isDeparture ? freshData.atd : freshData.ata);
  const title = stationName || 'Train update';

  const prev = lastSeenJourneyState.get(stateKey);
  if (prev){
    // Defensive against an entry saved before this field shape changed
    // (platform/hasConfirmed directly on the entry, no .data) — reads
    // either shape rather than assuming every persisted entry is fresh.
    const prevPlatform = prev.data ? (prev.data.platform || null) : (prev.platform || null);
    const prevHasConfirmed = prev.data ? !!(prev.boardType === 'dep' ? prev.data.atd : prev.data.ata) : !!prev.hasConfirmed;
    if (prevPlatform && platform && prevPlatform !== platform){
      showLocalNotification(title, journeyNotifyBody(label, boardType, `platform changed to ${platform} (was ${prevPlatform})`));
    } else if (!prevPlatform && platform){
      showLocalNotification(title, journeyNotifyBody(label, boardType, `platform ${platform} confirmed`));
    }
    if (!prevHasConfirmed && hasConfirmed){
      const event = isDeparture
        ? (platform ? `departed from platform ${platform}` : 'departed')
        : (platform ? `arrived on platform ${platform}` : 'arrived');
      showLocalNotification(title, journeyNotifyBody(label, boardType, event));
    }
  }

  lastSeenJourneyState.set(stateKey, { boardType, data: freshData });
  saveLastSeenJourneyState();
}

// Finds one calling point's own scheduled time (st) by CRS, searching
// both previousCallingPoints and subsequentCallingPoints — used to get
// a schedTime for stationBoardForService at a station that isn't the
// "here" station buildTrainProgress already reads service.std/sta for
// directly (e.g. a configured train.toLoc partway or further down the
// same physical service's calling points). Returns null if that CRS
// isn't a calling point on this service at all, or has no scheduled
// time recorded — either way, nothing to match a board lookup against.
function findCallingPointSchedTime(service, crs){
  if (!service || !crs) return null;
  const lists = [service.previousCallingPoints, service.subsequentCallingPoints];
  for (const list of lists){
    const points = (list && list[0] && list[0].callingPoint) ? list[0].callingPoint : [];
    const found = points.find(cp => cp.crs === crs);
    if (found && found.st) return found.st;
  }
  return null;
}

// Returns { crs, st } for the true first point of the journey — not
// via service.origin[0], which turned out not to be a reliable field
// on GetServiceDetails' own response shape (confirmed missing/unusable
// live, 2026-08-25 — a wrong assumption on my part, carried over from
// the combined/staff board products, which do have it). This instead
// reuses previousCallingPoints — the exact same array that already
// correctly renders the origin as the very first row on this screen —
// so there's nothing here that isn't already proven to work. Returns
// null when previousCallingPoints is empty, meaning the tracked
// station itself IS the true origin (nothing earlier exists to anchor
// to, nor any need to).
function findServiceOriginPoint(service){
  const points = (service && service.previousCallingPoints && service.previousCallingPoints[0] && service.previousCallingPoints[0].callingPoint) || [];
  return points.length ? points[0] : null;
}

function describePointStatusRemembered(serviceId, pointKey, schedTime, liveTime, isCancelled){
  const status = describePointStatus(schedTime, liveTime, isCancelled);
  if (isCancelled || !serviceId || !pointKey) return status; // cancellation is unambiguous either way; no key to remember against
  const cacheKey = `${serviceId}|${pointKey}`;
  if (status.confirmed){
    confirmedPointStatusCache.set(cacheKey, status);
    return status;
  }
  const remembered = confirmedPointStatusCache.get(cacheKey);
  return remembered || status;
}

// Adds a number of minutes to an "HH:MM" string, wrapping correctly
// across midnight — used to infer a real time for an already-passed
// point that Darwin only gave a generic "On time" word for, despite the
// service clearly running late overall.
function addMinutesToTime(hhmm, mins){
  if (!hhmm || !hhmm.includes(':')) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const total = ((h * 60 + m + mins) % 1440 + 1440) % 1440;
  const nh = Math.floor(total / 60), nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

// Vehicle-count → coach-letter lookup for Avanti's current declared
// fleet, sourced and cross-checked against Avanti's own "Get to know
// our Evero trains" material, RAIL magazine's 805/807 launch coverage,
// and a RailUK Forums thread on Pendolino coach lettering (see
// avanti-planned-formation-spec.md for the full sourcing notes — this
// table is the same one that spec built for the now-removed planned-
// formation feature; only its use here is new). Every vehicle count
// below is unique across the current fleet, so the plain `length`
// number alone is enough to pick the right sequence — no unit/headcode
// lookup needed.
const AVANTI_LENGTH_LETTERS = {
  5: ['A','B','C','D','J'],                       // 805/0
  7: ['A','B','C','D','E','H','J'],                // 807/0
  9: ['A','B','C','D','E','F','H','J','K'],        // 390/0
  10: ['A','B','C','D','J','L','M','N','P','K'],   // 805/0+805/0 coupled
  11: ['A','B','C','D','E','F','U','G','H','J','K'], // 390/1
};

// Returns the fallback letter sequence for a service, or null if the
// fallback doesn't apply — either because real `formation.coaches[]`
// data already exists (real data always takes precedence, so the
// fallback is irrelevant), or because this isn't an Avanti service, or
// because `length` doesn't match one of the fleet's known vehicle
// counts. Shared between buildFormationHtml (the strip itself) and the
// operator-line footnote below, so the two can never disagree about
// whether the fallback is active for a given service.
function getLengthOnlyFormationLetters(service){
  const coaches = service && service.formation && Array.isArray(service.formation.coaches) ? service.formation.coaches : null;
  if (coaches && coaches.length) return null;
  const isAvanti = !!(service && service.operatorCode === 'VT');
  const length = service && typeof service.length === 'number' ? service.length : null;
  return (isAvanti && length) ? (AVANTI_LENGTH_LETTERS[length] || null) : null;
}

// Side-profile nose cone, prepended once ahead of coach A in both tiers
// below. Direction of travel is always left (Wayne's screen-orientation
// steer, 2026-09-17): the roofline stays full height at the back (the
// edge touching coach A) and slopes down to a low point at the front,
// matching a Pendolino/Avanti-style nose rather than a centred point.
// This also settles what used to be an explicit unknown in tier 1 below
// (which physical end is the "front") — both tiers put the nose at the
// leading (left-hand) end of whatever order is displayed. In tier 2 that
// is NOT always coach A any more: on Wayne's PM (Wigan→Crewe) trains A
// is the rear coach, so the fallback letters are displayed reversed and
// the nose sits beside the last letter (see shouldReverseFallbackLetters).
function buildNoseSvg(){
  return `<div style="flex:0 0 auto; margin-right:2px; display:flex; align-items:center;"><svg width="22" height="34" viewBox="0 0 22 34" style="display:block;"><path d="M22,0 L5,32 Q3,34 6,34 L22,34 Z" fill="color-mix(in srgb, var(--ink) 45%, var(--tile))" stroke="var(--line)" stroke-width="1"/></svg></div>`;
}

// Whether the tier-2 (length-only) coach letters should be displayed in
// reverse (last letter first, A at the rear). Wayne's rule (2026-09-21):
// on AM trains (Crewe→Wigan) coach A normally leads; on PM trains
// (Wigan→Crewe) coach A is normally the rear coach. Darwin's own
// `isReverseFormation` flag inverts whichever default applies — an AM
// train in reverse formation shows A last, a PM train in reverse
// formation shows A first. Only used for the fallback: real
// formation.coaches[] data is displayed exactly as Darwin sends it.
//
// Direction comes from train.direction ('AM'|'PM') when the caller has
// it (the configured-train path does), otherwise it's inferred from the
// CRS pair — the tracked-train and recovery paths pass fromLoc/toLoc
// but no direction tag. Anything that isn't the Wigan/Crewe commute
// (unknown direction) is left in the natural A-first order rather than
// guessed at.
function shouldReverseFallbackLetters(train, service){
  let dir = train && (train.direction === 'AM' || train.direction === 'PM') ? train.direction : null;
  if (!dir && train){
    const from = train.fromLoc, to = train.toLoc;
    if (from === 'CRE' && (!to || to === 'WGN')) dir = 'AM';
    else if (from === 'WGN' && (!to || to === 'CRE')) dir = 'PM';
  }
  if (!dir) return false;
  const isReverseFormation = !!(service && service.isReverseFormation);
  return (dir === 'PM') !== isReverseFormation;
}

// Coach formation strip, side-on view (Wayne's steer, 2026-09-17):
// nose cone (buildNoseSvg above) followed by a horizontal scroll of
// shorter coach boxes — no connecting line between coaches, matching a
// station platform display rather than a top-down diagram. Two data
// tiers, tried in order:
//
// 1. Real per-coach data from GetServiceDetails' `formation.coaches[]`
//    — full detail (class, loading, Darwin's own coach number/letter).
//    Not guaranteed on every service; Avanti doesn't currently send it.
//    Deliberately displays whatever `coach.number` Darwin sends
//    verbatim (rather than re-lettering ourselves A/B/C...) since some
//    operators may already send letters through that field —
//    unconfirmed until a real example turns up (see
//    buildFormationDebugHtml below for checking that).
//
// 2. Fallback: Darwin's plain top-level `length` field — confirmed live
//    (2026-09-16) to be populated on at least some Avanti services even
//    when `formation.coaches[]` stays empty — mapped through
//    AVANTI_LENGTH_LETTERS via getLengthOnlyFormationLetters above.
//    This only labels the coaches; there's no class/loading info in
//    this tier, since that genuinely isn't in this data.
function buildFormationHtml(service, train){
  const coaches = service && service.formation && Array.isArray(service.formation.coaches) ? service.formation.coaches : null;
  if (coaches && coaches.length){
    const anyFirstClass = coaches.some(c => c.coachClass && /first/i.test(c.coachClass));
    const boxes = coaches.map((c) => {
      const isFirstClass = c.coachClass && /first/i.test(c.coachClass);
      const label = (c.number !== undefined && c.number !== null && c.number !== '') ? escapeHtml(String(c.number)) : '?';
      let loadingBar = '';
      if (c.loadingSpecified && typeof c.loading === 'number'){
        const pct = Math.max(0, Math.min(100, c.loading));
        const barColor = pct >= 70 ? '#e05a4e' : (pct >= 35 ? 'var(--amber)' : 'var(--good)');
        loadingBar = `<div style="position:absolute; left:3px; right:3px; bottom:2px; height:3px; border-radius:2px; background:rgba(255,255,255,0.15); overflow:hidden;"><div style="width:${pct}%; height:100%; background:${barColor};"></div></div>`;
      }
      return `<div style="flex:0 0 auto; position:relative; width:36px; height:34px; margin-right:2px; background:${isFirstClass ? 'color-mix(in srgb, var(--amber) 20%, var(--tile))' : 'var(--tile)'}; border:1px solid var(--line); border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; color:var(--ink);">${label}${loadingBar}</div>`;
    }).join('');
    return `
      <div id="train-progress-formation" style="margin-bottom:10px;">
        <div style="font-size:11px; color:var(--ink-dim); margin-bottom:4px;">${coaches.length} coach${coaches.length === 1 ? '' : 'es'}${anyFirstClass ? ' · amber = 1st class' : ''}</div>
        <div style="display:flex; align-items:center; overflow-x:auto; padding-bottom:2px;">${buildNoseSvg()}${boxes}</div>
      </div>`;
  }

  const baseLetters = getLengthOnlyFormationLetters(service);
  if (!baseLetters){
    return `<div id="train-progress-formation" style="margin-bottom:10px; font-size:11px; color:var(--ink-dim);">Coach information not available for this service</div>`;
  }
  const letters = shouldReverseFallbackLetters(train, service) ? baseLetters.slice().reverse() : baseLetters;
  const boxes = letters.map((letter) => {
    return `<div style="flex:0 0 auto; position:relative; width:36px; height:34px; margin-right:2px; background:var(--tile); border:1px solid var(--line); border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; color:var(--ink);">${letter}</div>`;
  }).join('');
  return `
    <div id="train-progress-formation" style="margin-bottom:10px;">
      <div style="font-size:11px; color:var(--ink-dim); margin-bottom:4px;">${letters.length} coaches*</div>
      <div style="display:flex; align-items:center; overflow-x:auto; padding-bottom:2px;">${buildNoseSvg()}${boxes}</div>
    </div>`;
}

// Debug-only raw view of exactly what GetServiceDetails sent back for
// formation — separate from the coach-strip rendering above so it's
// possible to confirm the real field shapes (e.g. whether `number` ever
// actually contains a letter) even on services the pretty display can't
// yet render anything useful for.
function buildFormationDebugHtml(service, showRawDebug, fetchedServiceId){
  if (!showRawDebug) return '';
  const hasFormation = !!(service && service.formation);
  let body;
  if (hasFormation){
    body = JSON.stringify(service.formation, null, 2);
  } else {
    const isAvanti = !!(service && service.operatorCode === 'VT');
    const length = service && typeof service.length === 'number' ? service.length : null;
    const usingFallback = isAvanti && length && AVANTI_LENGTH_LETTERS[length];
    body = usingFallback
      ? `(no "formation" field — showing length-only fallback: length=${length}, operatorCode=VT)`
      : `(no "formation" field in this GetServiceDetails response — length=${length ?? '·'}, operatorCode=${(service && service.operatorCode) || '·'})`;
  }
  return `<div id="train-progress-formation-debug" style="font-family:monospace; font-size:10px; color:#6a7a8a; white-space:pre-wrap; margin-bottom:10px; max-height:160px; overflow-y:auto; border:1px dashed var(--line); border-radius:6px; padding:6px;">formation debug:
serviceId: ${escapeHtml(fetchedServiceId || (service && service.serviceID) || '·')}
${escapeHtml(body)}</div>`;
}
