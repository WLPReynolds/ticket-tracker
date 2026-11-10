// darwin.js — Darwin board/service queries, calling-point helpers, Staff board fetch and extraction.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

async function fetchLiveBoards(){
  // Query each unique route (fromLoc/toLoc pair) once, rather than once
  // per configured train — several trains often share the same route.
  const uniquePairs = [];
  const seen = new Set();
  railTrains.forEach(t => {
    const key = `${t.fromLoc}-${t.toLoc}`;
    if (!seen.has(key)){ seen.add(key); uniquePairs.push({ fromLoc: t.fromLoc, toLoc: t.toLoc }); }
  });
  if (uniquePairs.length === 0) return {};

  const resp = await fetch(DARWIN_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: uniquePairs.map(p => ({ crs: p.fromLoc, filterCrs: p.toLoc, filterType: 'to' }))
    })
  });
  if (!resp.ok) throw new Error(`Darwin request failed: ${resp.status}`);
  const data = await resp.json();

  const boards = {}; // "FROM-TO" -> array of trainServices
  (data.results || []).forEach(r => {
    const key = `${r.query.crs}-${r.query.filterCrs}`;
    boards[key] = (r.ok && r.data && r.data.trainServices) || [];
  });
  return boards;
}

// Same idea as fetchLiveBoards, but for an arbitrary station pair rather
// than the ones in railTrains — used only by the debug "track any train"
// tool, so testing tracking/refresh behaviour isn't limited to whichever
// of the user's own routes happen to have a live service running.
// Pure departures-only or arrivals-only board (boardType 'dep'/'arr'),
// for the retro departure-board feature — unlike fetchDebugBoard, which
// always uses the combined arr+dep method used everywhere else in the
// app, this asks Darwin for a genuine single-purpose board matching
// what a real physical board at that station would actually show.
// Shared POST-to-Worker for single Darwin queries, used by fetchPureBoard,
// fetchDebugBoard, fetchStationBoardForService and fetchStaffBoardComparison
// (fetchServiceDetails keeps its own retry logic). [requestFailedLabel] sets
// the wording for a non-2xx response. Requests are aborted after
// DARWIN_QUERY_TIMEOUT_MS so a stalled Worker call fails with a readable
// error instead of leaving the screen waiting indefinitely — every caller
// already handles a thrown error.
const DARWIN_QUERY_TIMEOUT_MS = 20000;
async function queryDarwin(queryObj, requestFailedLabel = 'Darwin request failed'){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DARWIN_QUERY_TIMEOUT_MS);
  let resp, data;
  try{
    resp = await fetch(DARWIN_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [queryObj] }),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error(`${requestFailedLabel}: ${resp.status}`);
    data = await resp.json();
  }catch(e){
    if (e && e.name === 'AbortError') throw new Error(`${requestFailedLabel}: timed out after ${DARWIN_QUERY_TIMEOUT_MS / 1000}s`);
    throw e;
  }finally{
    clearTimeout(timer);
  }
  const r = ((data && data.results) || [])[0];
  if (!r || !r.ok){
    // The Worker deliberately doesn't echo Darwin's raw upstream error body
    // (security hardening) — full detail is in the Worker's own logs, so this
    // only ever shows a short controlled reason and the status code.
    const detail = r
      ? `${r.reason || 'request failed'}${r.status ? ` (status ${r.status})` : ''}`
      : 'no response from worker';
    throw new Error(detail);
  }
  return r.data;
}

async function fetchPureBoard(crs, boardType, numRows){
  const data = await queryDarwin({ crs, boardType, numRows: numRows || 30 });
  return (data && data.trainServices) || [];
}

async function fetchDebugBoard(fromCrs, toCrs){
  const query = toCrs ? { crs: fromCrs, filterCrs: toCrs, filterType: 'to' } : { crs: fromCrs };
  const data = await queryDarwin(query);
  return (data && data.trainServices) || [];
}

