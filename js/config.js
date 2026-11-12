// config.js — Constants: APP_VERSION, Google client ID, Worker URLs, icons, DEFAULT_* values, BACKUP_KEYS.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.
const PRESET_TAGS = ['WFH', 'HOLIDAY', 'DENTIST', 'SICK'];

// Simple line-style icons for the bottom nav bar — inherit colour via
// currentColor so active/inactive state is just a CSS colour change.
const NAV_ICONS = {
  today: '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-5.5h4V20h3a1 1 0 0 0 1-1v-9"/></svg>',
  live: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="13" rx="4"/><path d="M5 12h14"/><circle cx="8.5" cy="20" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="20" r="1.3" fill="currentColor" stroke="none"/><path d="M8 17l-2 3M16 17l2 3"/></svg>',
  buy: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="8" cy="14.5" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="14.5" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="14.5" r="1" fill="currentColor" stroke="none"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
};

// Replace this with your own OAuth client ID from Google Cloud Console
// to enable the Google Calendar sync feature. Safe to be public — a
// client ID is not a secret, unlike an API key or password.
const GOOGLE_CLIENT_ID = '130585374763-he5hjhlgigril8otmlcalp4llonefl4e.apps.googleusercontent.com';
const APP_VERSION = 'v2026-11-12.19:26'; // bump this on every deploy — lets you confirm what's actually running vs what's on GitHub
const DRIVE_BACKUP_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes
const DRIVE_BACKUP_FOLDER_NAME = 'Ticket Tracker Backups';
const DRIVE_BACKUP_KEEP_COUNT = 2;

// Optional one-off import of past comments, e.g. from an old spreadsheet.
// Left empty here deliberately — this file is public. See import-seed-data.js
// (kept out of the GitHub repo) for how to load personal history in privately.
const SEED_COMMENTS = {};

const PERIOD_LENGTH = 28; // ticket valid for 28 calendar days
const USES_PER_PERIOD = 8; // 8 day-passes within that window
const DEFAULT_PERIOD_START = '2026-07-29'; // ticket bought tonight, starts tomorrow
const SMARTCARD_NUMBER_MAX_LENGTH = 20;
// Sanity caps for the two settings above, and a shared clamp used both
// when saving from the editor and when loading back from localStorage —
// previously only the editor's own minimum check existed (beforeVal>=0,
// checkInVal>=1), with no upper bound at all, and nothing revalidated a
// value already sitting in storage (which could in principle be
// corrupted, or edited directly via devtools) before trusting it.
const POLL_BEFORE_DEPARTURE_MIN_MAX = 60; // resuming full polling more than an hour before departure serves no real purpose
const POLL_CHECK_IN_INTERVAL_MIN_MAX = 120; // beyond this the "safety net" check-in stops meaningfully protecting against a mid-wait cancellation

// Rail performance / delay repay feature
const RAIL_WORKER_URL = 'https://rail-performance-proxy.wayne-lee-paul-reynolds.workers.dev';
const DARWIN_WORKER_URL = 'https://darwin-live-proxy.wayne-lee-paul-reynolds.workers.dev';

// Fares API (season ticket + day return price check) — see FARE_CHECK_ORIG/DEST
// below and openBuyScreen()'s once-a-year fresh-price check.
const FARES_WORKER_URL = 'https://fares-proxy.wayne-lee-paul-reynolds.workers.dev';
const FARE_CHECK_ORIG = 'CRE';
const FARE_CHECK_DEST = 'WGN';
const DELAY_REPAY_THRESHOLD_MINUTES = 15;
const RAIL_DAYS_BACK_STEP = 7;
const RAIL_MAX_DAYS_BACK = 28; // matches Avanti's Delay Repay claim deadline
// 2026-09-30: an empty HSP answer for a date this recent isn't treated as
// final — see railSyncDatesBatch. HSP normally has a day's record by the
// next morning; 3 days covers a weekend-length lag with room to spare.
const RAIL_RECENT_RETRY_DAYS = 3;
const RAIL_HISTORY_STEP_DAYS = 90;
const RAIL_HISTORY_MAX_DAYS_BACK = 370;
const REASON_CODES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_RAIL_TRAINS = [
  { key: 'am-0808', direction: 'AM', fromLoc: 'CRE', toLoc: 'WGN', time: '0808', label: '08:08' },
  { key: 'am-0727', direction: 'AM', fromLoc: 'CRE', toLoc: 'WGN', time: '0727', label: '07:27' },
  { key: 'pm-1731', direction: 'PM', fromLoc: 'WGN', toLoc: 'CRE', time: '1731', label: '17:31' },
  { key: 'pm-1631', direction: 'PM', fromLoc: 'WGN', toLoc: 'CRE', time: '1631', label: '16:31' },
  { key: 'pm-1831', direction: 'PM', fromLoc: 'WGN', toLoc: 'CRE', time: '1831', label: '18:31' },
];

