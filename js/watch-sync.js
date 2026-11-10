// watch-sync.js — Watch config (build/push), pending confirmations, target trains, geofence radii, drive-check payload.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

function isValidLatLng(p){
  return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
    Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    p.lat >= 49 && p.lat <= 61 && p.lng >= -9 && p.lng <= 2.5; // same loose UK box the Worker checks
}
async function fetchDriveCheckNow(){
  const resp = await fetch(`${DARWIN_WORKER_URL}/api/drive-check?now=1`, { headers: { 'X-PWA-Secret': pwaWriteSecret || '' } });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) throw new Error(resp.status === 401 ? 'Write secret not set or wrong' : `HTTP ${resp.status}`);
  lastDriveCheck = { at: Date.now(), data };
  return data;
}
function driveCheckIsSetUp(){ return !!buildDriveCheckPayload() && !!pwaWriteSecret; }

// Accepts "53.0886, -2.4305" (what Google Maps copies) or "53.0886 -2.4305".
function parseLatLng(text){
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const p = { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  return isValidLatLng(p) ? p : null;
}
function fmtLatLng(p){ return p ? `${p.lat}, ${p.lng}` : ''; }

// What goes to the Worker as driveCheckConfig, or null if the settings aren't
// complete enough to be valid there (no home, no station, a route with no via
// point, not exactly one usual route). null means the field is simply left out
// of the push, and the Worker keeps whatever it already had — so a fresh or
// restored device can never wipe a working setup.
function buildDriveCheckPayload(){
  const c = driveCheckConfig;
  if (!c || !isValidLatLng(driveCheckHome) || !isValidLatLng(c.station)) return null;
  const routes = (c.routes || []).filter(r => r && r.name && Array.isArray(r.via) && r.via.length);
  if (!routes.length || routes.length !== (c.routes || []).length) return null;
  if (routes.filter(r => r.usual).length !== 1) return null;
  if (routes.some(r => r.via.some(p => !isValidLatLng(p)))) return null;
  const times = {};
  Object.keys(c.checkTimesByTrain || {}).forEach(k => {
    const t = c.checkTimesByTrain[k];
    if (t && ALERT_CHECK_TIME_PATTERN.test(t) && railTrains.some(tr => tr.key === k && tr.direction === 'AM')) times[k] = t;
  });
  return {
    enabled: !!c.enabled,
    checkTimesByTrain: times,
    home: { lat: driveCheckHome.lat, lng: driveCheckHome.lng },
    station: { lat: c.station.lat, lng: c.station.lng },
    delayThresholdMin: c.delayThresholdMin,
    switchThresholdMin: c.switchThresholdMin,
    routes: routes.map(r => ({ key: r.key, name: r.name, via: r.via.map(p => ({ lat: p.lat, lng: p.lng })), usual: !!r.usual })),
  };
}

// First-run values (nothing stored yet): the spec's defaults, but only for
// trains that actually exist in this install's railTrains.
function defaultTrainAlertConfigFor(trains){
  const out = {};
  trains.forEach(t => { if (DEFAULT_TRAIN_ALERT_CONFIG[t.key]) out[t.key] = { ...DEFAULT_TRAIN_ALERT_CONFIG[t.key] }; });
  return out;
}
function defaultTargetTrainsFor(trains){
  const out = {};
  ['AM', 'PM'].forEach(dir => {
    const key = DEFAULT_TARGET_TRAINS[dir];
    if (trains.some(t => t.key === key && t.direction === dir)) out[dir] = key;
  });
  return out;
}

// Drops overrides for past dates, unknown/removed trains, or a train filed
// under the wrong direction. Called on load and whenever railTrains changes.
function pruneTargetTrainOverrides(){
  const todayKey = fmtKey(new Date());
  Object.keys(targetTrainOverrides).forEach(dateKey => {
    const per = targetTrainOverrides[dateKey];
    if (dateKey < todayKey || !per || typeof per !== 'object'){ delete targetTrainOverrides[dateKey]; return; }
    Object.keys(per).forEach(dir => {
      if (dir !== 'AM' && dir !== 'PM'){ delete per[dir]; return; }
      if (!railTrains.some(t => t.key === per[dir] && t.direction === dir)) delete per[dir];
    });
    if (!Object.keys(per).length) delete targetTrainOverrides[dateKey];
  });
}

// Why a date isn't a commute, or null if it is: 'Weekend', or the tag text
// (WFH, HOLIDAY, DENTIST, BANK HOLIDAY, a custom note...) — unless that tag
// was overridden with "I still used the ticket today". Mirrors
// isEligibleRailDay / findNextTravelDay exactly, so the watch and the
// ticket counter can never disagree about what counts as a travel day.
function nonTravelLabelFor(dateKey){
  if (isWeekend(parseKey(dateKey))) return 'Weekend';
  const comment = (comments[dateKey] || '').trim();
  if (comment !== '' && !travelOverrides[dateKey]) return comment;
  return null;
}

// The weekday dates in the next NON_TRAVEL_PUSH_DAYS days that are NOT
// commutes, for the Worker. Weekends are deliberately left out — the Worker
// works those out itself. A date missing from this list is treated as a
// travel day, so an app that hasn't been opened for weeks errs towards a
// spurious alert rather than a missed one.
function computeNonTravelDates(){
  const out = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = 0; i < NON_TRAVEL_PUSH_DAYS; i++){
    const d = addDays(start, i);
    if (isWeekend(d)) continue;
    const key = fmtKey(d);
    if (nonTravelLabelFor(key) !== null) out.push(key);
  }
  return out;
}
function geofenceRadiusForCrs(crs){
  if (crs === 'CRE') return geofenceRadiusCrewe;
  if (crs === 'WGN') return geofenceRadiusWigan;
  return DEFAULT_GEOFENCE_RADIUS_M; // defensive — shouldn't happen with the two configured stations
}

