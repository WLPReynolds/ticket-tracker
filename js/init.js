// init.js — Load guard, init() and service worker registration — always last.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// 2026-11-10 — load guard for the split codebase (spec: codebase-split-and-costs-form-spec.md §5.3).
// One name from each earlier file. If any is missing, that file didn't load
// (no signal and not cached, or a syntax error in it), so show a plain message
// instead of a blank or half-working app, and stop here before init() runs.
// Adding a new js/ file? Add a line here too — tools/check.sh checks it.
(function checkAllFilesLoaded(){
  const loaded = {
    'config.js':               typeof APP_VERSION !== 'undefined',
    'state.js':                typeof loadData !== 'undefined',
    'util.js':                 typeof fmtKey !== 'undefined',
    'tickets.js':              typeof computeStates !== 'undefined',
    'delay-repay.js':          typeof getDelayStatus !== 'undefined',
    'darwin.js':               typeof queryDarwin !== 'undefined',
    'stations.js':             typeof createStationPicker !== 'undefined',
    'google.js':               typeof attemptDriveBackup !== 'undefined',
    'transport-estimates.js':  typeof scheduleTransportPublish !== 'undefined',
    'watch-sync.js':           typeof pushWatchConfig !== 'undefined',
    'confirm-train.js':        typeof openConfirmTrain !== 'undefined',
    'journey-share.js':        typeof mountCatchupBanner !== 'undefined',
    'emergency-routes.js':     typeof checkEmergencyRoute !== 'undefined',
    'screen-home.js':          typeof render !== 'undefined',
    'screen-calendar.js':      typeof openCalendarView !== 'undefined',
    'screen-live.js':          typeof openLiveScreen !== 'undefined',
    'train-status.js':         typeof describePointStatus !== 'undefined',
    'train-progress-build.js': typeof buildTrainProgress !== 'undefined',
    'train-progress.js':       typeof openTrainProgress !== 'undefined',
    'settings.js':             typeof openSettingsMenu !== 'undefined',
    'settings-trains.js':      typeof openRailConfig !== 'undefined',
    'backup-restore.js':       typeof openBackupRestore !== 'undefined',
    'depboard.js':             typeof openDepartureBoardView !== 'undefined',
    'claims-ui.js':            typeof openDelayClaimsManager !== 'undefined',
    'performance.js':          typeof openPerformanceHistoryView !== 'undefined',
    'buy.js':                  typeof openBuyScreen !== 'undefined',
    'roi.js':                  typeof openROIDashboardView !== 'undefined',
    'help.js':                 typeof openHelpGuide !== 'undefined',
    'backlog.js':              typeof openBacklogView !== 'undefined',
    'easter-eggs.js':          typeof runSeasonalEasterEgg !== 'undefined',
  };
  const missing = Object.keys(loaded).filter((f) => !loaded[f]);
  if (!missing.length) return;
  const app = document.getElementById('app');
  if (app){
    app.innerHTML = '<div style="padding:24px;line-height:1.5;">Update didn\'t finish loading — check your signal and reopen the app.'
      + '<div style="opacity:.6;font-size:12px;margin-top:8px;">Missing: ' + missing.join(', ') + '</div></div>';
  }
  throw new Error('Ticket tracker: files failed to load: ' + missing.join(', '));
})();

(async function init(){
  await loadData();
  render();
  // 2026-09-18 — keep the Worker's picture of upcoming non-commute days
  // (and everything else the watch alerts depend on) fresh on every app
  // open. Debounced, and a no-op server-side if nothing changed.
  schedulePushWatchConfig();
  runSeasonalEasterEgg();
  mountSilentConfirmBanner();
  mountCatchupBanner();
  mountBackupNudge();
  setInterval(renderBackupNudge, 5 * 60 * 1000); // stale-ness is time-based, so re-check while the app stays open
  // 2026-10-02 — reuse a still-valid Google token from before a reload.
  // 2026-10-04 — topped up from the Worker (automatic sign-in) rather than
  // the retired prompt:'none' quiet refresh, so a backup on leaving the app
  // has a token to use without any popup.
  loadGoogleTokenCache();
  maybeRefreshGoogleTokenFromWorker();
  setInterval(maybeRefreshGoogleTokenFromWorker, 5 * 60 * 1000); // only acts within the last 15 min of a token's life

  // Pick up anything the watch already resolved via a station-ping
  // (overnight, or on the walk in with the phone away) BEFORE the live
  // checks start — so if today's direction is already settled,
  // checkLikelyTrain/checkLikelyArrival see confirmedTrains already set
  // on their first guard check and never attempt their own resolution.
  // 2026-09-01 — see wearos-companion-session-2026-09-01.md.
  await checkPendingConfirmation();

  // Check for bank holidays after the initial render so startup isn't
  // delayed by a network call. Re-render only if new dates were filled in.
  syncBankHolidays().then((changed) => { if (changed) render(); })
    .finally(scheduleTransportPublish); // 2026-10-06 — after the sync, since bank holidays feed the estimate
  railSyncMissingDates();
  ensureReasonCodes();

  // Backgrounding (switching away, locking the phone, or closing) is a
  // far more reliable signal on mobile than "unload" events, which the OS
  // can skip entirely when killing an app's process. This is the one
  // moment a Drive backup gets attempted — see attemptDriveBackup() for
  // the dirty-flag and throttle checks that decide whether it actually does anything.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden'){
      attemptDriveBackup();
      flushTransportPublish(); // 2026-10-06 — Personal Finance estimates; no network call if nothing changed
      flushWatchConfigPush(); // 2026-09-18 — don't leave a debounced push stranded in a frozen timer
      stopLikelyTrainChecks(); // no point polling while backgrounded — nothing can act on it anyway
      stopJourneyTextRefresh(); // 2026-09-27 — restarted fresh on return, below
    } else {
      // 2026-09-30: state.today was only ever set at load, so an app left
      // in memory overnight kept yesterday's date — yesterday's delay never
      // became a "past" day, and no HSP sync ran for it. Roll the date on
      // when the calendar day has changed, then look for fresh delay data
      // (cheap when nothing's outstanding — railSyncMissingDates skips
      // already-synced days, and only re-asks recent ones still empty).
      const nowDate = new Date();
      if (fmtKey(nowDate) !== fmtKey(state.today)) state.today = nowDate;
      railSyncMissingDates();
      renderBackupNudge(); // may have gone stale while backgrounded
      maybeRefreshGoogleTokenFromWorker(); // 2026-10-04 — so the next backup on leaving has a token (replaces the 2026-10-02 quiet refresh)
      schedulePushWatchConfig(); // 2026-09-18 — foreground counts as "app open" for keeping the rolling non-travel window fresh
      scheduleTransportPublish(); // 2026-10-06 — e.g. a new payday since the app was last in front
      // Same ordering as startup — the watch may have resolved
      // something while the phone was locked/backgrounded.
      checkPendingConfirmation().finally(startLikelyTrainChecks);
      refreshJourneyText(); // 2026-09-27 — Copy for WhatsApp text: rebuild immediately, the ETA may have moved while away
      // Re-render so the holiday countdown's hour-of-day cutoff (see
      // holiday-countdown-time-aware-spec.md) reflects the current clock
      // time rather than whatever it was when the app was last opened.
      render();
    }
  });
  startLikelyTrainChecks();
})();

if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support just won't be available; app still works online */
    });
  });
}
