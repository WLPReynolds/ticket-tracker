// state.js — Shared mutable state (top-level lets), loadJSON/loadData, every save…() function, the Drive backup dirty tracker.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

let gcalEnabled = false; // whether the person has connected Google Calendar
let preferredGoogleEmail = ''; // used as a login hint to skip the account picker when multiple Google accounts exist
// Global debug mode — off by default. When on, debug hooks scattered
// around the app (starting with the raw-data toggle on train progress)
// become visible. Each hook's own info can look different; this is just
// the single switch that reveals/hides all of them consistently.
let debugModeEnabled = false;
// Weather badges on the live-progress screen — on by default, but a
// single toggle to switch off entirely if the extra fetches ever cause
// noticeable lag or just get annoying. Purely a novelty display; never
// blocks or slows the actual train-tracking data underneath it.
let weatherEnabled = true;
// Tracks the currently-open train progress screen's own teardown
// function, if any. Every such screen shares the same hardcoded element
// IDs (train-progress-rows, train-progress-blob, etc.) and runs its own
// 60-second refresh timer — if a second one opened while a first was
// still alive, both timers kept running and both wrote into whichever
// DOM elements getElementById happened to resolve to (the first match,
// not necessarily the one on screen), causing one train's data to
// silently overwrite another's. Forcing any previous instance to clean
// itself up before a new one opens makes that structurally impossible.
let activeTrainProgressCleanup = null;

// Drive auto-backup
let driveBackupEnabled = false;
let driveBackupDirty = false; // true whenever something's changed since the last successful backup
let lastDriveBackupTime = 0; // epoch ms
let driveBackupFolderId = null;
let gcalEventId = null; // the calendar event ID for the current buy-ticket reminder, if any
let gcalPendingSync = false; // true when the buy date changed since the calendar was last updated
let lastNotifiedBuyKey = null; // the buy date we last notified/synced for, to detect changes
let googleTokenClient = null; // lazily-initialized GIS token client
let cachedAccessToken = null;
let cachedTokenExpiry = 0;
let gcalLastSyncFailed = false; // transient, not persisted — just for this session's UI feedback
let scheduledBuyKey = null; // the buy-date candidate currently waiting out the debounce timer
let buyDateChangeTimer = null; // the pending debounce timeout handle

let comments = {}; // dateKey -> comment string
let travelOverrides = {}; // dateKey -> true, for days with a comment that were still travelled
let periodStart = DEFAULT_PERIOD_START; // date the current ticket window began
let purchases = []; // [{date: 'YYYY-MM-DD', cost: number}, ...] — one entry per ticket bought
let lastKnownPrice = 153.60; // prefilled into the recalibrate cost field
let parkingCost = 6.39; // default daily parking estimate
// 18 characters on the actual card artwork — capped at 20 rather than
// exactly 18, a small bit of headroom in case a future card format
// (or, if this app is ever published more widely, a different
// operator's card) runs longer.
let smartcardNumber = '';
// Whether starting a claim also downloads a permanent claim-details.txt
// record — separate from the notification (a transient in-the-moment
// glance) and the clipboard (transient, just for pasting). Default on;
// toggleable since not everyone wants a growing pile of these in
// Downloads.
let produceClaimDetailsFile = true;
// Locked in the first time each pay period's own start date is genuinely
// reached — { "YYYY-MM-DD" (period start): { ticketCount, ticketCost,
// parkingDays, parkingCost, total } }. Once set for a given period, that
// period's "Set aside on payday" figure stays exactly what it was on
// payday, regardless of anything that happens afterward (a ticket
// bought, a day re-tagged) — the whole point of a payday budget is that
// it doesn't retroactively move once you've actually set the money aside.
let paydayEstimateSnapshots = {};
// { "YYYY-MM-DD": actualCostThatDay } — presence means "I parked this
// day"; absence (the default) means "I didn't". Default flipped this
// way deliberately: day-to-day, not parking is the normal case, so the
// tap-to-mark-the-exception model matches how every other per-day flag
// in this app already works, rather than asking for a daily
// confirmation on the common case.
let parkedDays = {};
// periodStartKey -> true, mirroring dismissedMonths exactly — the
// parking savings card is just as period-scoped as the payday estimate
// card, so dismissing it for one period and having it naturally
// reappear next period makes the same sense there too.
let dismissedParkingSavingsPeriods = {};
// periodStartKey -> saved/over-budget total (a plain number, can be
// negative), locked in the first time a period is seen to have already
// ended — mirrors paydayEstimateSnapshots' "lock it in and never
// recalculate" approach, so a comment edited or a parked-day re-tagged
// after the fact doesn't retroactively change what a past period showed.
let parkingSavingsSnapshots = {};
// periodStartKey -> [dateKey, ...], the specific weekday travel days
// that made up that period's parking budget, locked the moment the
// period's own start date is genuinely reached (same day-selection rule
// as the payday estimate's own parkingDays count, one level more
// granular). Once locked, a day stays in this set even if later
// re-tagged (WFH, holiday, sickness) — the money was already set aside
// for it, so it just becomes a "saved" day instead of a "spent" one,
// rather than dropping out of the budget entirely and silently shrinking
// the period's total.
let parkingBudgetDays = {};
// 0 = the real current period; negative = that many periods back. Never
// positive — unlike the payday estimate's preview-ahead nav, there's no
// "future" parking savings to show, only periods that have actually
// happened, so forward browsing is capped at the current period. Not
// persisted, same as estimateOffset — always starts back at 0 on reload.
let parkingSavingsOffset = 0;
// A simple global flag, not period-scoped like the two above — "spent
// this year" has no natural per-period reset point the way a payday or
// parking figure does, so there's nothing sensible to key a dismissal
// against other than "on" or "off".
let ticketsSpentCardDismissed = false;