// ---------------------------------------------------------------------
// Target-train alerts (2026-09-18, target-train-alert-spec.md, slice 1)
//
// The watch wakes at each train's "alert at" time, asks the Worker how the
// day's TARGET train for that direction is running, and buzzes with
// on time / delayed / cancelled + platform. Everything the watch needs is
// pushed to the Worker by pushWatchConfig() below:
//
//   trainAlertConfig     trainKey -> { checkTime: 'HH:MM', earlyWarningLeadMin }
//                        (localStorage 'train-alert-config'). A train with
//                        no checkTime simply has no alert. earlyWarningLeadMin
//                        is carried for the later early-warning slice and is
//                        always null for now.
//   defaultTargetTrains  { AM?: trainKey, PM?: trainKey } — which train to
//                        report on when there's no override. Absent = no alert
//                        for that direction. (localStorage 'target-trains')
//   targetTrainOverrides dateKey -> { AM?: trainKey, PM?: trainKey } — the
//                        evening-before "tomorrow I'm catching the 07:27"
//                        control on the Live screen. Sparse: only a date/
//                        direction that differs from the default is stored, and
//                        past dates are pruned on load. (same 'target-trains' key)
//
// Nothing here is derived from data that isn't already in the app: the
// commute-day rule is the same one findNextTravelDay/isEligibleRailDay
// already use (a weekday is a commute day if it has no comment tag, or the
// tag was overridden with "I still used the ticket today").
// ---------------------------------------------------------------------
const DEFAULT_TRAIN_ALERT_CONFIG = {
  'am-0727': { checkTime: '06:30', earlyWarningLeadMin: null },
  'am-0808': { checkTime: '07:15', earlyWarningLeadMin: null },
  'pm-1631': { checkTime: '15:45', earlyWarningLeadMin: null },
  'pm-1731': { checkTime: '16:00', earlyWarningLeadMin: null },
  'pm-1831': { checkTime: '17:15', earlyWarningLeadMin: null },
};
const DEFAULT_TARGET_TRAINS = { AM: 'am-0808', PM: 'pm-1731' };
const NON_TRAVEL_PUSH_DAYS = 60; // how far ahead the PWA tells the Worker which days aren't commutes
const ALERT_CHECK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------
// Morning drive check (2026-09-30, drive-check-spec.md, slice 2)
//
// Before leaving home the watch asks the Worker how the drive to Crewe
// station looks (Google Routes, traffic-aware) on each configured route, and
// buzzes "Go via X" / "X slow" / "X clear". This file only holds the settings
// and pushes them; the check itself runs in the Worker (/api/drive-check).
//
//   driveCheckConfig  localStorage 'drive-check-config' (backed up):
//                     { enabled, checkTimesByTrain: { trainKey: 'HH:MM' },
//                       station: {lat,lng}, delayThresholdMin, switchThresholdMin,
//                       routes: [{ key, name, via: [{lat,lng}], usual }] }
//   driveCheckHome    localStorage 'drive-check-home' — {lat,lng} or null.
//                     Deliberately NOT in BACKUP_KEYS: the backup file gets
//                     shared (Project Knowledge, peer review), and the home
//                     location should only ever live on this device and in the
//                     Worker's KV. A restore just means entering it once again.
//
// No coordinates are defaulted here — index.html is public on GitHub Pages.
// The defaults carry route names, times and thresholds only; pins are pasted
// in via Settings → Drive check.
// ---------------------------------------------------------------------
const DEFAULT_DRIVE_CHECK_CONFIG = {
  enabled: false,
  checkTimesByTrain: { 'am-0808': '07:35', 'am-0727': '06:55' },
  station: null,
  delayThresholdMin: 5,
  switchThresholdMin: 5,
  routes: [
    { key: 'a500', name: 'A500', via: [], usual: true },
    { key: 'weston', name: 'Weston Rd', via: [], usual: false },
    { key: 'gresty', name: 'Gresty Rd', via: [], usual: false },
  ],
};
const DRIVE_CHECK_MAX_ROUTES = 4;
const DRIVE_CHECK_MAX_VIAS = 3;
// 2026-09-30 (slice 4) — on-demand drive check for the Live tab row and the
// morning auto-banner. Uses the Worker's ?now=1 mode: skips the day/slot
// gates but reuses a result from the last few minutes, so repeat taps (or an
// app open just after the 07:35 scheduled check) cost no Google calls.
// lastDriveCheck is kept here, outside the Live screen, so closing and
// reopening it doesn't re-ask either.
const DRIVE_CHECK_REUSE_MS = 3 * 60 * 1000;
const DRIVE_AUTO_START_MIN = 7 * 60 + 30; // 07:30
const DRIVE_AUTO_END_MIN = 7 * 60 + 45;   // 07:45 (inclusive)

