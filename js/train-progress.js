// train-progress.js — openTrainProgress, weather.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

const TRAIN_PROGRESS_REFRESH_MS = 60 * 1000;
// Polling cadence adapts to where the journey actually is, rather than a
// flat 60 seconds throughout regardless of relevance:
// - Before departure, there's normally nothing to poll for at all — the
//   scheduled time hasn't arrived yet, so nothing Darwin reports is
//   likely to change. Polling backs off the further away departure is,
//   down to a configurable minimum check-in interval, then resumes at
//   the normal cadence above once within pollBeforeDepartureMin of
//   scheduled departure (both settings live in the menu — see
//   pollBeforeDepartureMin/pollCheckInIntervalMin and
//   openPollingSettingsEditor).
// - On the final leg (heading to the last calling point before arrival)
//   polling speeds up, so arrival — and the stop-polling cleanup that
//   comes with it — is caught promptly rather than up to a minute late.
const FINAL_LEG_REFRESH_MS = 20 * 1000;

// ---- Weather badges (novelty, live-progress screen only) ----
// Open-Meteo — free, no API key, hourly forecast, good UK coverage via
// the Met Office model among others. Called directly from the client:
// no secret key involved (unlike Darwin), so there's nothing here that
// needs a Cloudflare Worker in front of it.
const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast';
// Same station coordinates the picker resolves names from — one shared
// dataset rather than a second one that could disagree with it.
// A point's forecast doesn't meaningfully change minute to minute, and
// several calling points can round to the same hour — this just avoids
// re-fetching identical data on every 60-second Darwin refresh. Purely
// in-memory: no need for this to survive a page reload.
const weatherCache = new Map(); // `${crs}|${hourKey}` -> { code, temp }
const WEATHER_CACHE_TTL_MS = 20 * 60 * 1000;
const weatherCacheTimestamps = new Map(); // same key -> Date.now() when cached

// WMO weather codes (the standard Open-Meteo reports) collapsed down to
// the four categories asked for — sun, cloud, rain, snow — rather than
// trying to show a distinct icon per one of the ~30 real codes. isDay
// swaps a clear/mostly-clear reading to a moon rather than a sun once
// it's actually dark — Open-Meteo's own astronomical sunrise/sunset
// calculation, not just a guess from the clock. Only clear skies need
// this: cloud/rain/snow look the same regardless of time of day.
function weatherIconForCode(code, isDay){
  if (code === 0 || code === 1) return isDay ? '☀️' : '🌙';
  if ([2,3,45,48].includes(code)) return '☁️';
  if ([71,73,75,77,85,86].includes(code)) return '❄️';
  if ([51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99].includes(code)) return '🌧️';
  return '☁️'; // unrecognised code — cloud is the safest generic fallback
}