// Live-progress polling cadence, both configurable from the menu (see
// openPollingSettingsEditor) — how close to scheduled departure polling
// resumes at the normal cadence, and the longest it'll ever go between
// checks before that, so a mid-wait cancellation during a long
// unattended pre-departure gap still gets caught within a bounded time
// rather than only right at the window itself. A cancellation that
// already existed before the screen was even opened doesn't need this —
// that's always caught by the very first fetch regardless of cadence.
let pollBeforeDepartureMin = 5;
let pollCheckInIntervalMin = 15;
let dayReturnPrice = 21.00; // used by the ticket purchase advisor to compare against the season ticket
// Year (number) whose regulated fares change (first Sunday of March) has
// already been checked against the live Fares API — null if never
// checked. Compared against the current calendar year, not a date, so a
// gap of several buy-free months doesn't cause repeat checks once one
// has already succeeded for the year. See shouldFetchFreshFares().
let fareCheckedYear = null;
let dismissedMonths = {}; // monthKey ('YYYY-MM') -> true, for the monthly estimate card
let menuOpen = false; // whether the hamburger dropdown is currently open
let railDaysBack = 3; // how far back the day list currently scrolls; grows via "Show earlier days"
let railTrains = []; // [{ key, direction: 'AM'|'PM', fromLoc, toLoc, time, label }]
let railPerfCache = {}; // { "YYYY-MM-DD": { trainKey: { delayMinutes, onTime, cancelled, reason } } } — delayMinutes/onTime are null/false when cancelled is true

// Bookkeeping for which (date, train) combinations have actually been
// queried against HSP before — distinct from railPerfCache itself, which
// only ever holds a real result. A weekday can be fully queried and
// still have nothing to show (the service didn't run, or HSP just has
// no record), and without tracking that separately we'd keep re-querying
// the same gap forever. Kept as its own top-level cache rather than a
// sentinel key inside railPerfCache[date], since several places read
// Object.keys()/every key of a day's perf object and expect only real
// train results to be there.
// { "YYYY-MM-DD": ["trainKey1", "trainKey2", ...] }
let railSyncedDays = {};
// Deliberately excluded from backup — losing this just means some
// already-known weekdays get harmlessly re-queried once after a
// restore, not that any real data is lost (see BACKUP_KEYS's comment).

// How far back the Performance history page backfills every weekday
// (not just days you actually travelled — see railSyncFullHistory).
// Starts modest and grows via "Load more history" on that page, both to
// avoid a huge burst of HSP subrequests the first time it's opened and
// because RAIL_HISTORY_MAX_DAYS_BACK is already a bit past HSP's own
// retention window, so there's rarely a reason to demand it all at once.
let railHistoryDaysBack = 90;

// { fetchedAt: <ms epoch>, codes: { "<numeric code>": { late: "...", canc: "..." } } }
// — decodes railPerfCache's raw numeric `reason` into the actual English
// text RDM's reference-data product gives for it. Refetched at most once
// a month (see REASON_CODES_MAX_AGE_MS below); the app works fine with
// no map at all, it just falls back to showing the bare code.
let reasonCodesCache = { fetchedAt: 0, codes: {} };
let railSyncInProgress = false;