// Crewe and Wigan North Western: manually verified, field-tested
// coordinates — gathered on-site (via a since-removed temporary debug
// tool for capturing precise coordinates in and around each station),
// not looked up from the official/public dataset. These were found to
// differ from official coordinates in ways that matter for this app's
// geofencing, so they intentionally override the general station
// dataset below for these two stations specifically. Do not replace
// these with dataset-derived coordinates — the dataset remains the
// right fallback for every other station, and for names generally
// (see stationNameForCrs), just not for Crewe/Wigan's coordinates.
const STATION_COORDS = {
  CRE: { lat: 53.0896, lon: -2.4333, name: 'Crewe' },
  WGN: { lat: 53.5433, lon: -2.6326, name: 'Wigan North Western' },
};
const AVANTI_CLAIM_URL = 'https://delayrepay.avantiwestcoast.co.uk/';

// ---- Pass photo storage (IndexedDB) ----
// Delay repay claims almost always want a photo of your pass. Stored
// here as a Blob rather than in localStorage, which can only hold
// strings and has nowhere near enough quota for an image. A single
// fixed record ('current') — uploading a new photo replaces it, so
// there's never more than one to manage or clean up.
const PASS_PHOTO_DB_NAME = 'pass-photo-store';
const PASS_PHOTO_DB_VERSION = 1;
const PASS_PHOTO_STORE = 'photos';
const PASS_PHOTO_KEY = 'current';

// Confirmed against two real Avanti claims on the Flexi 8 ticket: a 15-29
// min delay paid £2.40 and a 30-59 min delay paid £4.80, both matching
// (ticket price ÷ 16) × band exactly at £153.60. Worth re-checking if the
// ticket type or price structure ever changes.
const DELAY_REPAY_DIVISOR = 16;
const TRACKED_TRAIN_MAX_AGE_MS = 6 * 60 * 60 * 1000; // stop tracking after 6 hours regardless — a journey this long has almost certainly finished
const TRACKED_TRAIN_MAX = 5; // matches the cap enforced when a train is opened (see openTrainProgress) — kept in one place so the "Track a train" flow can check it before adding, rather than only finding out after something's already been silently dropped
// A service well ahead of its scheduled time that fails to load (both
// GetServiceDetails and the pure-board recovery lookup come back empty)
// is very often just not "activated" in Darwin/TRUST yet, rather than
// anything actually wrong — a real service on a real board, Darwin
// simply hasn't attached live tracking to it. Confirmed via one real
// occurrence (2026-09-04): a Caledonian Sleeper booked for 23:45 failed
// to load at 22:03, 102 minutes ahead of departure. No documented
// Darwin activation window to derive this from, so 45 minutes is a
// first-guess threshold rather than a confirmed boundary — only used to
// pick a friendlier, less alarming message ("try again closer to
// departure" instead of a raw error), so a wrong guess here costs
// nothing beyond wording; worth revisiting if a genuine unrelated
// failure this far out gets mislabelled by it, or if a service closer
// in than this still turns out to be pre-activation.
const LIKELY_NOT_YET_ACTIVATED_MIN_AWAY = 45;