// Formats a Date using its *local* wall-clock components (no timezone
// conversion) as "YYYY-MM-DDTHH:mm:ss" — deliberately not toISOString(),
// which forces UTC and would shift the hour whenever BST is in effect.
function localWallClockString(date){
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function hourKeyFor(localWallClock){
  // Both this and Open-Meteo's own hourly.time entries (requested with
  // timezone=Europe/London) are local wall-clock strings in the same
  // "YYYY-MM-DDTHH..." shape — truncating to the hour is enough to match
  // them directly, with no Date parsing or timezone conversion involved
  // on either side.
  return localWallClock.slice(0, 13);
}

// Fetches (or reads from cache) weather for a batch of { idx, crs, dueAt }
// points, returning a Map of idx -> { icon, temp }. Never throws — a
// failure here should just mean no weather badges show up, not that the
// train-tracking screen around it breaks.
async function fetchWeatherForPoints(weatherPoints){
  const results = new Map();
  if (!weatherEnabled || !weatherPoints.length) return results;

  // Station coordinates come from the same cached list the picker uses —
  // but nothing else in the app guarantees it's actually been loaded this
  // session (previously it only got populated as a side effect of opening
  // the debug "Track any train" screen, which is exactly why this worked
  // sometimes and not others). Loading it here, keyed off its own cache,
  // makes weather self-sufficient: instant from localStorage after the
  // very first time ever, one real fetch before that.
  if (!stationIndexCache){
    try{ await loadStationIndex(false); }
    catch(e){ return results; } // no station data at all — nothing to show, fail quietly
  }

  const now = Date.now();
  const toFetch = []; // { idx, crs, lat, lon, hourKey }
  for (const wp of weatherPoints){
    const coords = stationCoordsForCrs(wp.crs);
    if (!coords) continue; // station not in the cached list yet — skip quietly
    const hourKey = hourKeyFor(wp.dueAt);
    const cacheKey = `${wp.crs}|${hourKey}`;
    const cached = weatherCache.get(cacheKey);
    const cachedAt = weatherCacheTimestamps.get(cacheKey);
    if (cached && cachedAt && (now - cachedAt) < WEATHER_CACHE_TTL_MS){
      results.set(wp.idx, cached);
    } else {
      toFetch.push({ idx: wp.idx, crs: wp.crs, lat: coords.lat, lon: coords.lon, hourKey });
    }
  }
  if (!toFetch.length) return results;

  // One request covers every still-uncached point at once — Open-Meteo
  // accepts comma-separated coordinate lists for exactly this. is_day is
  // Open-Meteo's own astronomical sunrise/sunset calculation per hour —
  // used to swap a clear-sky reading to a moon rather than a sun once
  // it's genuinely dark, instead of a sun icon showing up at 23:30.
  const lats = toFetch.map(f => f.lat).join(',');
  const lons = toFetch.map(f => f.lon).join(',');
  const url = `${WEATHER_API_URL}?latitude=${lats}&longitude=${lons}&hourly=temperature_2m,weather_code,is_day&timezone=Europe%2FLondon&forecast_days=2`;
  let data;
  try{
    const resp = await fetch(url);
    if (!resp.ok) return results; // fail quietly — see comment above
    data = await resp.json();
  }catch(e){ return results; }

  // A single-location request returns one object; multiple locations
  // return an array in the same order they were requested in.
  const perLocation = Array.isArray(data) ? data : [data];
  toFetch.forEach((f, i) => {
    const loc = perLocation[i];
    if (!loc || !loc.hourly || !Array.isArray(loc.hourly.time)) return;
    const hourIdx = loc.hourly.time.findIndex(t => t.startsWith(f.hourKey));
    if (hourIdx === -1) return; // requested time outside the 2-day window returned
    const code = loc.hourly.weather_code[hourIdx];
    const temp = loc.hourly.temperature_2m[hourIdx];
    const isDay = Array.isArray(loc.hourly.is_day) ? loc.hourly.is_day[hourIdx] === 1 : true;
    if (code === undefined || temp === undefined || temp === null) return;
    const entry = { icon: weatherIconForCode(code, isDay), temp: Math.round(temp) };
    const cacheKey = `${f.crs}|${f.hourKey}`;
    weatherCache.set(cacheKey, entry);
    weatherCacheTimestamps.set(cacheKey, now);
    results.set(f.idx, entry);
  });
  return results;
}

function openTrainProgress(train, service){
  // See activeTrainProgressCleanup above — never let two of these run
  // at once, since they share element IDs and each runs its own timer.
  if (activeTrainProgressCleanup){
    activeTrainProgressCleanup();
    activeTrainProgressCleanup = null;
  }
  let refreshTimer = null;
  let showRawDebug = false; // off by default — a temporary diagnostic toggle, not for normal use
  let showAllReasons = false; // manual override for the staleness-suppression heuristic, in case it's wrong on a given service
  let lastKnownService = service; // lets the debug toggle rebuild instantly without a fresh network call
  // Warms the shared station-name cache if it isn't already loaded this
  // session (2026-08-26) — without this, a searched (non-configured)
  // train's own tracked-from/to station can show its bare CRS code
  // ("SOP") instead of its real name ("Southport") in the "here" row
  // and the "Arrived at X" summary, since GetServiceDetails' own
  // top-level object has no location-name field for wherever
  // train.fromLoc actually is — only STATION_COORDS (manually-verified
  // Crewe/Wigan only) or this cache can supply one. Same underlying gap
  // already fixed once for weather (see loadStationIndex's own comment
  // there) — this was the other place still just assuming it was
  // already loaded. Fire-and-forget: doesn't block anything else on
  // this screen, and rebuildDisplay() (defined below) picks up the
  // correct name retroactively if this resolves after the first render.
  if (!stationIndexCache){
    loadStationIndex(false)
      .then(() => { if (instanceActive && overlay.isConnected) rebuildDisplay(); })
      .catch(() => {}); // no station data at all — the bare CRS code fallback stays, same as before this fix existed
  }
  // Latest stationBoardForService outcome for each lookup (the pure
  // dep/arr board checks used for platform-change/departed-arrived
  // notifications — one for the tracked-from station, one for the
  // tracked-to station), kept here purely so toggling raw-debug on
  // shows the most recent values straight away rather than waiting for
  // the next poll cycle. Each entry is one of three genuinely different
  // outcomes — matched (data present), explicitly not on that board
  // right now (data: null, not an error — see fetchStationBoardForService's
  // own docblock), or an actual fetch/validation failure (error set) —
  // and the debug line needs to say which, rather than only ever
  // showing the matched case and silently vanishing for the other two.
  // That silent collapse is exactly what made this hard to diagnose:
  // a normal "dropped off this board's rolling window" and a genuine
  // "the Worker rejected the request" looked identical from here.
  let lastBoardDebugFrom = null; // { crs, boardType, schedTime, data, error }
  let lastBoardDebugTo = null;   // { crs, boardType, schedTime, data, error }
  // Phase 2 staff-board comparison — same shape family as the two
  // above, plus { match, serviceCount, raw } from fetchStaffBoardComparison.
  // Strictly read-only: never merged into boardOverrides, never affects
  // rebuildDisplay(). See staff-board-scoping.md.
  let lastStaffDebugFrom = null;
  let lastStaffDebugTo = null;
  // Feeds buildTrainProgress's mergeBoardOverride — the same fetched
  // pure-board data that drives the debug panel and notifications above,
  // now also applied to the actual rendered row for that station. Keyed
  // by crs (not by from/to role) since buildTrainProgress just needs to
  // look a point's own crs up directly. { data, boardType } per entry —
  // same shape as one debug entry, minus the debug-only crs/schedTime
  // fields.
  let boardOverrides = {};
  // Platform-only enrichment, sourced from the Staff (LDBSVWS) board —
  // deliberately kept separate from boardOverrides above rather than
  // merged into it. boardOverrides' merge (mergeBoardOverride) is
  // all-or-nothing per point — platform, liveTime, hasConfirmedActual,
  // isCancelled and reason all come from the same source together —
  // and reusing it here would have quietly started trusting Staff data
  // for confirmed-time/cancellation status on every intermediate point
  // too, not just platform, which is a materially bigger change than
  // "populate platform for all stops" and wasn't the agreed scope for
  // this round (2026-08-26) — that's deliberately being held back for
  // its own separate, later step (the AT PLATFORM work). Keyed by crs.
  // Only ever set wholesale on a successful fetch (see the "from" side
  // fetch below) — never cleared on a transient failure, so a brief
  // Staff outage doesn't blank out platforms that were already known.
  let staffPlatformOverrides = {};
  // Builds a fresh platform-only map from one Staff fetch's full
  // result — the queried station's own top-level entry plus every
  // point in subsequentLocations — filtering out isPass points (junctions),
  // which have no crs and no genuine platform anyway, so they're already
  // excluded by the crs check alone. Deliberately does NOT also exclude
  // platformIsHidden (that was the original filter, removed 2026-08-26)
  // — confirmed live that a genuine calling point (Horden: real crs,
  // isPass: false, real sta/eta) can still carry platformIsHidden: true,
  // most likely meaning National Rail doesn't bother showing it publicly
  // for a small single-platform station, not that the value's wrong or
  // provisional. The whole point of this feature is filling in platform
  // detail that's otherwise missing, so a genuine value is worth
  // surfacing even where its own public display chooses not to.
  // Deliberately a full rebuild each time (the origin-anchored fetch
  // below always covers the entire journey in one response), not a
  // merge forward — a stale platform lingering from an earlier poll
  // after a real change would be worse than briefly having none.
  function buildStaffPlatformOverrides(raw, match){
    const overrides = {};
    if (!raw || !match) return overrides;
    if (raw.crs && match.platform && !match.isPass) overrides[raw.crs] = match.platform;
    const locs = Array.isArray(match.subsequentLocations) ? match.subsequentLocations : [];
    for (const loc of locs){
      if (loc.crs && loc.platform && !loc.isPass) overrides[loc.crs] = loc.platform;
    }
    return overrides;
  }
  // AT PLATFORM support (2026-08-26) — confirmed live three times now
  // (Bryn, Stockport, Rugby) that ataSpecified && !atdSpecified reliably
  // means "arrived, still sitting at the platform". Kept as its own
  // map, same reasoning as staffPlatformOverrides above: this only ever
  // feeds a badge, never boardOverrides/hasConfirmedActual/lastPassedIdx.
  // Stores { ataSpecified, atdSpecified, ata, atd, etd } per crs — the
  // ata/atd raw values (added 2026-08-26, closing backlog #7 below)
  // let the precise-status correction below use a genuine confirmed
  // time rather than just knowing one exists.
  let staffLiveStatusOverrides = {};
  // Timestamp (ms since epoch) of when staffPlatformOverrides/
  // staffLiveStatusOverrides were last genuinely populated from a real
  // match — set only on a successful fetch that actually found the
  // service, or from a fresh-enough persisted seed on open (see below).
  // Deliberately NOT touched on a failed fetch or a no-match response —
  // that's the whole point: staffPlatformStatusFor (see its own
  // declaration) uses this to age the maps out uniformly after
  // STAFF_DATA_MAX_AGE_MS, regardless of which of those two caused the
  // gap. Added 2026-08-26 following peer review, closing a real
  // staleness hole this session's own changes introduced: previously
  // there was no upper bound on how long stale Staff state could keep
  // pinning the walkback/fraction/pill/summary after the train had
  // genuinely moved on and Staff stopped confirming it either way.
  let staffDataAge = null;
  // Cross-poll latch backing staffPlatformStatusFor's overrun flip-flop
  // fix (2026-08-27) — lives here, not inside buildTrainProgress, so it
  // persists across repeated buildTrainProgress calls for the same
  // opened service (each poll rebuilds fresh, but this Set carries
  // forward). Scoped per openTrainProgress instance, same as
  // staffPlatformOverrides/staffLiveStatusOverrides/staffDataAge above,
  // so it naturally starts empty again for a newly opened train.
  let staffOverrunLatch = new Set();
  function buildStaffLiveStatusOverrides(raw, match){
    const overrides = {};
    if (!raw || !match) return overrides;
    // sta/std added 2026-10-07 — Staff's own schedule for each event, so the
    // precise-status corrections compare atd with std and ata with sta
    // (see staffMinutesDiff), never with Darwin's st.
    if (raw.crs) overrides[raw.crs] = { ataSpecified: !!match.ataSpecified, atdSpecified: !!match.atdSpecified, ata: match.ata || null, atd: match.atd || null, sta: match.staSpecified ? (match.sta || null) : null, std: match.stdSpecified ? (match.std || null) : null, eta: match.eta || null, etaSpecified: !!match.etaSpecified, etd: match.etd || null, etdSpecified: !!match.etdSpecified };
    const locs = Array.isArray(match.subsequentLocations) ? match.subsequentLocations : [];
    for (const loc of locs){
      if (loc.crs) overrides[loc.crs] = { ataSpecified: !!loc.ataSpecified, atdSpecified: !!loc.atdSpecified, ata: loc.ata || null, atd: loc.atd || null, sta: loc.staSpecified ? (loc.sta || null) : null, std: loc.stdSpecified ? (loc.std || null) : null, eta: loc.eta || null, etaSpecified: !!loc.etaSpecified, etd: loc.etd || null, etdSpecified: !!loc.etdSpecified };
    }
    return overrides;
  }
  // Closes backlog #7 (removed below) — GetServiceDetails can return
  // the literal string "On time" for a point that Darwin's own more
  // precise products (and now Staff) know departed/arrived a specific
  // number of seconds late, confirmed via a real side-by-side
  // comparison (2026-08-26): Crewe showed "On time" here while Staff's
  // own atd/lateness said 60 seconds late. isoTimeToHHMM (extracting
  // just "HH:MM" from a Staff ISO timestamp) lives at top level, not
  // here — it's needed inside buildTrainProgress, a separate top-level
  // function, not nested inside this closure.
  function formatBoardDebugLine(entry){
    if (!entry) return null;
    const tag = `${entry.crs}/${entry.boardType}[${entry.schedTime ?? '?'}]`;
    if (entry.error) return `${tag}  ERROR: ${entry.error}`;
    if (!entry.data) return `${tag}  not currently on this board`;
    const d = entry.data;
    return [
      tag, `std=${d.std ?? '·'}`, `etd=${d.etd ?? '·'}`,
      `atd=${d.atd ?? '·'}`, `sta=${d.sta ?? '·'}`, `eta=${d.eta ?? '·'}`,
      `ata=${d.ata ?? '·'}`, `platform=${d.platform ?? '·'}`,
    ].join('  ');
  }
  function updateBoardDebugPanel(){
    const el = overlay.querySelector('#train-progress-board-debug');
    if (!el) return;
    if (!showRawDebug){ el.style.display = 'none'; return; }
    const lines = [formatBoardDebugLine(lastBoardDebugFrom), formatBoardDebugLine(lastBoardDebugTo)].filter(Boolean);
    if (lines.length === 0){ el.style.display = 'none'; return; }
    el.innerHTML = lines.join('<br>');
    el.style.display = '';
  }
  // Phase 2 staff-board comparison rendering. Two parts per side: a
  // short summary line (Staff's own std/etd/atd or sta/eta/ata next to
  // whatever the existing pure-board fetch above already returned for
  // the same station — the actual point of the comparison), and the
  // full raw Staff response underneath for whichever side has one, in
  // the same collapsed/scrollable style as buildFormationDebugHtml.
  // Deliberately separate from formatBoardDebugLine/updateBoardDebugPanel
  // above rather than merged into them — this is Phase 2 investigation
  // output, not a permanent fixture, and keeping it structurally
  // distinct makes it trivial to delete cleanly later if the comparison
  // concludes there's nothing further to learn from it.
  // Holds whatever raw JSON is currently on screen in the panel below,
  // for the copy button — kept in this closure rather than read back
  // out of a DOM attribute, since JSON's own quote characters would
  // need their own separate (and easy to get subtly wrong) escaping
  // rules to survive round-tripping through an HTML attribute; a plain
  // JS variable has no such problem.
  let lastStaffRawJson = null;
  function formatStaffCompareLine(entry, boardEntry, label){
    if (!entry) return null;
    const tag = `${label} staff[${entry.schedTime ?? '?'}]`;
    if (entry.error) return `${tag}  ERROR: ${entry.error}`;
    if (!entry.match) return `${tag}  no matching service (${entry.serviceCount ?? 0} services returned, target=${entry.targetTime ?? '?'})`;
    const m = entry.match; // the whole matched service — used for journey-wide facts (subsequentLocations count, futureCancellation)
    const wanted = entry.wanted; // this station's own fields specifically — see extractStaffLocationFields
    if (!wanted) return `${tag}  matched a service, but ${entry.crs} isn't one of its own calling points (unexpected — worth a closer look)`;
    const fields = entry.boardType === 'dep' ? ['std', 'etd', 'atd'] : ['sta', 'eta', 'ata'];
    // platform appended separately, not folded into `fields` — wanted.platform
    // reads straight off the same matched object buildStaffPlatformOverrides
    // already uses live (see its own comment), so this is a display-only
    // addition; the Darwin side falls back the same way the board-debug panel
    // (formatBoardDebugLine) already does, for consistency between the two.
    const staffVals = fields.map(f => `${f}=${wanted[f] ?? '·'}`).join('  ') + `  platform=${wanted.platform ?? '·'}`;
    const darwinVals = (boardEntry && boardEntry.data)
      ? fields.map(f => `${f}=${boardEntry.data[f] ?? '·'}`).join('  ') + `  platform=${boardEntry.data.platform ?? '·'}`
      : '(no Darwin pure-board result yet)';
    const flags = [
      wanted.isCancelled ? 'CANCELLED' : null,
      m.futureCancellation ? 'FUTURE-CANCEL' : null,
      wanted.lateness !== undefined ? `lateness=${wanted.lateness}` : null,
    ].filter(Boolean).join(' ');
    const points = Array.isArray(m.subsequentLocations) ? m.subsequentLocations.length : 0;
    return [
      `${tag} — ${points} subsequentLocations${flags ? `  ${flags}` : ''}`,
      `&nbsp;&nbsp;staff:  ${staffVals}`,
      `&nbsp;&nbsp;darwin: ${darwinVals}`,
    ].join('<br>');
  }
  function updateStaffDebugPanel(){
    const el = overlay.querySelector('#train-progress-staff-debug');
    if (!el) return;
    if (!showRawDebug){ el.style.display = 'none'; return; }
    const lines = [
      formatStaffCompareLine(lastStaffDebugFrom, lastBoardDebugFrom, 'from'),
      formatStaffCompareLine(lastStaffDebugTo, lastBoardDebugTo, 'to'),
    ].filter(Boolean);
    if (lines.length === 0){ el.style.display = 'none'; return; }
    // Whichever side has a match — shown once, not per side, to keep
    // this readable; if both sides ever need inspecting at once the
    // summary lines above already show enough to know which one's
    // worth copying via its own dedicated fetch.
    // No visible JSON box any more (backlog #14, 2026-08-26) — now that
    // this data feeds real behaviour (staffPlatformOverrides) rather
    // than being purely a debug comparison, the big always-rendered
    // text block stopped earning its screen space for day-to-day use.
    // The copy button stays, specifically so a real response can still
    // be grabbed and brought back for analysis whenever that's useful —
    // this whole panel (including this fetch's debug plumbing) is
    // meant to come out entirely once that's no longer needed.
    const rawSource = (lastStaffDebugFrom && lastStaffDebugFrom.match) ? lastStaffDebugFrom
      : (lastStaffDebugTo && lastStaffDebugTo.match) ? lastStaffDebugTo
      : null;
    lastStaffRawJson = rawSource ? JSON.stringify(rawSource.match, null, 2) : null;
    const copyHtml = rawSource
      ? `<div style="margin-top:6px;"><span id="train-progress-staff-copy" style="text-decoration:underline; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">Copy raw JSON</span></div>`
      : '';
    el.innerHTML = `staff (LDBSVWS) comparison:<br>${lines.join('<br>')}${copyHtml}`;
    el.style.display = '';
    // Re-queried and re-bound every render rather than delegated once —
    // this whole panel's innerHTML gets replaced wholesale above, which
    // would silently detach any listener bound the old-fashioned way.
    // .onclick (a property assignment, not addEventListener) is safe to
    // reassign like this on every call with no listener pile-up.
    const copyBtn = el.querySelector('#train-progress-staff-copy');
    if (copyBtn){
      copyBtn.onclick = async () => {
        if (!lastStaffRawJson) return;
        try{
          await navigator.clipboard.writeText(lastStaffRawJson);
          showToast('Copied raw JSON');
        }catch(e){
          showToast('Copy failed — clipboard unavailable');
        }
      };
    }
  }
  // Cleanup (below) clears the interval, but that alone can't cancel an
  // already-in-flight doRefresh() that's mid-await — without this flag,
  // that stale call could still resolve afterward and write into
  // whatever DOM now has these element IDs, which might belong to a
  // different train's screen by then. Every doRefresh() checks this
  // immediately after each await, before touching anything.
  let instanceActive = true;
  // A second, independent guard: an interval tick and a visibility-wake
  // tick can otherwise overlap and race each other, with whichever
  // network response arrives second silently overwriting the other,
  // regardless of which was actually more recent.
  let refreshInFlight = false;
  // Same idea, scoped to weather: applyWeather() fetches independently of
  // the Darwin refresh cycle above, so an older weather request can still
  // be in flight when a newer Darwin refresh rebuilds the rows. Each
  // render bumps this counter and hands its own value to applyWeather;
  // if the counter's moved on by the time that fetch resolves, its
  // result belongs to a row set (and a lastPassedIdx/fraction) that no
  // longer exists, and gets discarded rather than written in or used to
  // reposition the blob.
  let renderGeneration = 0;
  const serviceId = train.serviceId || service.serviceID || null;
  // Seeded from whatever was last persisted for this journey — without
  // this, boardOverrides starts empty every time the screen opens (it's
  // only ever populated live, in this screen's own closure, as fresh
  // polls come back), so a platform that had already appeared the last
  // time this was open would vanish again until the next poll rediscovers
  // it. lastSeenJourneyState already persists exactly this data, keyed
  // the same way (`${serviceId}:${crs}`), so it doubles as the source
  // to rebuild from here.
  if (serviceId){
    if (train.fromLoc){
      const seedFrom = lastSeenJourneyState.get(`${serviceId}:${train.fromLoc}`);
      if (seedFrom && seedFrom.data) boardOverrides[train.fromLoc] = seedFrom;
    }
    if (train.toLoc && train.toLoc !== train.fromLoc){
      const seedTo = lastSeenJourneyState.get(`${serviceId}:${train.toLoc}`);
      if (seedTo && seedTo.data) boardOverrides[train.toLoc] = seedTo;
    }
    // Same idea, for the Staff-derived platform/AT PLATFORM data
    // (2026-08-26) — without this, staffPlatformOverrides/
    // staffLiveStatusOverrides start empty every time the screen opens,
    // so platform detail that had already appeared the last time this
    // was open would vanish again until the next poll rediscovers it —
    // exactly the gap Wayne found. lastSeenStaffMatch stores
    // { crs, match, fetchedAt } — passing the seed object straight into
    // the two existing build functions (they only ever read raw.crs
    // from their first argument) rebuilds both maps with no new logic
    // needed there.
    //
    // Staleness check added 2026-08-26 following peer review: a seed
    // could otherwise be hours (or, in principle, days) old with
    // nothing to reject it, applied synchronously before the fresh
    // fetch below has even started. Same STAFF_DATA_MAX_AGE_MS/
    // staffPlatformStatusFor gate as every other consumer of this data,
    // just checked at seed-time here rather than at read-time — an
    // old-format seed from before this field existed has no `fetchedAt`
    // at all, which correctly fails this check and is simply never
    // trusted (self-healing on the next successful fetch, no crash, no
    // migration needed).
    const seedStaff = lastSeenStaffMatch.get(serviceId);
    if (seedStaff && seedStaff.match && seedStaff.fetchedAt && (Date.now() - seedStaff.fetchedAt) <= STAFF_DATA_MAX_AGE_MS){
      staffPlatformOverrides = buildStaffPlatformOverrides(seedStaff, seedStaff.match);
      staffLiveStatusOverrides = buildStaffLiveStatusOverrides(seedStaff, seedStaff.match);
      staffDataAge = seedStaff.fetchedAt;
    }
  }
  // Fetches and applies the Staff-derived platform/AT PLATFORM data for
  // one service snapshot — factored out so it can be called both
  // immediately on open (using the `service` this screen was opened
  // with) and from every doRefresh() cycle thereafter (using
  // freshService), without duplicating the fetch logic itself.
  // Added 2026-08-26 specifically so opening the screen doesn't have to
  // wait for the first scheduled refresh before platform detail shows
  // up — the seed block above handles "was this already known from a
  // previous time this screen was open"; this handles "get something
  // fresh straight away regardless". Origin-anchoring logic, filter
  // choices and the reasoning behind them are otherwise unchanged from
  // the original doRefresh-only version.
  function refreshStaffPlatformData(serviceForThis){
    if (!serviceId || !train.fromLoc) return;
    const departsHereNow = !!(serviceForThis.std || serviceForThis.etd || serviceForThis.atd);
    const boardTypeForHereNow = departsHereNow ? 'dep' : 'arr';
    const hereSchedTimeNow = boardTypeForHereNow === 'dep' ? serviceForThis.std : serviceForThis.sta;
    const originPoint = findServiceOriginPoint(serviceForThis);
    const anchorAtOrigin = originPoint && originPoint.crs && originPoint.crs !== train.fromLoc;
    const staffFromQueryCrs = anchorAtOrigin ? originPoint.crs : train.fromLoc;
    const staffFromSchedTime = anchorAtOrigin ? originPoint.st : hereSchedTimeNow;
    const staffFromFilterCrs = anchorAtOrigin ? train.fromLoc : (train.toLoc || undefined);
    const staffFromFilterType = staffFromFilterCrs ? 'to' : undefined;
    const staffFromBoardType = anchorAtOrigin ? 'dep' : boardTypeForHereNow;
    if (!staffFromSchedTime) return;
    fetchStaffBoardComparison(staffFromQueryCrs, staffFromFilterCrs, staffFromFilterType, staffFromBoardType, staffFromSchedTime, serviceForThis.sdd)
      .then(result => {
        const wanted = extractStaffLocationFields(result.raw, result.match, train.fromLoc);
        lastStaffDebugFrom = { crs: train.fromLoc, boardType: boardTypeForHereNow, schedTime: hereSchedTimeNow, ...result, wanted, error: null };
        updateStaffDebugPanel();
        if (result.match){
          staffPlatformOverrides = buildStaffPlatformOverrides(result.raw, result.match);
          staffLiveStatusOverrides = buildStaffLiveStatusOverrides(result.raw, result.match);
          staffDataAge = Date.now();
          lastSeenStaffMatch.set(serviceId, { crs: result.raw.crs, match: result.match, fetchedAt: staffDataAge });
          saveLastSeenStaffMatch();
          rebuildDisplay();
        }
        // If result.match is falsy (fetch succeeded but found no
        // matching service — e.g. genuinely dropped off the board),
        // staffDataAge is deliberately NOT touched here either, same
        // reasoning as the .catch block below: this is one of the two
        // gaps the staleness gate (see staffPlatformStatusFor) exists
        // to close, found via peer review rather than live observation.
        // Previously this branch did nothing at all, silently leaving
        // whatever was already in the maps trusted indefinitely.
      })
      .catch(err => {
        lastStaffDebugFrom = { crs: train.fromLoc, boardType: boardTypeForHereNow, schedTime: hereSchedTimeNow, error: err.message };
        updateStaffDebugPanel();
        // staffPlatformOverrides/staffLiveStatusOverrides deliberately
        // left untouched here — a single transient failure shouldn't
        // blank out platform/AT PLATFORM detail that was already known.
        // staffDataAge is equally deliberately NOT refreshed here, so
        // several consecutive failures age the data out via
        // staffPlatformStatusFor's staleness gate rather than being
        // trusted indefinitely just because nothing ever cleared it.
      });
  }
  refreshStaffPlatformData(service); // immediately, not waiting for the first scheduled refresh — see docblock above
  // Computed early (rather than at its previous spot, right before the
  // overlay markup) because the label below now needs to know whether
  // this station genuinely has its own departure, or whether the
  // tracked/searched station turned out to be an arrival-only point.
  const initial = buildTrainProgress(train, service, showRawDebug, showAllReasons, boardOverrides, staffPlatformOverrides, staffLiveStatusOverrides, staffDataAge, staffOverrunLatch);
  // A configured train's own .label is just its departure time (e.g.
  // "17:31") — fine for the compact board row it came from, but not
  // enough detail once it's the title of this screen, or sitting in the
  // tracked list alongside entries from elsewhere that already show a
  // full route. Computed once, here, and reused for both — previously
  // this only happened for the tracked-list save, leaving the title
  // itself showing just the bare time when opened from "My trains".
  let displayLabel;
  if (train.labelIsFinal){
    // Reopened from the Tracked list — its stored .label was already
    // fully computed (by one of the two branches below) the first time
    // this train was opened, whichever type it was. Reused as-is rather
    // than recomputed: for a configured route specifically, train.label
    // itself already contains the full enriched text at this point
    // (unlike a first-ever open, where it's still just the bare
    // configured time), so re-running that branch would double up into
    // something like "07:27 Crewe→Wigan North Western Crewe→Wigan
    // North Western" instead of leaving well alone.
    displayLabel = train.label;
  } else if (train.toLoc){
    // Manual override first (covers Crewe/Wigan, this app's actual
    // regular stations), then the full station dataset, then the bare
    // code as a last resort. This is your own configured route boundary
    // — kept exactly as configured even if the wider physical train
    // actually starts earlier or continues further, since that's the
    // segment that's actually meaningful to you day to day.
    displayLabel = `${train.label} ${(STATION_COORDS[train.fromLoc] && STATION_COORDS[train.fromLoc].name) || stationNameForCrs(train.fromLoc) || train.fromLoc}→${(STATION_COORDS[train.toLoc] && STATION_COORDS[train.toLoc].name) || stationNameForCrs(train.toLoc) || train.toLoc}`;
  } else if (initial.firstPoint && initial.lastPoint){
    // Any other tracked/searched train — built from the genuine calling
    // points (the same real data shown in the grid below) rather than
    // whatever label happened to be built at search time, which could
    // only ever describe the segment between the searched station and
    // one specific stop, and — for an arrival-only result — could
    // mislead by leading with an arrival time in the exact position
    // every other title uses for a departure time. This reads the same
    // way regardless of whether the search that found it was a genuine
    // departure or an arrival-only result.
    displayLabel = `${initial.firstPoint.schedTime || '?'} ${initial.firstPoint.locationName || '?'}→${initial.lastPoint.locationName || '?'}`;
  } else {
    displayLabel = train.label;
  }

  // Remember this journey so it can still be found and watched later,
  // even after it's rolled off the departure station's own board, or
  // after closing and reopening the app entirely.
  if (serviceId){
    const existing = trackedTrains.find(t => t.serviceId === serviceId);
    const addedAt = existing ? existing.addedAt : Date.now(); // preserve the original tracking time — reopening shouldn't reset how long it's been tracked
    trackedTrains = trackedTrains.filter(t => t.serviceId !== serviceId);
    // toLoc carried through too, not just fromLoc — without it, reopening
    // one of your own configured trains from the Tracked tab loses the
    // context that it's a configured route at all, and falls back to
    // treating it like any other tracked service: titled from the
    // train's genuine physical journey instead of your own configured
    // segment. A Crewe→Wigan commute train that happens to be part of a
    // much longer London Euston→Glasgow Central working would then
    // retitle itself as that wider journey the moment it's reopened from
    // Tracked, despite showing correctly the first time round from Your
    // trains.
    trackedTrains.unshift({ serviceId, label: displayLabel, fromLoc: train.fromLoc, toLoc: train.toLoc || null, addedAt });
    trackedTrains = trackedTrains.slice(0, TRACKED_TRAIN_MAX); // no need to keep more than a handful
    saveTrackedTrains();
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay-full';
  overlay.innerHTML = `
    <div class="modal">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <div class="eyebrow">Live progress</div>
          <h3 style="margin-top:0;">${displayLabel}</h3>
        </div>
        ${train.toLoc ? `<span title="One of your configured trains — this shows your own route, not necessarily the train's full journey" style="color:var(--amber); font-size:22px; line-height:1; margin-top:2px;">★</span>` : ''}
      </div>
      <div id="train-progress-reverse-pill">${service.isReverseFormation ? `<span style="display:inline-block; background:var(--amber); color:#14161f; font-weight:700; font-size:11px; letter-spacing:0.5px; padding:4px 10px; border-radius:20px; margin-bottom:10px;">REVERSE FORMATION</span>` : ''}</div>
      <div class="sub">An estimate based on calling-point times.${debugModeEnabled ? ` <span id="raw-debug-toggle" style="text-decoration:underline; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">Show raw data</span>` : ''}</div>
      <div id="debug-capture-wrap" style="${debugModeEnabled ? '' : 'display:none;'} font-family:monospace; font-size:11px; color:#6a7a8a; border:1px dashed var(--line); border-radius:6px; padding:8px; margin-bottom:10px;"></div>
      <div id="train-progress-refresh-bar-wrap" style="height:3px; background:var(--tile); border-radius:2px; overflow:hidden; margin-bottom:4px;">
        <div id="train-progress-refresh-fill" style="height:100%; width:0%; background:var(--amber);"></div>
      </div>
      <div id="train-progress-last-check" style="font-size:11px; color:var(--ink-dim); text-align:right; margin-bottom:10px;">Opened ${new Date().toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone: 'Europe/London'})}</div>
      <div id="train-progress-board-debug" style="display:none; font-family:monospace; font-size:10px; color:#6a7a8a; text-align:right; margin-top:-6px; margin-bottom:10px;"></div>
      <div id="train-progress-staff-debug" style="display:none; font-family:monospace; font-size:10px; color:#6a7a8a; white-space:pre-wrap; text-align:left; margin-bottom:10px; border:1px dashed var(--line); border-radius:6px; padding:6px;"></div>
      <div id="train-progress-offline-banner" style="display:none; font-size:13px; color:#ff8b7e; background:rgba(224,90,78,0.12); border:1px solid rgba(224,90,78,0.4); border-radius:8px; padding:10px 12px; margin-bottom:10px;">Lost connection — showing estimated progress based on the last data received.</div>
      <div id="train-progress-summary" style="font-size:13.5px; color:var(--amber); background:rgba(242,169,59,0.1); border:1px solid rgba(242,169,59,0.3); border-radius:8px; padding:10px 12px; margin-bottom:10px;">${initial.summaryHtml}</div>
      <div id="train-progress-reason-toggle-wrap" style="margin-bottom:10px; ${initial.anyReasonSuppressed ? '' : 'display:none;'}">
        <span id="show-all-reasons-toggle" style="font-size:12px; text-decoration:underline; color:var(--ink-dim); cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">${showAllReasons ? 'Hide repeated reasons' : 'A reason was hidden as likely outdated — show it anyway'}</span>
      </div>
      <div id="train-progress-formation-wrap">${initial.formationHtml}${initial.formationDebugHtml}</div>
      <div id="train-progress-scroll" style="flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; position:relative; padding-right:14px;">
        <div style="position:relative; padding-left:6px;">
          <div id="train-progress-line" style="position:absolute; left:11px; top:0px; width:2px; height:0px; background:var(--line);"></div>
          <div id="train-progress-blob" style="position:absolute; left:6px; width:12px; height:12px; border-radius:50%; background:var(--amber); box-shadow:0 0 6px rgba(242,169,59,0.7); top:0px; transition:top 1.2s ease; z-index:2;"></div>
          <div id="train-progress-rows">${initial.rowsHtml}</div>
          <div id="train-progress-operator" style="font-size:12px; color:var(--ink-dim); margin-top:5px;">${service.operator ? `Operator: ${escapeHtml(service.operator)}` : ''}</div>
          <div id="train-progress-formation-footnote" style="font-size:11px; color:var(--ink-dim); margin-top:2px; ${initial.formationIsEstimated ? '' : 'display:none;'}">* coach count estimated from formation length, not live per-coach data</div>
        </div>
      </div>
      <div class="modal-close" id="train-progress-close-btn" style="margin-top:16px;">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Positions the line and blob from the *real* rendered row heights,
  // measured from the DOM — not a fixed assumed row height. Rows can grow
  // taller than the base minimum when a delay-reason message wraps onto
  // extra lines, so a fixed-pixel-per-row calculation drifts further and
  // further off the true position the more affected rows there are.
  function positionBlobAndLine(lastPassedIdx, fraction, scrollBehavior){
    const rowsContainer = overlay.querySelector('#train-progress-rows');
    const lineEl = overlay.querySelector('#train-progress-line');
    const blobEl = overlay.querySelector('#train-progress-blob');
    if (!rowsContainer || !lineEl || !blobEl) return;
    const rows = rowsContainer.querySelectorAll('[data-idx]');
    if (!rows.length) return;
    const base = rowsContainer.offsetTop;
    const centerOf = (row) => base + row.offsetTop + row.offsetHeight / 2;

    const firstCenter = centerOf(rows[0]);
    const lastCenter = centerOf(rows[rows.length - 1]);
    lineEl.style.top = `${firstCenter}px`;
    lineEl.style.height = `${Math.max(0, lastCenter - firstCenter)}px`;

    let blobCenter;
    if (lastPassedIdx < 0){
      blobCenter = firstCenter;
    } else if (lastPassedIdx >= rows.length - 1){
      blobCenter = lastCenter;
    } else {
      const c1 = centerOf(rows[lastPassedIdx]);
      const c2 = centerOf(rows[lastPassedIdx + 1]);
      blobCenter = c1 + (c2 - c1) * fraction;
    }
    blobEl.style.top = `${blobCenter - 6}px`;

    // Keep the blob roughly centred in view as it moves, rather than
    // needing a manual scroll to find it — most noticeable once a train
    // reaches the very end of a long calling-point list. Clamped to the
    // container's real scrollable range, so it naturally does the best
    // it can near either end rather than trying to overscroll.
    const scrollContainer = overlay.querySelector('#train-progress-scroll');
    if (scrollContainer && scrollContainer.clientHeight > 0){
      const target = Math.max(0, Math.min(
        blobCenter - scrollContainer.clientHeight / 2,
        scrollContainer.scrollHeight - scrollContainer.clientHeight
      ));
      scrollContainer.scrollTo({ top: target, behavior: scrollBehavior || 'smooth' });
    }
  }
  positionBlobAndLine(initial.lastPassedIdx, initial.fraction);

  // Fetches and injects weather badges for the given points, entirely
  // after the fact — the rows themselves have already rendered and
  // positioned by the time this resolves, so a slow or failed weather
  // fetch can never hold up or affect the actual train-tracking display.
  // gen is this call's render-generation token (see renderGeneration
  // above) — if a newer render has happened by the time the fetch
  // resolves, this result is for rows that no longer exist and is
  // dropped rather than written into whatever's there now.
  async function applyWeather(weatherPoints, lastPassedIdx, fraction, gen){
    if (!weatherEnabled || !weatherPoints || !weatherPoints.length) return;
    const results = await fetchWeatherForPoints(weatherPoints);
    if (!instanceActive || !overlay.isConnected || !results.size) return;
    if (gen !== renderGeneration) return; // superseded by a newer render while this was in flight
    results.forEach((wx, idx) => {
      const badge = overlay.querySelector(`[data-wx-idx="${idx}"]`);
      if (badge) badge.textContent = `${wx.icon} ${wx.temp}° `;
    });
    // Badges add a little width/height to their row — re-measure so the
    // progress line and blob stay correctly aligned against the real
    // rendered layout rather than where it was before they appeared.
    positionBlobAndLine(lastPassedIdx, fraction, 'auto');
  }
  renderGeneration++;
  applyWeather(initial.weatherPoints, initial.lastPassedIdx, initial.fraction, renderGeneration);

  function rebuildDisplay(){
    const rebuilt = buildTrainProgress(train, lastKnownService, showRawDebug, showAllReasons, boardOverrides, staffPlatformOverrides, staffLiveStatusOverrides, staffDataAge, staffOverrunLatch);
    const rowsEl = overlay.querySelector('#train-progress-rows');
    const summaryEl = overlay.querySelector('#train-progress-summary');
    if (rowsEl) rowsEl.innerHTML = rebuilt.rowsHtml;
    if (summaryEl) summaryEl.innerHTML = rebuilt.summaryHtml;
    const formationWrapEl = overlay.querySelector('#train-progress-formation-wrap');
    if (formationWrapEl) formationWrapEl.innerHTML = rebuilt.formationHtml + rebuilt.formationDebugHtml;
    positionBlobAndLine(rebuilt.lastPassedIdx, rebuilt.fraction, 'auto');
    const reasonToggleWrap = overlay.querySelector('#train-progress-reason-toggle-wrap');
    const reasonToggle = document.getElementById('show-all-reasons-toggle');
    if (reasonToggleWrap) reasonToggleWrap.style.display = rebuilt.anyReasonSuppressed ? '' : 'none';
    if (reasonToggle) reasonToggle.textContent = showAllReasons ? 'Hide repeated reasons' : 'A reason was hidden as likely outdated — show it anyway';
    renderGeneration++;
    applyWeather(rebuilt.weatherPoints, rebuilt.lastPassedIdx, rebuilt.fraction, renderGeneration);
    return rebuilt;
  }

  const rawDebugToggle = document.getElementById('raw-debug-toggle');
  if (rawDebugToggle){
    rawDebugToggle.addEventListener('click', () => {
      showRawDebug = !showRawDebug;
      rawDebugToggle.textContent = showRawDebug ? 'Hide raw data' : 'Show raw data';
      rebuildDisplay();
      updateBoardDebugPanel();
      updateStaffDebugPanel();
    });
  }

  const showAllReasonsToggle = document.getElementById('show-all-reasons-toggle');
  if (showAllReasonsToggle){
    showAllReasonsToggle.addEventListener('click', () => {
      showAllReasons = !showAllReasons;
      rebuildDisplay();
    });
  }

  // Debug-mode-only automated capture (2026-08-28) — lets a recording
  // session be started on Cloudflare (a Durable Object polling
  // GetServiceDetails server-side, no PWA needed to stay open) for
  // exactly the service currently open on this screen. Only wired up at
  // all when debugModeEnabled, matching every other debug-only affordance
  // on this screen (raw data toggle, board/staff debug panels).
  let debugCapturePollTimer = null;
  if (debugModeEnabled && serviceId){
    initDebugCapturePanel(overlay, serviceId, train.fromLoc || null);
  }
  function stopDebugCapturePolling(){
    if (debugCapturePollTimer){ clearInterval(debugCapturePollTimer); debugCapturePollTimer = null; }
  }
  function initDebugCapturePanel(overlayEl, svcId, originCrs){
    const wrap = overlayEl.querySelector('#debug-capture-wrap');
    if (!wrap) return;

    let currentSessionId = null;

    function render(state){
      if (state === 'idle'){
        wrap.innerHTML = `<span id="debug-capture-start" style="text-decoration:underline; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation; color:#8fb3c9;">Start recording (debug capture)</span>`;
        const startBtn = wrap.querySelector('#debug-capture-start');
        if (startBtn) startBtn.addEventListener('click', startSession);
        return;
      }
      if (state === 'starting'){
        wrap.textContent = 'Starting recording…';
        return;
      }
    }

    function renderSession(meta){
      if (!meta){ render('idle'); return; }
      const statusWord = meta.status === 'recording' ? '● recording' : `stopped (${meta.stoppedReason || 'unknown'})`;
      wrap.innerHTML = `
        <div>${escapeHtml(statusWord)} — ${meta.snapshotCount || 0} snapshot${meta.snapshotCount === 1 ? '' : 's'}</div>
        <div style="margin-top:4px; display:flex; gap:14px;">
          ${meta.status === 'recording' ? `<span id="debug-capture-stop" style="text-decoration:underline; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">Stop</span>` : ''}
          <span id="debug-capture-copy" style="text-decoration:underline; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">Copy JSON</span>
          <span id="debug-capture-clear" style="text-decoration:underline; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation; color:#ff8b7e;">Clear</span>
        </div>
      `;
      const stopBtn = wrap.querySelector('#debug-capture-stop');
      if (stopBtn) stopBtn.addEventListener('click', stopSession);
      const copyBtn = wrap.querySelector('#debug-capture-copy');
      if (copyBtn) copyBtn.addEventListener('click', copySession);
      const clearBtn = wrap.querySelector('#debug-capture-clear');
      if (clearBtn) clearBtn.addEventListener('click', clearSession);
    }

    async function startSession(){
      render('starting');
      try{
        const resp = await fetch(`${DARWIN_WORKER_URL}/api/debug-capture/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceId: svcId, crs: originCrs })
        });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const { id, meta } = await resp.json();
        currentSessionId = id;
        renderSession(meta);
        stopDebugCapturePolling();
        // Polls this screen's own view of the session, separate from the
        // Worker's own alarm-driven polling of Darwin — this is purely
        // "refresh what the button shows", every 30s while this screen
        // is open, so the snapshot count and status visibly update
        // without needing to close and reopen Live Progress.
        debugCapturePollTimer = setInterval(refreshSession, 30000);
      }catch(e){
        wrap.textContent = `Couldn't start recording — ${e.message}`;
      }
    }

    async function refreshSession(){
      if (!currentSessionId) return;
      try{
        const resp = await fetch(`${DARWIN_WORKER_URL}/api/debug-capture/${currentSessionId}`);
        if (!resp.ok) return;
        const { meta } = await resp.json();
        renderSession(meta);
        if (meta && meta.status !== 'recording') stopDebugCapturePolling();
      }catch(e){ /* transient — next 30s poll will retry */ }
    }

    async function stopSession(){
      if (!currentSessionId) return;
      try{
        const resp = await fetch(`${DARWIN_WORKER_URL}/api/debug-capture/${currentSessionId}/stop`, { method: 'POST' });
        if (resp.ok) renderSession(await resp.json());
      }catch(e){ /* ignore — user can retry */ }
      stopDebugCapturePolling();
    }

    async function copySession(){
      if (!currentSessionId) return;
      try{
        const resp = await fetch(`${DARWIN_WORKER_URL}/api/debug-capture/${currentSessionId}`);
        const bundle = await resp.json();
        await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      }catch(e){ /* clipboard permissions or network — no toast infra here, silently no-op */ }
    }

    async function clearSession(){
      if (!currentSessionId) return;
      try{
        await fetch(`${DARWIN_WORKER_URL}/api/debug-capture/${currentSessionId}`, { method: 'DELETE' });
      }catch(e){ /* best-effort */ }
      currentSessionId = null;
      stopDebugCapturePolling();
      render('idle');
    }

    render('idle');
  }

  // Kicks off (or restarts) a smooth CSS fill from 0 to 100% over the
  // given duration — a pure visual indicator of "time until the next
  // check", not tied to a ticking JS interval of its own. Duration
  // varies with the adaptive cadence below, so this takes it as a
  // parameter rather than assuming the flat 60-second default.
  function resetRefreshBar(durationMs){
    const fill = overlay.querySelector('#train-progress-refresh-fill');
    if (!fill) return;
    fill.style.transition = 'none';
    fill.style.width = '0%';
    void fill.offsetWidth; // force reflow so the transition-removal above actually takes effect first
    fill.style.transition = `width ${durationMs}ms linear`;
    fill.style.width = '100%';
  }

  // Computes how long to wait before the next poll, given where the
  // journey currently is — see the cadence constants above for the
  // reasoning, and pollBeforeDepartureMin/pollCheckInIntervalMin (both
  // configurable from the menu) for the two numbers involved. Falls
  // back to the flat default whenever there isn't a usable scheduled
  // time to reason about, which is always at least as safe as the old
  // fixed cadence.
  function computeNextRefreshDelay(buildResult){
    if (buildResult.lastPassedIdx === -1){
      const schedStr = lastKnownService && (lastKnownService.std || lastKnownService.sta);
      if (schedStr && schedStr.includes(':')){
        // closestDateForTime, not a same-day-only liveTimeToDate — a
        // service due at 00:43 tracked at 22:48 the evening before needs
        // to resolve to tomorrow's 00:43, not today's (which would put
        // it hours in the past and silently fall through to the flat
        // cadence below instead of the intended long pre-departure
        // wait). Same reasoning already proven correct for the first
        // calling point above.
        const schedDate = closestDateForTime(schedStr.replace(':', ''), new Date());
        if (schedDate){
          const minutesToGo = (schedDate.getTime() - Date.now()) / 60000;
          if (minutesToGo > pollBeforeDepartureMin){
            // Don't wait all the way until the pre-departure window
            // opens in one go — cap it at the configured check-in
            // interval, so a cancellation that happens mid-wait (not
            // one that already existed when the screen was opened,
            // which the very first fetch already catches regardless)
            // is still noticed within a bounded time.
            const waitUntilWindow = minutesToGo - pollBeforeDepartureMin;
            return Math.min(waitUntilWindow, pollCheckInIntervalMin) * 60000;
          }
        }
      }
    } else if (buildResult.toLocIdx !== -1 && buildResult.lastPassedIdx === buildResult.toLocIdx - 1){
      // Fast-polling anchored to your own stop, not the physical
      // train's true endpoint — a "My Trains" configured route (Crewe
      // to Wigan, say) that happens to be part of a much longer working
      // continuing well beyond Wigan would previously never trigger
      // this at all until the physical train itself was one stop from
      // its own final destination, long after you'd already got off.
      return FINAL_LEG_REFRESH_MS;
    } else if (buildResult.toLocIdx === -1 && buildResult.pointCount && buildResult.lastPassedIdx === buildResult.pointCount - 2){
      // Falls back to the physical endpoint only when there's no toLoc
      // to anchor to at all — a search-tracked or arrival-only entry,
      // where "my journey" isn't a defined concept in the first place.
      return FINAL_LEG_REFRESH_MS;
    }
    return TRAIN_PROGRESS_REFRESH_MS;
  }

  // Clears any pending poll and schedules the next one at the delay
  // computed above, restarting the visual countdown bar to match. A
  // self-rescheduling setTimeout rather than a single setInterval,
  // since the delay needs to change from one cycle to the next.
  function scheduleNextRefresh(buildResult){
    if (refreshTimer){ clearTimeout(refreshTimer); refreshTimer = null; }
    const delayMs = computeNextRefreshDelay(buildResult);
    resetRefreshBar(delayMs);
    refreshTimer = setTimeout(doRefresh, delayMs);
  }

  async function doRefresh(){
    // An interval tick and a visibility-wake tick can otherwise overlap;
    // if one's already running, just let it finish rather than starting
    // a second one that could resolve out of order.
    if (refreshInFlight) return;
    refreshInFlight = true;
    const stamp = () => new Date().toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone: 'Europe/London'});
    const lastCheckEl = overlay.querySelector('#train-progress-last-check');
    try{
      let freshService = null;
      if (serviceId){
        // Preferred path: ask for this exact train directly, regardless
        // of whether it's still on any station's board.
        freshService = await fetchServiceDetails(serviceId);
      } else {
        // Fallback for the rare case a service had no ID at all — the
        // old, more fragile approach of re-matching against the board.
        const boards = await fetchLiveBoards();
        const board = boards[`${train.fromLoc}-${train.toLoc}`] || [];
        const wanted = `${train.time.slice(0,2)}:${train.time.slice(2,4)}`;
        freshService = board.find(s => s.std === wanted) || null;
      }
      // This screen may have been closed (or superseded by a different
      // train's screen reusing the same element IDs) while the request
      // above was in flight — clearing the interval doesn't cancel an
      // already-started await, so this is the check that actually
      // prevents a stale response from writing into the wrong screen.
      if (!instanceActive) return;
      if (freshService){
        lastKnownService = freshService;
        const fresh = buildTrainProgress(train, freshService, showRawDebug, showAllReasons, boardOverrides, staffPlatformOverrides, staffLiveStatusOverrides, staffDataAge, staffOverrunLatch);
        const rowsEl = overlay.querySelector('#train-progress-rows');
        const summaryEl = overlay.querySelector('#train-progress-summary');
        const pillEl = overlay.querySelector('#train-progress-reverse-pill');
        const operatorEl = overlay.querySelector('#train-progress-operator');
        const offlineBanner = overlay.querySelector('#train-progress-offline-banner');
        const blobEl = overlay.querySelector('#train-progress-blob');
        const reasonToggleWrap = overlay.querySelector('#train-progress-reason-toggle-wrap');
        const formationWrapEl = overlay.querySelector('#train-progress-formation-wrap');
        const formationFootnoteEl = overlay.querySelector('#train-progress-formation-footnote');
        if (rowsEl) rowsEl.innerHTML = fresh.rowsHtml;
        if (summaryEl) summaryEl.innerHTML = fresh.summaryHtml;
        if (formationWrapEl) formationWrapEl.innerHTML = fresh.formationHtml + fresh.formationDebugHtml;
        positionBlobAndLine(fresh.lastPassedIdx, fresh.fraction);
        renderGeneration++;
        applyWeather(fresh.weatherPoints, fresh.lastPassedIdx, fresh.fraction, renderGeneration);
        if (pillEl) pillEl.innerHTML = freshService.isReverseFormation ? `<span style="display:inline-block; background:var(--amber); color:#14161f; font-weight:700; font-size:11px; letter-spacing:0.5px; padding:4px 10px; border-radius:20px; margin-bottom:10px;">REVERSE FORMATION</span>` : '';
        if (operatorEl) operatorEl.textContent = freshService.operator ? `Operator: ${freshService.operator}` : '';
        if (formationFootnoteEl) formationFootnoteEl.style.display = fresh.formationIsEstimated ? '' : 'none';
        if (lastCheckEl) lastCheckEl.textContent = `Updated ${stamp()}`;
        if (reasonToggleWrap) reasonToggleWrap.style.display = fresh.anyReasonSuppressed ? '' : 'none';
        // Connection's back — drop out of the offline/estimated state.
        if (offlineBanner) offlineBanner.style.display = 'none';
        if (blobEl) blobEl.classList.remove('blob-pulsing');
        // Platform-change / departed-arrived notifications — separate
        // lookups against the pure dep/arr board (not the combined
        // GetServiceDetails call above), since that's the only place
        // Darwin gives a real atd/ata or a reliably up-to-date platform.
        // Two independent checks: the tracked-from station (fromLoc —
        // "have I actually left"), and, when this is one of your own
        // configured routes with a real endpoint, the tracked-to station
        // too (toLoc — "has my platform there been confirmed/changed").
        // Without the second one, a configured destination like Crewe
        // would never get checked at all — the combined GetServiceDetails
        // call above only reads whatever calling-point data it happened
        // to return, which is exactly the staleness problem this whole
        // feature was built to work around, just left unfixed for every
        // point except the origin. Both fire-and-forget as far as the
        // main progress screen goes — a failure here should never break
        // it, that error handling above stands on its own — but a
        // failure IS recorded into the debug state below, so raw-debug
        // mode can actually show what went wrong rather than nothing.
        // Matched by scheduled time now, not serviceID — confirmed via
        // live Cloudflare logs (2026-08-21) that each pure board product
        // mints its own serviceID scoped to that board/station, so the
        // ID this app already holds for the service isn't portable to a
        // different station's board. See fetchStationBoardForService's
        // own docblock for the full story.
        if (serviceId && train.fromLoc){
          const boardTypeForHere = fresh.departsHere ? 'dep' : 'arr';
          const hereSchedTime = boardTypeForHere === 'dep' ? freshService.std : freshService.sta;
          if (hereSchedTime){
            fetchStationBoardForService(train.fromLoc, boardTypeForHere, hereSchedTime, serviceId)
              .then(boardData => {
                lastBoardDebugFrom = { crs: train.fromLoc, boardType: boardTypeForHere, schedTime: hereSchedTime, data: boardData, error: null };
                updateBoardDebugPanel();
                diffAndNotifyJourneyState(`${serviceId}:${train.fromLoc}`, displayLabel, boardTypeForHere, boardData, (STATION_COORDS[train.fromLoc] && STATION_COORDS[train.fromLoc].name) || stationNameForCrs(train.fromLoc) || train.fromLoc);
                // Actually reflect it in the row someone's looking at, not
                // just the debug panel and the notification check —
                // rebuildDisplay() re-runs buildTrainProgress against the
                // last-known combined data, but now with this fresher
                // per-station data merged in on top of it.
                if (boardData){
                  boardOverrides = { ...boardOverrides, [train.fromLoc]: { data: boardData, boardType: boardTypeForHere } };
                  rebuildDisplay();
                }
              })
              .catch(err => {
                lastBoardDebugFrom = { crs: train.fromLoc, boardType: boardTypeForHere, schedTime: hereSchedTime, data: null, error: err.message };
                updateBoardDebugPanel();
              });
          }
          // Phase 2 staff-board comparison, plus (2026-08-26) genuine
          // platform enrichment — now handled by the shared
          // refreshStaffPlatformData (see its declaration near the
          // seed block above), which this same call also feeds every
          // refresh cycle, not just on initial open. Still strictly
          // read-only in every other respect: no boardOverrides write,
          // no influence on hasConfirmedActual/liveTime/isCancelled/
          // walkback — only platform and AT PLATFORM status, via the
          // separate staffPlatformOverrides/staffLiveStatusOverrides
          // mechanism, deliberately kept apart from boardOverrides' own
          // all-or-nothing merge. See staff-board-scoping.md Phase 2.
          refreshStaffPlatformData(freshService);
        }
        if (serviceId && train.toLoc && train.toLoc !== train.fromLoc){
          // Always 'arr' — the tracked-to station is by definition where
          // this configured route ends, so there's nothing to depart from
          // there as far as this app's own segment is concerned, even if
          // the physical train carries on further afterward. Its own
          // scheduled time has to come from the calling-points list
          // (findCallingPointSchedTime) rather than the service's
          // top-level std/sta, since — unlike fromLoc — toLoc isn't
          // necessarily the "here" station buildTrainProgress reads
          // those top-level fields for.
          const toSchedTime = findCallingPointSchedTime(freshService, train.toLoc);
          if (toSchedTime){
            fetchStationBoardForService(train.toLoc, 'arr', toSchedTime, serviceId)
              .then(boardData => {
                lastBoardDebugTo = { crs: train.toLoc, boardType: 'arr', schedTime: toSchedTime, data: boardData, error: null };
                updateBoardDebugPanel();
                diffAndNotifyJourneyState(`${serviceId}:${train.toLoc}`, displayLabel, 'arr', boardData, (STATION_COORDS[train.toLoc] && STATION_COORDS[train.toLoc].name) || stationNameForCrs(train.toLoc) || train.toLoc);
                if (boardData){
                  boardOverrides = { ...boardOverrides, [train.toLoc]: { data: boardData, boardType: 'arr' } };
                  rebuildDisplay();
                }
              })
              .catch(err => {
                lastBoardDebugTo = { crs: train.toLoc, boardType: 'arr', schedTime: toSchedTime, data: null, error: err.message };
                updateBoardDebugPanel();
              });
          }
          // Phase 2 staff-board comparison, "to" side. filterType 'from'
          // here is the semantically-correct opposite of the 'to' used
          // on the "from" side above, but — unlike that one — hasn't
          // actually been confirmed working live yet; if this side's
          // comparison ever shows serviceCount=0 or a suspicious
          // no-match, that's worth checking before trusting it, not
          // silently assuming the mechanism is broken. Still queried
          // directly at train.toLoc (not origin-anchored like the
          // "from" side) — since subsequentLocations runs forward from
          // wherever queried, this side already sees everything from
          // toLoc onward to the true final destination; the from-side
          // fetch above already covers everything up to and including
          // toLoc when it's anchored at the origin, so this fetch is
          // mainly an independent freshness cross-check for toLoc
          // specifically, not the only source of that station's data.
          // Worth being aware of a structural limitation this side
          // still carries, confirmed live (2026-08-25): the Worker's
          // staffBoard type only ever calls GetDepBoardWithDetails (a
          // departures product), so a query anchored at a station that
          // has no onward departure — i.e. a genuine terminus — can
          // never find that service no matter how the target time or
          // filters are tuned. Not an issue for either of the two
          // configured Crewe/Wigan routes (both always mid-journey),
          // but worth remembering if toLoc is ever a searched train's
          // actual final destination.
          // See staff-board-scoping.md Phase 2.
          if (showRawDebug && toSchedTime){
            fetchStaffBoardComparison(train.toLoc, train.fromLoc || undefined, train.fromLoc ? 'from' : undefined, 'arr', toSchedTime, freshService.sdd)
              .then(result => {
                const wanted = extractStaffLocationFields(result.raw, result.match, train.toLoc);
                lastStaffDebugTo = { crs: train.toLoc, boardType: 'arr', schedTime: toSchedTime, ...result, wanted, error: null };
                updateStaffDebugPanel();
              })
              .catch(err => {
                lastStaffDebugTo = { crs: train.toLoc, boardType: 'arr', schedTime: toSchedTime, error: err.message };
                updateStaffDebugPanel();
              });
          }
        }
        if (fresh.journeyFinished){
          // Arrived, or terminated early with nothing left ahead that
          // could ever change — polling further would just be repeatedly
          // asking Darwin about a service that's permanently done.
          if (refreshTimer){ clearTimeout(refreshTimer); refreshTimer = null; }
          document.removeEventListener('visibilitychange', onVisible);
          const barWrap = overlay.querySelector('#train-progress-refresh-bar-wrap');
          if (barWrap) barWrap.style.display = 'none';
          if (lastCheckEl) lastCheckEl.style.display = 'none';
        } else {
          scheduleNextRefresh(fresh);
        }
      } else if (lastCheckEl){
        lastCheckEl.textContent = `Checked ${stamp()} — no data returned`;
        scheduleNextRefresh({ lastPassedIdx: 0 }); // no usable result to reason from — just fall back to the flat default cadence
      }
    }catch(e){
      if (!instanceActive) return;
      // Leave the last-known view showing rather than clearing it, but
      // make the failure visible instead of silently doing nothing — a
      // silent failure here previously looked identical to "not
      // refreshed" with no way to tell the difference.
      if (lastCheckEl){
        const stackLine = (e.stack || '').split('\n')[1] || '';
        const location = stackLine.match(/(\d+:\d+)\)?$/);
        lastCheckEl.textContent = `Checked ${stamp()} — refresh failed (${e.message}${location ? ' @' + location[1] : ''})`;
      }
      // No fresh data, but the position math only ever needed calling-
      // point times compared against the real current clock — re-run it
      // against the last data we did get, so the blob keeps creeping
      // forward on a reasonable assumption rather than sitting frozen.
      const stale = buildTrainProgress(train, lastKnownService, showRawDebug, showAllReasons, boardOverrides, staffPlatformOverrides, staffLiveStatusOverrides, staffDataAge, staffOverrunLatch);
      const rowsEl = overlay.querySelector('#train-progress-rows');
      const summaryEl = overlay.querySelector('#train-progress-summary');
      const offlineBanner = overlay.querySelector('#train-progress-offline-banner');
      const blobEl = overlay.querySelector('#train-progress-blob');
      const reasonToggleWrap = overlay.querySelector('#train-progress-reason-toggle-wrap');
      if (rowsEl) rowsEl.innerHTML = stale.rowsHtml;
      if (summaryEl) summaryEl.innerHTML = stale.summaryHtml;
      positionBlobAndLine(stale.lastPassedIdx, stale.fraction);
      renderGeneration++;
      applyWeather(stale.weatherPoints, stale.lastPassedIdx, stale.fraction, renderGeneration);
      if (reasonToggleWrap) reasonToggleWrap.style.display = stale.anyReasonSuppressed ? '' : 'none';
      if (offlineBanner) offlineBanner.style.display = 'block';
      if (blobEl) blobEl.classList.add('blob-pulsing');
      if (stale.journeyFinished){
        // Even the last data we successfully got already showed this
        // journey was over — no point continuing to retry a connection
        // just to re-confirm something that was already permanent.
        if (refreshTimer){ clearTimeout(refreshTimer); refreshTimer = null; }
        document.removeEventListener('visibilitychange', onVisible);
        const barWrap = overlay.querySelector('#train-progress-refresh-bar-wrap');
        if (barWrap) barWrap.style.display = 'none';
        if (lastCheckEl) lastCheckEl.style.display = 'none';
      } else {
        scheduleNextRefresh(stale);
      }
    }finally{
      refreshInFlight = false;
    }
  }

  // Screen locks/backgrounding pause the pending timeout below without
  // "catching up" a missed check afterward — so on waking up, force an
  // immediate refresh rather than potentially waiting out however long
  // was left on it (which, during the pre-departure quiet period, could
  // be a long wait indeed).
  function onVisible(){
    if (document.visibilityState === 'visible') doRefresh();
  }

  if (initial.journeyFinished){
    const barWrap = overlay.querySelector('#train-progress-refresh-bar-wrap');
    if (barWrap) barWrap.style.display = 'none';
    const initialLastCheckEl = overlay.querySelector('#train-progress-last-check');
    if (initialLastCheckEl) initialLastCheckEl.style.display = 'none';
  } else {
    scheduleNextRefresh(initial);
    document.addEventListener('visibilitychange', onVisible);
  }

  function closeAndStopRefresh(silent){
    instanceActive = false;
    if (refreshTimer){ clearTimeout(refreshTimer); refreshTimer = null; }
    stopDebugCapturePolling();
    document.removeEventListener('visibilitychange', onVisible);
    if (overlay.isConnected) overlay.remove();
    if (activeTrainProgressCleanup === forceClose) activeTrainProgressCleanup = null;
    // If this was opened from the Tracked sub-tab (the only place that
    // passes a serviceId directly on the train object), closing should
    // return there rather than just dropping back to whatever was
    // underneath — but only on a real user-initiated close, not when
    // this instance is being silently torn down to make way for a
    // newly-opened one.
    if (!silent && train.serviceId) openLiveScreen('tracked');
  }
  function forceClose(){ closeAndStopRefresh(true); }
  activeTrainProgressCleanup = forceClose;
  overlay.querySelector('#train-progress-close-btn').addEventListener('click', () => closeAndStopRefresh(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAndStopRefresh(false); });
}