// Marks the Drive backup as needing a fresh upload whenever any of the
// app's own data changes. Installed once, globally, so every save
// function already in the app (and any added later) is covered
// automatically — no need to remember to flag dirtiness by hand.
(function installDriveBackupDirtyTracker(){
  const originalSetItem = localStorage.setItem.bind(localStorage);
  // 2026-10-02: only keys that actually go INTO a backup (BACKUP_KEYS) can
  // mark one as needed, and only when the stored value really changes — a
  // UI-state key, or bank-holidays-cache being rewritten identically on
  // every app open, no longer counts as "something changed". BACKUP_KEYS is
  // a const declared further down, so it's read lazily inside the call;
  // anything that writes before it's initialised falls back to the old
  // behaviour (treat as changed) rather than throwing.
  function isBackedUpKey(key){
    try{ return BACKUP_KEYS.includes(key); }
    catch(e){ return key !== 'drive-backup-dirty' && key !== 'drive-backup-last-time'; }
  }
  localStorage.setItem = function(key, value){
    if (isBackedUpKey(key)){
      let unchanged = false;
      try{ unchanged = localStorage.getItem(key) === String(value); }catch(e){}
      if (!unchanged){
        driveBackupDirty = true;
        try{ originalSetItem('drive-backup-dirty', JSON.stringify(true)); }catch(e){}
      }
    }
    return originalSetItem(key, value);
  };
})();
let trainAlertConfig = {};
let defaultTargetTrains = {};
let targetTrainOverrides = {};
let driveCheckConfig = JSON.parse(JSON.stringify(DEFAULT_DRIVE_CHECK_CONFIG));
let driveCheckHome = null;
let lastDriveCheck = null; // { at: epoch ms, data }

let estimateOffset = 0; // 0 = current pay period, 1 = next, 2 = the one after, etc. (not persisted)
let confirmedTrains = {}; // "YYYY-MM-DD" -> { AM: trainKey, PM: trainKey } — which specific train you actually caught, manually confirmed for now

// Delay Repay claim tracking — dateKey -> { AM: {status, minutesLate, amount, claimRef, trainKey}, PM: {...} }
// claimRef is the Avanti-issued reference (e.g. "AWC-1234-567-890"), added
// once you have it via the input on the claims manager screen — absent
// until then, and absent entirely on claims created before this field
// existed. minutesLate is null for a cancelled train (no delay figure
// applies), shown as "Cancelled" rather than "null min late". trainKey
// (e.g. "pm-1731") is only set on claims backfilled via the import
// screen, which have no confirmedTrains entry to resolve a label from —
// it's a fallback lookup into the same static railTrains list, so a
// backfilled claim's row shows a real scheduled time ("17:31 (PM)")
// rather than falling back to the bare direction.
// status is 'started' (link tapped, submission not confirmed) or 'confirmed'
// (manually marked as actually submitted/completed). Only ever set for the
// CONFIRMED train on a given direction, never for other trains that also
// happened to be delayed that day but weren't the one actually ridden.
//
// 2026-09-30 (claude/delay-repay-badge-rework-spec.md): two more statuses —
//   'expired'  — also written for an UNCLAIMED delay once its 28 days lapse
//                ({ unclaimed: true, ... }), so lost money shows up in the
//                claims manager and the ROI dashboard, not just silently.
//   'declined' — written by the "Not claiming" button. Never expires, never
//                badges, left out of every ROI total; the day's blob/dot
//                turns grey.
// A 'started' claim with a claimRef counts as submitted: it stops counting
// down on the badge and never expires.
let delayClaims = {};

async function saveDelayClaims(){
  try{ localStorage.setItem('delay-claims', JSON.stringify(delayClaims)); }
  catch(e){ /* save failed silently; will retry next change */ }
}

// Trains being actively watched by serviceID, independent of any
// station's rolling board window — lets a journey be followed all the
// way to its destination, even after it's long departed the station you
// first spotted it from, and even across closing/reopening the app.
let trackedTrains = []; // [{ serviceId, label, fromLoc, addedAt }]

// Emergency Routes — pre-defined fallback journeys (authored in Settings,
// calm), checked live on the "Emergency" Live sub-tab when disruption
// actually hits. Each route is a manually-authored chain of legs; see
// emergency-routes-spec.md for the full design.
// [{ id, label, legs: [{ from, fromName, to, toName }] }]
let alternativeRoutes = [];
// Off by default and deliberately not tied to whether any routes are
// configured — this is a "only show this when it's actually useful"
// switch, tapped on when disruption hits and (per Wayne's steer) left
// off the rest of the time, not an auto-derived visibility state.
let emergencyTabVisible = false;