// Builds what the Worker's WATCH_KV holds for the watch: railTrains + both
// geofence radii (as before) plus, since 2026-09-18, the target-train alert
// settings and the next NON_TRAVEL_PUSH_DAYS days that aren't commutes. Only
// trains still in railTrains, with a valid alert time, are sent — the Worker
// validates the shapes strictly and rejects a malformed push outright.
function buildWatchConfigBody(){
  const todayKey = fmtKey(new Date());
  const alertCfg = {};
  railTrains.forEach(t => {
    const c = trainAlertConfig[t.key];
    if (c && typeof c.checkTime === 'string' && ALERT_CHECK_TIME_PATTERN.test(c.checkTime)){
      alertCfg[t.key] = { checkTime: c.checkTime, earlyWarningLeadMin: (typeof c.earlyWarningLeadMin === 'number') ? c.earlyWarningLeadMin : null };
    }
  });
  const targets = {};
  ['AM', 'PM'].forEach(dir => {
    const key = defaultTargetTrains[dir];
    if (key && railTrains.some(t => t.key === key && t.direction === dir)) targets[dir] = key;
  });
  const overrides = {};
  Object.keys(targetTrainOverrides).forEach(dateKey => {
    if (dateKey < todayKey) return;
    const per = {};
    ['AM', 'PM'].forEach(dir => {
      const key = (targetTrainOverrides[dateKey] || {})[dir];
      if (key && railTrains.some(t => t.key === key && t.direction === dir)) per[dir] = key;
    });
    if (Object.keys(per).length) overrides[dateKey] = per;
  });
  const body = {
    railTrains, geofenceRadiusCrewe, geofenceRadiusWigan,
    trainAlertConfig: alertCfg,
    defaultTargetTrains: targets,
    targetTrainOverrides: overrides,
    nonTravelDates: computeNonTravelDates(),
  };
  // 2026-09-30: only sent once complete — omitted otherwise, so the Worker
  // keeps what it has (see buildDriveCheckPayload).
  const drive = buildDriveCheckPayload();
  if (drive) body.driveCheckConfig = drive;
  return body;
}