async function fetchServiceDetails(serviceId, recoveryHint){
  async function callGetServiceDetails(id){
    let resp;
    try{
      resp = await fetch(DARWIN_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [{ type: 'serviceDetails', serviceId: id }] })
      });
    }catch(networkErr){
      // The fetch itself failed — no connectivity, DNS, Worker unreachable.
      // This says nothing about whether the service itself still exists,
      // so it's always transient.
      const err = new Error(`Network error contacting Darwin: ${networkErr.message}`);
      err.transient = true;
      throw err;
    }
    if (!resp.ok){
      // An HTTP-level failure from the Worker (rate limit, gateway error,
      // etc.) — a server-side hiccup, not evidence the service is gone.
      const err = new Error(`Darwin request failed: ${resp.status}`);
      err.transient = true;
      throw err;
    }
    const data = await resp.json();
    const r = (data.results || [])[0];
    if (!r || !r.ok || !r.data){
      // A specific reason from the Worker means Darwin was actually
      // reached and gave a definitive answer about this service — the one
      // case we can be reasonably confident means it's genuinely gone.
      // Anything else (empty/malformed response) is treated as transient,
      // since we can't actually tell what happened.
      const err = new Error((r && (r.reason || `status ${r.status}`)) || 'No service data returned — this train may no longer be tracked by Darwin');
      err.transient = !(r && r.reason);
      throw err;
    }
    return r.data;
  }

  try{
    return await callGetServiceDetails(serviceId);
  }catch(firstErr){
    // Only worth attempting recovery for a definitive Darwin rejection —
    // a transient/network-level failure would fail the recovery lookup
    // for the same reason, so there's nothing to gain from trying it.
    if (firstErr.transient || !recoveryHint || !recoveryHint.crs || !recoveryHint.boardType || !recoveryHint.schedTime){
      throw firstErr;
    }
    let freshServiceId = null;
    try{
      const resp = await fetch(DARWIN_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [{ type: 'stationBoardForService', crs: recoveryHint.crs, boardType: recoveryHint.boardType, schedTime: recoveryHint.schedTime, serviceId }] })
      });
      if (resp.ok){
        const data = await resp.json();
        const r = (data.results || [])[0];
        if (r && r.ok && r.data && r.data.serviceID) freshServiceId = r.data.serviceID;
      }
    }catch(e){ /* recovery lookup itself failed — fall through to the original error below */ }

    if (!freshServiceId || freshServiceId === serviceId){
      // Nothing different to try (board didn't have it right now, or
      // handed back the very same ID that just failed) — retrying would
      // just fail identically, so surface the original error.
      throw firstErr;
    }
    try{
      return await callGetServiceDetails(freshServiceId);
    }catch(secondErr){
      // Darwin has this exact service sitting on its board right now (we
      // just matched it by schedule) — GetServiceDetails still not
      // recognizing either ID reads as a reachability hiccup, not proof
      // the service is gone, so this is always treated as transient.
      const err = new Error(`Darwin has this service but its details aren't reachable right now — try again shortly`);
      err.transient = true;
      throw err;
    }
  }
}

// Like findCallingPointSchedTime, but returns the whole raw calling
// point object rather than just `st` — Emergency Routes leg-chaining
// needs to prefer a confirmed actual (at) or live estimate (et) over
// the bare schedule when working out a leg's real arrival time, same
// preference order used everywhere else in the app.
function findCallingPointRaw(service, crs){
  if (!service || !crs) return null;
  // subsequentCallingPoints first, deliberately — Emergency Routes
  // always wants "when does this service reach `to` AFTER I get on at
  // `from`", never a station this same physical service happened to
  // call at earlier in its journey (before the leg's own departure).
  // Checking previousCallingPoints first could silently return that
  // earlier occurrence's time whenever a service's route revisits the
  // same station code, or approaches the departure station from a
  // direction that passes near it beforehand — producing an impossible
  // "arrives before it departs" result for this leg while still looking
  // like a normal resolved time.
  const lists = [service.subsequentCallingPoints, service.previousCallingPoints];
  for (const list of lists){
    const points = (list && list[0] && list[0].callingPoint) ? list[0].callingPoint : [];
    const found = points.find(cp => cp.crs === crs);
    if (found) return found;
  }
  return null;
}

// Resolves a calling point to an actual, parseable clock-time string —
// distinct from findCallingPointRaw's plain at/et/st object, because
// Darwin's own "et" convention can legitimately BE the literal text
// "On time" instead of a clock time whenever a service isn't delayed
// (the exact same convention already special-cased for etd/display
// purposes elsewhere in this file, e.g. legTimeLabel's `c.etd !== 'On
// time'` check). Reading et blindly as a time string previously broke
// Emergency Routes leg-chaining: "On time" doesn't parse into a Date,
// so the whole chain died right there. A confirmed actual (at) is
// always a genuine time and never needs this treatment; only et does.
function resolveCallingPointClockTime(cp){
  if (!cp) return null;
  if (cp.at) return cp.at;
  if (cp.et && cp.et !== 'On time') return cp.et;
  return cp.st || null;
}

// Queries the pure departures-only or arrivals-only board (never the
// combined one — that's the whole reason this query type exists) for
// one specific service, matched server-side in the Worker by scheduled
// time (std for a departure query, sta for an arrival one) rather than
// by serviceID — confirmed via live Cloudflare logs that each pure
// board product mints its own serviceID scoped to that board/station,
// not a portable one shared across Darwin products, so the same
// physical service can carry a completely different serviceID on, say,
// Wigan's departure board than on Crewe's arrival board. serviceId is
// still passed through, purely so the Worker's diagnostic log (if this
// ever needs revisiting) can show both board-scoped IDs side by side.
// Returns null — not a thrown error — when the service simply isn't on
// that board right now (too far out, or already dropped off it); that's
// an expected, ordinary outcome, not a failure. This is the exact same
// Worker query a future Wear OS client would call too, so the matching
// logic only ever needs to exist once, in the Worker, rather than being
// duplicated here and there.
async function fetchStationBoardForService(crs, boardType, schedTime, serviceId){
  const data = await queryDarwin({ type: 'stationBoardForService', crs, boardType, schedTime, serviceId });
  return data || null; // null here means "not currently on this board" — see docblock above, not a failure
}