// Home/Work stations — used to work out each Emergency route's "direction"
// (does it end at Home, or at Work?) for AM/PM grouping and sorting on the
// Emergency tab. Defaulting to Crewe/Wigan North Western preserves
// Wayne's existing behaviour with zero setup required, while making the
// app's core CRE/WGN assumption a configurable setting rather than a
// hardcoded one — relevant if this is ever distributed more widely
// (e.g. via Google Play) to someone with a different commute.
let homeStation = { code: 'CRE', name: 'Crewe' };
let workStation = { code: 'WGN', name: 'Wigan North Western' };
// Resolved, per-station values — always the actual effective radius in
// use right now, whether set independently or currently driven by the
// other station's "Match" tickbox in the settings editor. Deliberately
// the only thing the geofence check itself ever reads — anything reading
// these later (this app, or a future Wear OS companion) only ever needs
// two plain numbers, not the sync relationship that produced them.
let geofenceRadiusCrewe = DEFAULT_GEOFENCE_RADIUS_M;
let geofenceRadiusWigan = DEFAULT_GEOFENCE_RADIUS_M;
// 2026-09-24: shared secret sent as X-PWA-Secret on PUT /api/watch-config
// (Worker's PWA_SHARED_SECRET). Lives only in this device's localStorage,
// entered via Settings > Write secret — deliberately never hardcoded in this
// file, since index.html is public and anything in it is readable by anyone.
let pwaWriteSecret = '';
// UI memory only — which direction of sync (if any) the settings editor
// should show as ticked next time it's opened. At most one of these is
// ever true; the editor enforces that mutual exclusion on tick, not just
// on save. Not consulted by the geofence check itself.
let geofenceCreweMatchesWigan = false;
let geofenceWiganMatchesCrewe = false;
let likelyTrainSuggestion = null; // { dateKey, direction, trainKey, label } — transient, not persisted
let likelyTrainCheckTimer = null;      // pending setTimeout handle, or null when nothing's scheduled right now
let likelyTrainChecksActive = false;   // true from startLikelyTrainChecks() until stopLikelyTrainChecks()
let likelyTrainCycleRunning = false;   // guards against an overlapping cycle if one run takes longer than expected
let dismissedLikelyTrainKeys = new Set(); // avoids re-suggesting the same match repeatedly in one session
let notifiedLikelyTrainKeys = new Set(); // avoids re-sending the push notification for the same match on every poll cycle — the banner itself still refreshes each cycle, only the notification is one-shot per suggestionId
// A passive, no-response-needed notice that the silent-confirm branch
// above actually fired — the "no surprise, just quietly confirm it" path
// otherwise leaves no trace anywhere the person would see it. Persisted
// (unlike likelyTrainSuggestion) so it survives a reload/backgrounding
// and genuinely stays up "until dismissed" rather than just for the
// session — but only ever needs writing once per direction per day,
// since confirmedTrains itself blocks the underlying check from firing
// again for that direction once it's set.
let silentConfirmBanner = null; // { dateKey, direction, trainKey, label, source: 'phone'|'watch' } | null — source added 2026-09-01, temporary visibility aid, see renderSilentConfirmBanner
// 2026-09-25: catch-up summary — watch confirmations for a PAST date
// (not today) picked up by checkPendingConfirmation because the app
// wasn't opened that day. Deliberately session-only (not persisted to
// localStorage, unlike silentConfirmBanner above): it only ever holds
// entries actually applied in THIS run, so a dismiss-without-reading
// costs nothing but the notice — the underlying confirmedTrains write
// already happened and survives regardless. Reappears next time there's
// something genuinely new to report, never resurrects an old one.
// { entries: [{dateKey, direction, trainKey, label}], expanded: bool } | null
let catchupBanner = null;
// 2026-09-27: Copy for WhatsApp (whatsapp-share-design.md). Evening (PM)
// journeys only. The message is built ahead of any tap, because a
// clipboard write only reliably works straight after a tap with nothing
// slow in between (see copySmartcardToClipboard's staged-copy note).
// pendingJourneyText serves the green banner and the "Is this your
// train?" prompt; the Confirm-train modal builds its own per-train set.
let pendingJourneyText = null;          // { dateKey, trainKey, text, builtAt } | null
let journeyTextTargetKey = null;        // "dateKey|trainKey" the text is currently being kept fresh for
let journeyTextRefreshTimer = null;
let journeyTextRefreshInFlight = false;

// Reads one persisted key: missing, unparseable, or wrong-shaped values all
// fall back to [fallback]. "Wrong-shaped" covers two cases automatically — a
// stored literal null, and an object/array fallback receiving the other kind
// (or a primitive) — so a corrupted key can't hand loadData() a value that
// crashes later on first use. [validate] is for keys that need a stricter,
// key-specific check on top; returning false falls back the same way.
function loadJSON(key, fallback, validate){
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed === null) return fallback;
    if (fallback !== null && typeof fallback === 'object'){
      if (typeof parsed !== 'object' || Array.isArray(parsed) !== Array.isArray(fallback)) return fallback;
    }
    if (validate && !validate(parsed)) return fallback;
    return parsed;
  }catch(e){ return fallback; }
}