// Pushes the watch-relevant config to the Worker's WATCH_KV in one shot —
// the watch reads its geofence radii and (since 2026-09-18) its alert
// schedule back via GET /api/watch-config, and the same blob feeds
// station-ping matching and /api/train-status server-side. Fire-and-forget:
// if this fails (offline, Worker down), nothing on the PWA's own side
// depends on it succeeding — the watch just keeps using whatever it last
// fetched, and the next push (this one now goes out on every app open and
// foreground, not just Settings saves) catches it up.
// 2026-09-01 — see wearos-companion-session-2026-09-01.md.
//
// 2026-09-18: the temporary "Watch config pushed ✓" toast is gone — with a
// push on every app open it would fire constantly. Failures are still
// surfaced, but only the ones that mean something: the Worker REFUSING the
// push (a non-2xx — e.g. a 400 for a field it doesn't like) shows a toast,
// because that would otherwise fail silently and leave the watch on stale
// config; a plain network failure (offline) only logs to the console.
// keepalive lets a push started as the app is being backgrounded still
// complete.
function pushWatchConfig(){
  // 2026-09-30: now returns the promise (resolving true/false for accepted or
  // not) so the drive-check "Test now" can wait for its settings to land
  // before asking the Worker to run a check. Every existing caller ignores it.
  return fetch(`${DARWIN_WORKER_URL}/api/watch-config`, {
    method: 'PUT',
    // 2026-09-24: X-PWA-Secret — the Worker now rejects this PUT without it.
    // Sent as '' when unset, which the Worker refuses with a 401.
    headers: { 'Content-Type': 'application/json', 'X-PWA-Secret': pwaWriteSecret || '' },
    body: JSON.stringify(buildWatchConfigBody()),
    keepalive: true
  })
    .then(async (resp) => {
      if (!resp.ok){
        // 2026-09-24: a 401 means this device has no (or the wrong) write
        // secret — point at the fix rather than a bare status code. This is
        // also what now stops a fresh/unconfigured browser from silently
        // overwriting calibrated config (the 24 Sep radius reset).
        if (resp.status === 401){
          showToast('Watch config not saved — set the write secret in Settings (key icon).');
        } else {
          const text = await resp.text().catch(()=> '');
          showToast(`Watch config not accepted: ${resp.status} ${text}`.slice(0, 200));
        }
      }
      return resp.ok;
    })
    .catch((e) => {
      console.warn('pushWatchConfig failed (offline?):', e && e.message);
      return false;
    });
}

// Debounced variant for the many small triggers (tagging a day, changing a
// target, app open/foreground) — several in quick succession collapse into
// one push. The Worker also skips its own write when nothing has changed,
// so an app open with nothing new costs one tiny request and no KV write.
let watchConfigPushTimer = null;
function schedulePushWatchConfig(){
  if (watchConfigPushTimer) clearTimeout(watchConfigPushTimer);
  watchConfigPushTimer = setTimeout(() => { watchConfigPushTimer = null; pushWatchConfig(); }, 2000);
}
// Called when the app is being backgrounded: a pending debounced push would
// otherwise sit in a timer the OS may freeze, so send it now.
function flushWatchConfigPush(){
  if (!watchConfigPushTimer) return;
  clearTimeout(watchConfigPushTimer);
  watchConfigPushTimer = null;
  pushWatchConfig();
}

// Fire-and-forget notice to the Worker that the PWA's own live check
// (checkLikelyTrain/checkLikelyArrival) has just resolved a train,
// purely so a station-ping arriving around the same moment doesn't
// independently resolve the same thing again — first write wins
// server-side (see darwin-live-worker.js's writeConfirmedIfAbsent).
// Never blocks or affects the PWA's own confirmedTrains write, which
// has already happened by the time this is called.
function pushConfirmedTrain(dateKey, direction, trainKey, label){
  fetch(`${DARWIN_WORKER_URL}/api/confirm-train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: dateKey, direction, trainKey, label })
  }).catch(()=>{});
}

// 2026-09-25: the manual "Confirm train used" modal's equivalent of the
// above. It never used to tell the Worker anything, so on 24 Sep a
// manual pm-1731 entry left the Worker's confirmed:{date}:PM empty and a
// still-running CRE ping retry went on to confirm pm-1831 there. A
// manual entry overrides whatever the Worker holds (override:true, gated
// on X-PWA-Secret); an empty trainKey is a "None / didn't travel"
// tombstone that still blocks retries but is ignored by
// checkPendingConfirmation below. Fire-and-forget, like pushConfirmedTrain.
function pushManualConfirmedTrain(dateKey, direction, trainKey){
  const t = trainKey ? railTrains.find(r => r.key === trainKey) : null;
  fetch(`${DARWIN_WORKER_URL}/api/confirm-train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PWA-Secret': pwaWriteSecret || '' },
    body: JSON.stringify({ date: dateKey, direction, trainKey: trainKey || '', label: t ? t.label : '', override: true })
  }).catch(()=>{});
}