// Phase 2 (staff-board-scoping.md) — Staff board (LDBSVWS) read-only
// comparison. Never called outside debug mode, never feeds into
// boardOverrides or anything user-visible; this exists purely so the
// raw-debug panel can show the Staff board's view of the same service
// alongside the existing Darwin pure-board data already fetched for
// comparison. See fetchStaffBoardComparison below for the actual fetch
// + client-side match — the Worker's `staffBoard` query type does no
// matching of its own, it's a thin proxy (see darwin-live-worker.js),
// so matching against the right service in the returned list happens
// here, the same way stationBoardForService's own matching happens
// server-side instead — different split, same reason: whoever has the
// context (a known schedTime to match against) does the matching.
//
// Builds the "yyyyMMddTHHmmss" target-time string the Staff board's
// path requires. Deliberately built from local wall-clock string
// pieces, never a parsed/reconstructed Date object crossing a BST
// boundary — same discipline as localWallClockString above, for the
// same reason (a UTC round-trip would shift the hour whenever BST is
// in effect). Falls back to today's local date only if the service
// itself didn't carry an `sdd` (schedule date) — normally it will.
function buildStaffTargetTime(sdd, hhmm){
  const pad = (n) => String(n).padStart(2, '0');
  let dateDigits;
  if (typeof sdd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sdd)){
    dateDigits = sdd.replace(/-/g, '');
  } else {
    const d = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
    dateDigits = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  }
  return `${dateDigits}T${hhmm.replace(':', '')}00`;
}

// Fetches the Staff board at `crs` for the given target time, then
// picks out (client-side — see docblock above) whichever returned
// service's own std ('dep') or sta ('arr') matches schedTime to the
// minute. filterCrs/filterType narrow the candidate list the same way
// fetchLiveBoards' combined-board calls already do, but are optional —
// the time-match above is what actually identifies the right service,
// the filter is just there to keep the candidate list small and
// relevant. Returns { raw, match, serviceCount } rather than throwing
// on "no match found" — that's an ordinary outcome here (this endpoint
// is still genuinely new; a shape or timing mismatch is exactly the
// kind of thing Phase 2 exists to surface, not something to hide).
async function fetchStaffBoardComparison(crs, filterCrs, filterType, boardType, schedTime, sdd){
  const targetTime = buildStaffTargetTime(sdd, schedTime);
  const data = await queryDarwin({ type: 'staffBoard', crs, targetTime, filterCrs, filterType }, 'Staff board request failed');
  const services = (data && data.trainServices) || [];
  const timeField = boardType === 'dep' ? 'std' : 'sta';
  // Compare to the minute only — the service's own top-level std/sta
  // carries seconds ("...T16:31:00"), targetTime doesn't need to.
  const wantedPrefix = `${targetTime.slice(0, 8)}T${targetTime.slice(9, 13)}`;
  const match = services.find(s => typeof s[timeField] === 'string' && s[timeField].replace(/[-:]/g, '').startsWith(wantedPrefix)) || null;
  return { raw: data, match, serviceCount: services.length, targetTime };
}

// Pulls out the arrival/departure fields for one specific station
// (`wantedCrs`) from a matched Staff service, regardless of whether
// that station is the one the query was actually anchored at (the
// service's own top-level fields — confirmed: the top-level std/etd/
// atd/sta/eta/ata on a Staff service always describe whichever station
// the board itself was queried at, given back as `raw.crs`) or a
// downstream point reachable via `subsequentLocations` (queried at an
// earlier station — typically now the true origin, see the "from" side
// fetch below). Returns null if `wantedCrs` genuinely isn't part of
// this service's journey at all — shouldn't normally happen when
// `wantedCrs` came from the same service's own known calling points,
// but this is Phase 2 investigation code, so "surface it, don't hide
// it" applies here too, same as fetchStaffBoardComparison above.
// How long Staff-derived platform/AT-PLATFORM data stays trusted after
// its last genuine update (see staffPlatformStatusFor) — roughly a
// handful of missed poll cycles (60s normal, 20s final-leg) before
// falling back to Darwin-only behaviour, rather than trusting a fetch
// failure or no-match response indefinitely. Deliberately not so short
// that one transient blip discards known-good data, not so long that
// genuinely stale data lingers noticeably once the train's actually
// moved on.
const STAFF_DATA_MAX_AGE_MS = 5 * 60 * 1000;
// How long past Darwin's etd a Staff arrived-not-departed point may sit
// before it counts as overrunning — see staffPlatformStatusFor.
const STAFF_OVERRUN_GRACE_MS = 90 * 1000;

function extractStaffLocationFields(raw, match, wantedCrs){
  if (!match) return null;
  if (raw && raw.crs === wantedCrs) return match;
  const locs = Array.isArray(match.subsequentLocations) ? match.subsequentLocations : [];
  return locs.find(l => l.crs === wantedCrs) || null;
}