async function loadData(){
  comments = loadJSON('ticket-comments', {});
  travelOverrides = loadJSON('ticket-travel-overrides', {});
  purchases = loadJSON('ticket-purchases', []);
  if (ensurePurchaseFields()) savePurchases(); // 2026-10-06 — one-off backfill of id/purchasedOn on older records
  lastKnownPrice = loadJSON('ticket-last-price', 153.60);
  parkingCost = loadJSON('ticket-parking-cost', 6.39);
  smartcardNumber = loadJSON('smartcard-number', '');
  produceClaimDetailsFile = loadJSON('produce-claim-details-file', true);
  paydayEstimateSnapshots = loadJSON('payday-estimate-snapshots', {});
  parkedDays = loadJSON('parked-days', {});
  dismissedParkingSavingsPeriods = loadJSON('dismissed-parking-savings-periods', {});
  parkingSavingsSnapshots = loadJSON('parking-savings-snapshots', {});
  parkingBudgetDays = loadJSON('parking-budget-days', {});
  ticketsSpentCardDismissed = loadJSON('tickets-spent-card-dismissed', false);
  pollBeforeDepartureMin = clampPollBeforeDepartureMin(loadJSON('poll-before-departure-min', 5));
  pollCheckInIntervalMin = clampPollCheckInIntervalMin(loadJSON('poll-check-in-interval-min', 15));
  geofenceRadiusCrewe = clampGeofenceRadius(loadJSON('geofence-radius-crewe', DEFAULT_GEOFENCE_RADIUS_M));
  geofenceRadiusWigan = clampGeofenceRadius(loadJSON('geofence-radius-wigan', DEFAULT_GEOFENCE_RADIUS_M));
  geofenceCreweMatchesWigan = loadJSON('geofence-crewe-matches-wigan', false);
  geofenceWiganMatchesCrewe = loadJSON('geofence-wigan-matches-crewe', false);
  pwaWriteSecret = loadJSON('pwa-write-secret', '', (v) => typeof v === 'string');
  dayReturnPrice = loadJSON('ticket-day-return-price', 21.00);
  fareCheckedYear = loadJSON('ticket-fare-checked-year', null);
  dismissedMonths = loadJSON('ticket-dismissed-months', {});
  gcalEnabled = loadJSON('gcal-enabled', false);
  preferredGoogleEmail = loadJSON('preferred-google-email', '');
  debugModeEnabled = loadJSON('debug-mode-enabled', false);
  weatherEnabled = loadJSON('weather-enabled', true);
  alternativeRoutes = loadJSON('alternative-routes', []);
  emergencyTabVisible = loadJSON('emergency-tab-visible', false);
  homeStation = loadJSON('home-station', { code: 'CRE', name: 'Crewe' });
  workStation = loadJSON('work-station', { code: 'WGN', name: 'Wigan North Western' });
  driveBackupEnabled = loadJSON('drive-backup-enabled', false);
  transportShareEnabled = loadJSON('transport-estimates-enabled', false); // 2026-10-06 — Share estimates with Personal Finance
  driveBackupDirty = loadJSON('drive-backup-dirty', false);
  lastDriveBackupTime = loadJSON('drive-backup-last-time', 0);
  driveBackupFolderId = loadJSON('drive-backup-folder-id', null);
  gcalEventId = loadJSON('gcal-event-id', null);
  gcalPendingSync = loadJSON('gcal-pending-sync', false);
  lastNotifiedBuyKey = loadJSON('ticket-last-notified-buy-key', null);
  railTrains = loadJSON('rail-trains', DEFAULT_RAIL_TRAINS.slice());
  // 2026-09-18 — target-train alert settings (see the block after
  // DEFAULT_RAIL_TRAINS). Nothing stored yet -> the spec's defaults; a
  // stored value, even an empty one, is respected as-is.
  trainAlertConfig = loadJSON(
    'train-alert-config',
    defaultTrainAlertConfigFor(railTrains),
    v => v && typeof v === 'object' && !Array.isArray(v)
  );
  {
    const parsedTT = loadJSON('target-trains', null);
    defaultTargetTrains = (parsedTT && parsedTT.defaultTargetTrains && typeof parsedTT.defaultTargetTrains === 'object') ? parsedTT.defaultTargetTrains : defaultTargetTrainsFor(railTrains);
    targetTrainOverrides = (parsedTT && parsedTT.targetTrainOverrides && typeof parsedTT.targetTrainOverrides === 'object') ? parsedTT.targetTrainOverrides : {};
  }
  pruneTargetTrainOverrides();
  // 2026-09-30 — morning drive check (see DEFAULT_DRIVE_CHECK_CONFIG).
  driveCheckConfig = loadJSON(
    'drive-check-config',
    JSON.parse(JSON.stringify(DEFAULT_DRIVE_CHECK_CONFIG)),
    v => v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.routes)
  );
  driveCheckHome = loadJSON('drive-check-home', null, v => v === null || isValidLatLng(v));
  railPerfCache = loadJSON('rail-perf-cache', {});
  railSyncedDays = loadJSON('rail-synced-days', {});
  // One-time reset: an earlier version of railSyncedDays could mark a
  // train as "synced" for a date based on a DIFFERENT train's result for
  // that same date (a since-fixed proxy/client bug — see
  // rail-performance-proxy.js and railSyncDatesBatch's comments). Those
  // entries look identical to correct ones and can't be told apart after
  // the fact, so the only reliable fix is to clear the whole cache once
  // and let it rebuild accurately. Costs one extra full backfill pass;
  // real data in railPerfCache itself is untouched.
  try{
    if (!localStorage.getItem('rail-synced-days-reset-v2')){
      railSyncedDays = {};
      localStorage.setItem('rail-synced-days', '{}'); // persist the clear immediately — don't rely on the next sync to save it
      localStorage.setItem('rail-synced-days-reset-v2', '1');
    }
  }catch(e){ /* not critical if this flag can't be set — worst case it resets again next load */ }
  railHistoryDaysBack = loadJSON('rail-history-days-back', 90);
  reasonCodesCache = loadJSON('reason-codes-cache', { fetchedAt: 0, codes: {} });
  confirmedTrains = loadJSON('confirmed-trains', {});
  // Only meaningful for today — a leftover banner from a previous day
  // (e.g. the app wasn't opened again before the day rolled over) has
  // nothing left to dismiss; it should just be gone, not show up
  // referencing yesterday's train.
  silentConfirmBanner = loadJSON('silent-confirm-banner', null, v => v && v.dateKey === fmtKey(new Date()));
  delayClaims = loadJSON('delay-claims', {});
  trackedTrains = loadJSON('tracked-trains', []);
  // Elapsed-time expiry only — deliberately not tied to the calendar
  // day. A previous version also cleared the whole list outright on
  // the first app open of a new day, on the reasoning that a train
  // tracked yesterday evening has no business surviving into this
  // morning's commute. But that only ever fired at app-load, so a
  // genuinely overnight service tracked at 23:00 and still running
  // when the app was reopened at 00:05 would be wiped outright, not
  // just stale-looking — the exact case this app's own midnight-aware
  // date logic elsewhere is built to handle correctly. Tracked-train
  // persistence should follow the journey's actual lifetime, which
  // this age check already does correctly across a midnight crossing,
  // not the calendar date.
  {
    const now = Date.now();
    trackedTrains = trackedTrains.filter(t => (now - t.addedAt) < TRACKED_TRAIN_MAX_AGE_MS);
  }
  // These three still need their own try/catch: new Map(...) throws on a value that
  // parsed fine as JSON but isn't iterable as entries (e.g. a plain object rather than
  // an array of pairs) — a failure loadJSON's own try/catch can't see, since it happens
  // after loadJSON has already returned successfully.
  try{
    confirmedPointStatusCache = new Map(loadJSON('confirmed-point-status-cache', []));
    pruneConfirmedPointStatusCache(); // trackedTrains is already fully loaded/filtered by this point above
  }catch(e){ confirmedPointStatusCache = new Map(); }
  try{
    lastSeenJourneyState = new Map(loadJSON('last-seen-journey-state', []));
    pruneLastSeenJourneyState(); // trackedTrains is already fully loaded/filtered by this point above
  }catch(e){ lastSeenJourneyState = new Map(); }
  try{
    lastSeenStaffMatch = new Map(loadJSON('last-seen-staff-match', []));
    pruneLastSeenStaffMatch();
  }catch(e){ lastSeenStaffMatch = new Map(); }
  periodStart = loadJSON('ticket-period-start', DEFAULT_PERIOD_START);

  // One-time import of the comments from the original spreadsheet.
  // Only fills in dates that don't already have a comment, and only runs once.
  const alreadySeeded = !!loadJSON('ticket-seed-imported', false);

  if (!alreadySeeded){
    let changed = false;
    for (const key in SEED_COMMENTS){
      if (!comments[key]){
        comments[key] = SEED_COMMENTS[key];
        changed = true;
      }
    }
    if (changed) await saveComments();
    try{ localStorage.setItem('ticket-seed-imported', JSON.stringify(true)); }catch(e){}
  }

}