// "I think you're on this train" detection
const DEFAULT_GEOFENCE_RADIUS_M = 500; // original single value, informed by real field-test readings — now just the starting point for both stations, and a defensive fallback for an unrecognised station code
// Sane bounds for either station's radius, shared by the settings editor
// and by loading back from storage — a tight floor stops the boarding
// side from being tuned so small that ordinary GPS wobble on the
// platform itself starts causing missed detections; the ceiling is a
// sanity cap well beyond the original 500m already found too wide.
const GEOFENCE_RADIUS_MIN_M = 50;
const GEOFENCE_RADIUS_MAX_M = 1000;
const LIKELY_TRAIN_CHECK_INTERVAL_MS = 2 * 60 * 1000; // baseline cadence while nowhere near a departure
const LIKELY_TRAIN_FAST_CHECK_INTERVAL_MS = 30 * 1000; // tighter cadence right around a configured departure, where silent-confirm timing actually matters
const LIKELY_TRAIN_FAST_WINDOW_BEFORE_MIN = 2;  // start the fast cadence this many minutes before a configured departure
const LIKELY_TRAIN_FAST_WINDOW_AFTER_MIN = 10;  // ...and keep it up to this many minutes after, to cover a modestly delayed departure
// Was 45 — wide enough that adjacent configured trains an hour apart
// (e.g. 16:31/17:31) had overlapping windows, so simply being near the
// station well before your actual train could bring an earlier one into
// scope at all. Tightened so neighbouring hourly-ish trains no longer
// overlap under normal circumstances.
const LIKELY_TRAIN_TIME_WINDOW_MIN = 20; // only bother checking within this many minutes either side of a configured train time
const LIKELY_ARRIVAL_WINDOW_FORWARD_MIN = 90; // arrival-side check: forward-only from departure time, wide enough for a real journey plus a heavy delay. Widened from 50 on 2026-11-06 to match the Worker's STATION_PING_ARRIVAL_WINDOW_FORWARD_MIN — see the note in checkLikelyArrival
// How close a candidate's own live departure must be to right now before
// it's confident enough to silently confirm without asking. Separate from
// (and stricter than) the general 15-minute threshold below that decides
// which train even counts as "closest" in the first place — that wider
// threshold is still fine for deciding whether to show the ask-first
// banner on a genuine mismatch; it was only ever a problem when it also
// governed the *silent* write.
const SILENT_CONFIRM_MAX_DIFF_MIN = 5;
const JOURNEY_TEXT_REFRESH_MS = 2 * 60 * 1000; // same cadence as the likely-train baseline
const JOURNEY_TEXT_COPIED_KEY = 'journey-text-copied'; // { dateKey, trainKey, status: 'copied'|'failed-once'|'abandoned' } — UI state only, not backed up
const CONFIRMED_CATCHUP_LOOKBACK_DAYS = 7; // matches the Worker's CONFIRMED_TRAIN_TTL_SECONDS — no point asking further back than it keeps

// Deliberately excludes: confirmed-point-status-cache, silent-confirm-banner
// (transient UI/derived state, not something a restore needs), and
// drive-backup-dirty/drive-backup-last-time (the backup mechanism's own
// internal bookkeeping, not app data). Also excludes reason-codes-cache,
// rail-synced-days, and rail-history-days-back — all genuinely
// disposable: reason-codes-cache re-fetches itself when stale; rail-
// synced-days is just "have we asked HSP about this date" bookkeeping,
// not a value in itself (losing it means some already-known weekdays get
// harmlessly re-queried once, nothing more); rail-history-days-back is
// just how far the Performance history page currently reaches, trivially
// regrown via its own "Load more history" button. rail-perf-cache itself
// DOES stay in the backup, unlike those — it's the actual historical
// values, and HSP's retention window means a badly-delayed restore could
// otherwise lose real history permanently, not just re-fetch it. Also
// excludes the smartcard pass photo entirely — that lives in IndexedDB,
// not localStorage, and isn't covered by this mechanism at all. If any
// of this ever needs to change, the messaging around what a backup
// contains needs updating alongside it, not just this list.
// 2026-09-30: 'drive-check-config' is backed up; 'drive-check-home' (the home
// location for the morning drive check) is deliberately NOT — see the note
// above DEFAULT_DRIVE_CHECK_CONFIG.
// 2026-10-24: added 'parking-budget-days' (the locked per-period travel days —
// rebuilding it after a restore would re-derive the budget from today's tags,
// undoing the very lock it exists for) and 'ticket-fare-checked-year' (so a
// restore doesn't re-show the annual fare-check prompt). Still deliberately
// excluded: 'pwa-write-secret' (a credential — the backup file gets shared),
// the Google token/status keys (the Worker holds the refresh token, so the
// connection normally survives a restore), and the transport-estimates-*
// bookkeeping (device-only, re-found or re-published).
const BACKUP_KEYS = [
  'alternative-routes','bank-holidays-cache','confirmed-trains','debug-mode-enabled','delay-claims',
  'dismissed-parking-savings-periods','drive-backup-enabled','drive-backup-folder-id','drive-check-config',
  'emergency-tab-visible',
  'gcal-enabled','gcal-event-id','gcal-pending-sync',
  'geofence-crewe-matches-wigan','geofence-radius-crewe','geofence-radius-wigan','geofence-wigan-matches-crewe',
  'home-station',
  'parked-days','parking-budget-days','parking-savings-snapshots',
  'payday-estimate-snapshots','poll-before-departure-min','poll-check-in-interval-min','preferred-google-email',
  'produce-claim-details-file','rail-perf-cache','rail-trains','smartcard-number',
  'ticket-comments','ticket-day-return-price','ticket-dismissed-months','ticket-fare-checked-year',
  'ticket-last-notified-buy-key','ticket-last-price','ticket-parking-cost',
  'ticket-period-start','ticket-purchases','ticket-seed-imported','ticket-travel-overrides',
  'target-trains','tickets-spent-card-dismissed','tracked-trains','train-alert-config','transport-estimates-enabled','weather-enabled','work-station'
];