// Checks the Worker for a train already confirmed via a watch
// station-ping since this device last looked (e.g. overnight, or on
// the walk in with the phone in a pocket) and applies it exactly as a
// local silent confirm would — same confirmedTrains write, same
// banner. Called once on startup, before the live-check loop begins,
// so if the watch already settled today's direction, checkLikelyTrain/
// checkLikelyArrival see confirmedTrains already set on their very
// first guard check and never attempt (or push) their own resolution —
// no race in the common case.
//
// 2026-09-14: no longer explicitly clears the Worker's copy after
// applying. It used to (best-effort, backstopped by the 36h TTL) — but
// a different station's ping can still be mid-retry against the SAME
// date+direction for up to 90 minutes (matchArrivalSide/
// matchDepartureSide's own existing-guard is what stops it re-matching
// something else), and deleting the confirmed record out from under
// that guard let a stale retry land on an unrelated, later train — see
// departure-match-drift-spec.md's second addendum. The phone's own
// confirmedTrains[date][direction] guard (below) already prevents this
// function from re-applying the same entry twice, so the explicit
// clear was never actually needed for that purpose; the 36h TTL is
// sufficient cleanup on its own.
// 2026-09-25: was a single GET for today only — rewritten to the
// catch-up endpoint (one call, CONFIRMED_CATCHUP_LOOKBACK_DAYS back) so
// a watch confirmation from a day the app was never opened still
// reaches it (previously only today's date was ever asked for; see
// learnings-and-ways-of-working.md). Today's own entry keeps the exact
// same immediate green-banner behaviour as before; anything from an
// earlier date is new and goes into catchupBanner instead.
//
// Never overwrites an existing local value — a direction already set
// for a date (by the phone's own live check, a manual confirm, or an
// earlier run of this same function) is left alone, whatever the
// Worker holds. This is deliberate, not just the pre-existing today-
// only guard extended: it's what stops a stale/wrong Worker record
// (see 24 Sep's pm-1831) ever overwriting a value already trusted
// locally, for any of the 7 days now in scope, not just today.
async function checkPendingConfirmation(){
  const todayKeyLocal = fmtKey(new Date());
  const sinceKey = fmtKey(addDays(new Date(), -CONFIRMED_CATCHUP_LOOKBACK_DAYS));
  let data;
  try{
    const resp = await fetch(`${DARWIN_WORKER_URL}/api/pending-confirmations?since=${sinceKey}`);
    if (!resp.ok) return;
    data = await resp.json();
  }catch(e){ return; } // offline or Worker unreachable — live checks remain the fallback, as always

  const confirmations = (data && data.confirmations) || {};
  const catchupEntries = [];
  let changed = false;

  for (const dateKey of Object.keys(confirmations).sort()){
    for (const direction of ['AM','PM']){
      const entry = confirmations[dateKey][direction];
      if (!entry || !entry.trainKey) continue; // no entry, or a manual "None" tombstone — nothing to apply
      if (confirmedTrains[dateKey] && confirmedTrains[dateKey][direction] !== undefined) continue; // never overwrite an existing local value

      if (!confirmedTrains[dateKey]) confirmedTrains[dateKey] = {};
      confirmedTrains[dateKey][direction] = entry.trainKey;
      changed = true;

      if (dateKey === todayKeyLocal){
        silentConfirmBanner = { dateKey, direction, trainKey: entry.trainKey, label: entry.label, source: 'watch' };
        saveSilentConfirmBanner();
        renderSilentConfirmBanner();
      } else {
        catchupEntries.push({ dateKey, direction, trainKey: entry.trainKey, label: entry.label });
      }
    }
  }

  if (changed) saveConfirmedTrains();
  if (catchupEntries.length){
    catchupBanner = { entries: catchupEntries, expanded: catchupEntries.length === 1 };
    renderCatchupBanner();
  }
}