async function saveComments(){
  try{ localStorage.setItem('ticket-comments', JSON.stringify(comments)); }
  catch(e){ /* save failed silently; will retry next change */ }
  schedulePushWatchConfig(); // 2026-09-18 — a day tagged (or untagged) WFH/HOLIDAY/etc changes which days the watch should stay quiet on
}
async function saveTravelOverrides(){
  try{ localStorage.setItem('ticket-travel-overrides', JSON.stringify(travelOverrides)); }
  catch(e){ /* save failed silently; will retry next change */ }
  schedulePushWatchConfig(); // 2026-09-18 — "I still used the ticket today" turns a tagged day back into a commute
}
// 2026-10-06 (claude/ticket-purchases-tracker-addendum.md 2b) — season
// purchase records carry id ('p-' + start date — date-based so a restore of
// an older backup can never re-make it differently) and purchasedOn (the day
// it was bought; older records get the day before the start date, how
// tickets are actually bought). Singles are left alone. Returns true if
// anything was filled in.
function ensurePurchaseFields(){
  let changed = false;
  purchases.forEach(p => {
    if (!p || p.type === 'single' || typeof p.date !== 'string') return;
    const id = `p-${p.date}`;
    if (p.id !== id){ p.id = id; changed = true; }
    if (typeof p.purchasedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.purchasedOn)){
      p.purchasedOn = fmtKey(addDays(parseKey(p.date), -1));
      changed = true;
    }
  });
  return changed;
}
async function savePurchases(){
  ensurePurchaseFields(); // every way a purchase is added goes through here
  try{ localStorage.setItem('ticket-purchases', JSON.stringify(purchases)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveLastKnownPrice(){
  try{ localStorage.setItem('ticket-last-price', JSON.stringify(lastKnownPrice)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveParkingCost(){
  try{ localStorage.setItem('ticket-parking-cost', JSON.stringify(parkingCost)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveSmartcardNumber(){
  try{ localStorage.setItem('smartcard-number', JSON.stringify(smartcardNumber)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveProduceClaimDetailsFile(){
  try{ localStorage.setItem('produce-claim-details-file', JSON.stringify(produceClaimDetailsFile)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function savePaydayEstimateSnapshots(){
  try{ localStorage.setItem('payday-estimate-snapshots', JSON.stringify(paydayEstimateSnapshots)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveParkedDays(){
  try{ localStorage.setItem('parked-days', JSON.stringify(parkedDays)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveDismissedParkingSavingsPeriods(){
  try{ localStorage.setItem('dismissed-parking-savings-periods', JSON.stringify(dismissedParkingSavingsPeriods)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveParkingSavingsSnapshots(){
  try{ localStorage.setItem('parking-savings-snapshots', JSON.stringify(parkingSavingsSnapshots)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveParkingBudgetDays(){
  try{ localStorage.setItem('parking-budget-days', JSON.stringify(parkingBudgetDays)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveTicketsSpentCardDismissed(){
  try{ localStorage.setItem('tickets-spent-card-dismissed', JSON.stringify(ticketsSpentCardDismissed)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function savePollingSettings(){
  try{
    localStorage.setItem('poll-before-departure-min', JSON.stringify(pollBeforeDepartureMin));
    localStorage.setItem('poll-check-in-interval-min', JSON.stringify(pollCheckInIntervalMin));
  }catch(e){ /* save failed silently; will retry next change */ }
}
async function saveGeofenceSettings(){
  try{
    localStorage.setItem('geofence-radius-crewe', JSON.stringify(geofenceRadiusCrewe));
    localStorage.setItem('geofence-radius-wigan', JSON.stringify(geofenceRadiusWigan));
    localStorage.setItem('geofence-crewe-matches-wigan', JSON.stringify(geofenceCreweMatchesWigan));
    localStorage.setItem('geofence-wigan-matches-crewe', JSON.stringify(geofenceWiganMatchesCrewe));
  }catch(e){ /* save failed silently; will retry next change */ }
  pushWatchConfig();
}
async function savePwaWriteSecret(){
  try{ localStorage.setItem('pwa-write-secret', JSON.stringify(pwaWriteSecret)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveDayReturnPrice(){
  try{ localStorage.setItem('ticket-day-return-price', JSON.stringify(dayReturnPrice)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveFareCheckedYear(){
  try{ localStorage.setItem('ticket-fare-checked-year', JSON.stringify(fareCheckedYear)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveDismissedMonths(){
  try{ localStorage.setItem('ticket-dismissed-months', JSON.stringify(dismissedMonths)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveGcalEnabled(){
  try{ localStorage.setItem('gcal-enabled', JSON.stringify(gcalEnabled)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function savePreferredGoogleEmail(){
  try{ localStorage.setItem('preferred-google-email', JSON.stringify(preferredGoogleEmail)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveDebugMode(){
  try{ localStorage.setItem('debug-mode-enabled', JSON.stringify(debugModeEnabled)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveWeatherEnabled(){
  try{ localStorage.setItem('weather-enabled', JSON.stringify(weatherEnabled)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveAlternativeRoutes(){
  try{ localStorage.setItem('alternative-routes', JSON.stringify(alternativeRoutes)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveEmergencyTabVisible(){
  try{ localStorage.setItem('emergency-tab-visible', JSON.stringify(emergencyTabVisible)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveHomeStation(){
  try{ localStorage.setItem('home-station', JSON.stringify(homeStation)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveWorkStation(){
  try{ localStorage.setItem('work-station', JSON.stringify(workStation)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveDriveBackupEnabled(){
  try{ localStorage.setItem('drive-backup-enabled', JSON.stringify(driveBackupEnabled)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveDriveBackupFolderId(){
  try{ localStorage.setItem('drive-backup-folder-id', JSON.stringify(driveBackupFolderId)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveGcalEventId(){
  try{ localStorage.setItem('gcal-event-id', JSON.stringify(gcalEventId)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveGcalPendingSync(){
  try{ localStorage.setItem('gcal-pending-sync', JSON.stringify(gcalPendingSync)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveLastNotifiedBuyKey(){
  try{ localStorage.setItem('ticket-last-notified-buy-key', JSON.stringify(lastNotifiedBuyKey)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveRailTrains(){
  try{ localStorage.setItem('rail-trains', JSON.stringify(railTrains)); }
  catch(e){ /* save failed silently; will retry next change */ }
  pushWatchConfig();
}

async function saveTrainAlertConfig(){
  try{ localStorage.setItem('train-alert-config', JSON.stringify(trainAlertConfig)); }
  catch(e){ /* save failed silently; will retry next change */ }
  schedulePushWatchConfig();
}
async function saveTargetTrains(){
  try{ localStorage.setItem('target-trains', JSON.stringify({ defaultTargetTrains, targetTrainOverrides })); }
  catch(e){ /* save failed silently; will retry next change */ }
  schedulePushWatchConfig();
}
// 2026-09-30 — morning drive check. No push here: the editor pushes
// immediately itself (and waits for it before "Test now").
function saveDriveCheckSettings(){
  try{
    localStorage.setItem('drive-check-config', JSON.stringify(driveCheckConfig));
    localStorage.setItem('drive-check-home', JSON.stringify(driveCheckHome));
  }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveRailPerfCache(){
  try{ localStorage.setItem('rail-perf-cache', JSON.stringify(railPerfCache)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveRailSyncedDays(){
  try{ localStorage.setItem('rail-synced-days', JSON.stringify(railSyncedDays)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveRailHistoryDaysBack(){
  try{ localStorage.setItem('rail-history-days-back', JSON.stringify(railHistoryDaysBack)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveReasonCodesCache(){
  try{ localStorage.setItem('reason-codes-cache', JSON.stringify(reasonCodesCache)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveConfirmedTrains(){
  try{ localStorage.setItem('confirmed-trains', JSON.stringify(confirmedTrains)); }
  catch(e){ /* save failed silently; will retry next change */ }
}
async function saveSilentConfirmBanner(){
  try{
    if (silentConfirmBanner) localStorage.setItem('silent-confirm-banner', JSON.stringify(silentConfirmBanner));
    else localStorage.removeItem('silent-confirm-banner');
  }catch(e){ /* save failed silently; will retry next change */ }
}
async function saveTrackedTrains(){
  try{ localStorage.setItem('tracked-trains', JSON.stringify(trackedTrains)); }
  catch(e){ /* save failed silently; will retry next change */ }
  // Keeps the confirmed-status cache from outliving the tracked train it
  // belongs to, however that train's entry came to be removed.
  pruneConfirmedPointStatusCache();
  saveConfirmedPointStatusCache();
  pruneLastSeenJourneyState();
  saveLastSeenJourneyState();
  pruneLastSeenStaffMatch();
  saveLastSeenStaffMatch();
}
async function savePeriodStart(){
  try{ localStorage.setItem('ticket-period-start', JSON.stringify(periodStart)); }
  catch(e){ /* save failed silently; will retry next change */ }
}

let state = {
  today: new Date(),
  daysAhead: 13,
  activeTab: 'today', // drives which bottom-nav icon is highlighted
};
