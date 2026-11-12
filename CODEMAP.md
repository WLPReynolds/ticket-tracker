# CODEMAP — ticket tracker PWA

**Read this first.** It says which file owns what, so you only need to open one to three files for most jobs.
Function names only, no line numbers (they drift). Update this file in the same commit as any change that adds, removes or moves a function.
The repo is public: structure only, never secrets.

## How the app is put together

- `index.html` — just the `<head>`, the `#app` div, two `<link>`s (`design.css`, `app.css`) and the `<script>` tags. No code.
- `css/design.css` — design tokens (type scale, radii, spacing) and the shared `ui-` parts (card, row, switch, button, figure, pill, page frame…). Loaded before `app.css`. **Read `STYLEGUIDE.md` before writing any new styling.**
- `css/app.css` — every other style (one file, ~32 KB), including the colour palette in `:root`.
- `js/*.js` — 31 plain script files (not ES modules), loaded in the order below. They share one global scope, exactly as the old single `<script>` block did, so any function can call any other.
- `sw.js` — service worker. Network-first, cache as offline fallback, one cache per version.
- `tools/stamp-version.sh`, `tools/check.sh` — the release routine (below).
- Unchanged: `manifest.json`, `privacy.html`, `icons/`, `CNAME`.

## The load-order rule

Functions can live in any file — nothing calls them until `init.js` runs, by which time every file has loaded.
But **top-level statements run as each file loads**, so anything a top-level line uses must come from an earlier file (or earlier in the same file). In practice:

- `let`/`const` initialisers that use constants (e.g. `let periodStart = DEFAULT_PERIOD_START`) → constants live in `config.js`, which loads before `state.js`.
- `installDriveBackupDirtyTracker` runs immediately inside `state.js` and wraps `localStorage.setItem`, so it must stay ahead of anything that saves.
- A `const` kept beside its functions in a later file (e.g. `settingsReturnScroll` in `settings.js`) may only use things from earlier files.
- `init.js` is always last.

Since the split, a syntax error stops only its own file, not the whole app — the app could start half-working. That's why `tools/check.sh` runs `node --check` on everything, and `init.js` starts with a load guard that shows "Update didn't finish loading" if any earlier file is missing.

## Files, in load order

**Foundations**
1. `config.js` — `APP_VERSION`, Google client ID, Worker URLs, nav icons, every `DEFAULT_*` constant and tunable, `BACKUP_KEYS`. Declarations only.
2. `state.js` — the shared mutable state (top-level `let`s, including `state`), `loadJSON`, `loadData`, every `save…()` function, the Drive-backup dirty tracker.
3. `util.js` — date keys (`fmtKey`, `parseKey`, `addDays`…), London time helpers (`londonParts`, `londonDateKey`…), `escapeHtml`, clamps, `distanceKm`, `showToast`, `closeAllModals`, `openExternalLink`, `showLocalNotification`.
   - `ui-parts.js` (loads straight after `util.js`) — shared screen parts, declarations only: `uiPageBar`, `uiGroup`, `uiRow`, `uiSwitchRow`, `uiSetSwitch`, `uiOpenSheet` (bottom sheet), `uiCheck` (checkbox row), `UI_ICON_BACK`, `UI_ICON_CHEV`, `UI_ICON_CLOSE`. See `STYLEGUIDE.md`.

**Logic (no screens)**
4. `tickets.js` — `computeStates`, ticket periods, `findNextBuyDateKey`, holiday countdown, pay periods and payday estimates (`estimateForPeriod`), parking savings, `syncBankHolidays`.
5. `delay-repay.js` — bands and amounts, claim state, `getDelayStatus`, `delayRepayOpportunities`, HSP sync (`railSyncMissingDates`…), reason codes.
6. `darwin.js` — `fetchLiveBoards`, `queryDarwin`, `fetchServiceDetails`, calling-point helpers, Staff board fetch and extraction.
7. `stations.js` — station list and index, `stationNameForCrs`, `createStationPicker`.
8. `google.js` — Google sign-in, Worker-held token, Drive backup (`attemptDriveBackup`), backup nudge, Calendar sync, `fireBuyDateChangeActions`.
9. `transport-estimates.js` — the Personal Finance shared estimates file (`scheduleTransportPublish`, `flushTransportPublish`).
10. `watch-sync.js` — `buildWatchConfigBody`, `pushWatchConfig`, `schedulePushWatchConfig`, `checkPendingConfirmation`, target trains, non-travel dates, geofence radii, drive-check payload.
11. `confirm-train.js` — `checkLikelyTrain`, `checkLikelyArrival`, the check timer, `openConfirmTrain`.
12. `journey-share.js` — Copy for WhatsApp, silent-confirm banner, catch-up banner.
13. `emergency-routes.js` — `checkEmergencyRoute`, `checkAllEmergencyRoutes`, `openAlternativeRoutesManager`.

**Screens**
14. `home-sections.js` — Home's building blocks (declarations only): the day strip and day panel (`homeDayInfo`, `homeBuildStrip`, `homeBuildDayPanel`), holiday line and countdown card, Your trains card (`homeJourney` picks the trains, `homeHasDeparted`, `homeTrainsInnerHtml`, `homeEnsureBoards`), money row and `openMoneyDetails`.
15. `screen-home.js` — `render()`: the Home tab and bottom nav, assembled from the `home-sections.js` parts.
15a. `screen-calendar.js` — `openDayEditor`, `openCalendarView` (the Month page).
16. `screen-live.js` — `openLiveScreen`: the Live tab.
17. `train-status.js` — `describePointStatus`, Staff overrides and time columns, journey-state notifications, formation display.
18. `train-progress-build.js` — `buildTrainProgress`.
19. `train-progress.js` — `openTrainProgress`, weather.
20. `settings.js` — `openSettingsMenu` (the grid), `openCostsMenu` (the combined Costs form: parking cost and day return price), polling, geofence, write secret, drive check, preferred Google account.
21. `settings-trains.js` — `openRailConfig`, `openHomeWorkStationsManager`.
22. `backup-restore.js` — `exportBackup`, `openBackupRestore`, history imports.
23. `depboard.js` — the split-flap station board.
24. `claims-ui.js` — claim rows and handlers, `openDelayClaimsManager`, cancelled-band picker, claim downloads, pass photo (IndexedDB) and `openPassPhotoManager`.
25. `performance.js` — performance history and statistics, `openRailDetail`.
26. `buy.js` — `openBuyScreen`, `openManagePurchases`, fares check.
27. `roi.js` — `openROIDashboardView`, What-if.

**Content and start-up**
28. `help.js` — `HELP_GUIDE_MD`, `renderHelpMarkdown`, `openHelpGuide`.
29. `backlog.js` — `BACKLOG_MD` and `openBacklogView`. Edited every release.
30. `easter-eggs.js` — seasonal effects (kept out of the in-app backlog on purpose).
31. `init.js` — load guard, the `init()` block, service worker registration. **Always last.**

## Where data is stored

- Almost every `localStorage` key is read in `loadData` and written by its `save…()` function, both in `state.js`. `BACKUP_KEYS` (`config.js`) lists the keys that go into a backup; only those mark a Drive backup as needed.
- Kept elsewhere, device-only (not backed up):
  - `google.js` — `google-token-cache`, `google-worker-status`, `drive-backup-dirty`, `drive-backup-last-time`, `google-silent-refresh-log`
  - `transport-estimates.js` — `transport-estimates-file-id`, `-published`, `-last-shared`, `-last-error` (the setting `transport-estimates-enabled` is backed up)
  - `train-status.js` — `confirmed-point-status-cache`, `last-seen-journey-state`, `last-seen-staff-match`
  - `screen-live.js` — `drive-banner-dismissed`, `live-target-strip-open`
  - `tickets.js` / `screen-home.js` — `bank-holidays-cache`
  - `stations.js` — `station-list-v2`
  - `journey-share.js` — `journey-text-copied`
- The pass photo is in IndexedDB, not `localStorage` (`claims-ui.js`).

## To change X, open Y

- **New setting:** default in `config.js`; `let` + load in `loadData` + `save…()` in `state.js`; add the key to `BACKUP_KEYS` if it should be backed up; row in `openSettingsMenu` (`settings.js`, built with `uiRow` / `uiSwitchRow` from `ui-parts.js`) and its sub-page using `uiPageBar`. Then ask: does the watch need it? (`buildWatchConfigBody` in `watch-sync.js`.) And update Help (`help.js`).
- **New backup key:** `BACKUP_KEYS` in `config.js`. Restore works from that list (`backup-restore.js`).
- **New watch-config field:** `buildWatchConfigBody` in `watch-sync.js`, plus the Worker's validation in the `ticket-tracker-workers` repo.
- **Help text:** `HELP_GUIDE_MD` in `help.js`.
- **Backlog:** `BACKLOG_MD` in `backlog.js` — bump its "Last updated" line.
- **Version / release:** see below. Never edit `APP_VERSION` by hand.
- **New JS file:** add its `<script>` tag before `init.js` in `index.html`, add it to `ASSETS` in `sw.js`, add a line to the load guard at the top of `init.js`, add it here. `tools/check.sh` fails until all four are done (except this file).

## Release routine

1. `tools/stamp-version.sh v2026-11-10.07:30` — real time, `vYYYY-MM-DD.HH:MM`. Sets `APP_VERSION` in `js/config.js`, every `?v=` in `index.html`, and `VERSION` in `sw.js`.
2. `tools/check.sh` — syntax, wiring and version agreement. Must print `OK`.
3. Commit, push, merge. After deploy, confirm the new version shows on the phone.

Each version gets its own service-worker cache and every CSS/JS URL carries `?v=`, so a new `index.html` can never run with an old cached script.

## Function index

- **config.js** (18 KB) — _(declarations only)_
- **state.js** (39 KB) — `saveDelayClaims`, `loadJSON`, `loadData`, `saveComments`, `saveTravelOverrides`, `ensurePurchaseFields`, `savePurchases`, `saveLastKnownPrice`, `saveParkingCost`, `saveSmartcardNumber`, `saveProduceClaimDetailsFile`, `savePaydayEstimateSnapshots`, `saveParkedDays`, `saveDismissedParkingSavingsPeriods`, `saveParkingSavingsSnapshots`, `saveParkingBudgetDays`, `saveTicketsSpentCardDismissed`, `savePollingSettings`, `saveGeofenceSettings`, `savePwaWriteSecret`, `saveDayReturnPrice`, `saveFareCheckedYear`, `saveDismissedMonths`, `saveGcalEnabled`, `savePreferredGoogleEmail`, `saveDebugMode`, `saveWeatherEnabled`, `saveAlternativeRoutes`, `saveEmergencyTabVisible`, `saveHomeStation`, `saveWorkStation`, `saveDriveBackupEnabled`, `saveDriveBackupFolderId`, `saveGcalEventId`, `saveGcalPendingSync`, `saveLastNotifiedBuyKey`, `saveRailTrains`, `saveTrainAlertConfig`, `saveTargetTrains`, `saveDriveCheckSettings`, `saveRailPerfCache`, `saveRailSyncedDays`, `saveRailHistoryDaysBack`, `saveReasonCodesCache`, `saveConfirmedTrains`, `saveSilentConfirmBanner`, `saveTrackedTrains`, `savePeriodStart`
- **util.js** (15 KB) — `checkCircleIcon`, `fmtKey`, `parseKey`, `isWeekend`, `addDays`, `getFirstSundayOfMarch`, `dayNameShort`, `dateLabel`, `dateLabelShort`, `clampPollBeforeDepartureMin`, `clampPollCheckInIntervalMin`, `distanceKm`, `openExternalLink`, `clampGeofenceRadius`, `showLocalNotification`, `closeAllModals`, `escapeHtml`, `minutesUntilLocalTime`, `getCurrentPositionOnce`, `londonOffsetMinutes`, `londonParts`, `londonDateKey`, `londonWallClockOn`, `liveTimeToDate`, `closestDateForTime`, `nextDateForTime`, `showToast`
- **ui-parts.js** — `uiPageBar`, `uiGroup`, `uiRow`, `uiSwitchRow`, `uiSetSwitch`, `uiOpenSheet`, `uiCheck`
- **tickets.js** (24 KB) — `syncBankHolidays`, `findNextTravelDay`, `getPayDate`, `getPayPeriodByOffset`, `estimateForPeriod`, `computeExpenseSavingsForPeriod`, `getOrLockParkingBudgetDays`, `computeParkingSavingsForPeriod`, `findNextBuyDateKey`, `getRealPeriodEnd`, `isCurrentlyInTicketGap`, `getSingleTicketForDate`, `computeStates`, `findHistoricalStateForDate`, `getRange`, `findNextHoliday`, `countWorkingDaysUntil`, `holidayWorkingDaysCount`, `hoursUntilHomeTime`, `findLastWorkingDayBefore`, `findHolidayBlockEnd`, `findNextWorkingDayAfter`, `getHolidayCountdownState`, `isBuyTicketDay`
- **delay-repay.js** (21 KB) — `delayRepayBandLabel`, `isClaimBeingMade`, `claimBandMinutes`, `delayRepayBandPercent`, `getSeasonPriceForDate`, `computeDelayRepayAmount`, `delayRepayDayCapAmount`, `delayRepayOtherDirAmount`, `cappedDelayRepayAmount`, `isEligibleRailDay`, `perfIsCancelled`, `perfBreachesThreshold`, `getDelayStatus`, `delayRepayDaysSince`, `delayRepayOpportunities`, `isDirectionClaimable`, `delayRepayUnconfirmedDirections`, `railSyncDatesBatch`, `railSyncMissingDates`, `railSyncFullHistory`, `ensureReasonCodes`, `describeReasonCode`
- **darwin.js** (16 KB) — `fetchLiveBoards`, `queryDarwin`, `fetchPureBoard`, `fetchDebugBoard`, `fetchServiceDetails`, `findCallingPointRaw`, `resolveCallingPointClockTime`, `fetchStationBoardForService`, `buildStaffTargetTime`, `fetchStaffBoardComparison`, `extractStaffLocationFields`
- **stations.js** (11 KB) — `getCachedStationList`, `parseCsvLine`, `parseStationCsv`, `buildStationIndex`, `loadStationIndex`, `stationNameForCrs`, `stationCoordsForCrs`, `createStationPicker`
- **google.js** (30 KB) — `ensureGoogleTokenClient`, `getGoogleAccessToken`, `requestGoogleTokenViaPopup`, `saveGoogleTokenCache`, `loadGoogleTokenCache`, `clearGoogleTokenCache`, `googleWorkerState`, `setGoogleWorkerState`, `fetchWithTimeout`, `acceptWorkerGoogleToken`, `fetchGoogleTokenFromWorker`, `maybeRefreshGoogleTokenFromWorker`, `connectGoogleViaWorker`, `disconnectGoogleViaWorker`, `googleWorkerStatusText`, `ensureDriveBackupFolder`, `buildBackupPayload`, `uploadBackupToDrive`, `pruneOldDriveBackups`, `attemptDriveBackup`, `driveBackupReasonText`, `backupNudgeShouldShow`, `mountBackupNudge`, `runBackupNudge`, `renderBackupNudge`, `syncGoogleCalendarEvent`, `deleteGoogleCalendarEvent`, `fireBuyDateChangeActions`
- **transport-estimates.js** (14 KB) — `saveTransportShareEnabled`, `transportEstimatesToday`, `buildTransportEstimatesBody`, `seasonTicketEndKey`, `buildTransportTickets`, `buildTransportEstimatesFile`, `findTransportEstimatesFileId`, `uploadTransportEstimates`, `attemptTransportPublish`, `scheduleTransportPublish`, `flushTransportPublish`, `transportShareStatusText`
- **watch-sync.js** (16 KB) — `isValidLatLng`, `fetchDriveCheckNow`, `driveCheckIsSetUp`, `parseLatLng`, `fmtLatLng`, `buildDriveCheckPayload`, `defaultTrainAlertConfigFor`, `defaultTargetTrainsFor`, `pruneTargetTrainOverrides`, `nonTravelLabelFor`, `computeNonTravelDates`, `geofenceRadiusForCrs`, `buildWatchConfigBody`, `pushWatchConfig`, `schedulePushWatchConfig`, `flushWatchConfigPush`, `pushConfirmedTrain`, `pushManualConfirmedTrain`, `checkPendingConfirmation`
- **confirm-train.js** (22 KB) — `checkLikelyTrain`, `checkLikelyArrival`, `computeLikelyTrainCheckDelay`, `runLikelyTrainCycle`, `startLikelyTrainChecks`, `stopLikelyTrainChecks`, `openConfirmTrain`
- **journey-share.js** (19 KB) — `mountSilentConfirmBanner`, `renderSilentConfirmBanner`, `journeyTodayKey`, `getJourneyCopyState`, `getJourneyCopyStatus`, `setJourneyCopyStatus`, `isJourneyCopyDone`, `journeyIsClockTime`, `journeyClockMinutes`, `journeyMinutesToClock`, `findJourneyArrivalService`, `journeyPointDelay`, `journeyCarriedDelay`, `buildJourneyShareText`, `fetchJourneyArrivals`, `buildJourneyTextsForAllPm`, `bannerJourneyTarget`, `suggestionJourneyTarget`, `currentJourneyTextTarget`, `stopJourneyTextRefresh`, `noteJourneyTextTarget`, `refreshJourneyText`, `maybeCopyJourneyText`, `copyJourneyText`, `mountCatchupBanner`, `renderCatchupBanner`
- **emergency-routes.js** (18 KB) — `checkEmergencyRoute`, `checkAllEmergencyRoutes`, `openAlternativeRoutesManager`
- **home-sections.js** — `homeDayCtx`, `homeDayInfo`, `homeBuildStrip`, `homeShiftWeek`, `homeBuildDayPanel`, `homeWireDayPanel`, `homeHolidayLineHtml`, `homeCountdownCardHtml`, `homeTrainsInnerHtml`, `homeWireTrains`, `homeEnsureBoards`, `homeMoneyRowHtml`, `openMoneyDetails`
- **screen-home.js** — `render`
- **screen-calendar.js** — `openDayEditor`, `openCalendarView`
- **screen-live.js** (57 KB) — `openLiveScreen`
- **train-status.js** (38 KB) — `describePointStatus`, `pruneConfirmedPointStatusCache`, `saveConfirmedPointStatusCache`, `pruneLastSeenJourneyState`, `saveLastSeenJourneyState`, `pruneLastSeenStaffMatch`, `saveLastSeenStaffMatch`, `isClockTimeEarlier`, `isoTimeToHHMM`, `staffMinutesDiff`, `buildStaffTimeColumnsHtml`, `shiftClockTime`, `staffPlatformStatusFor`, `staffConfirmsArrival`, `journeyNotifyBody`, `diffAndNotifyJourneyState`, `findCallingPointSchedTime`, `findServiceOriginPoint`, `describePointStatusRemembered`, `addMinutesToTime`, `getLengthOnlyFormationLetters`, `buildNoseSvg`, `shouldReverseFallbackLetters`, `buildFormationHtml`, `buildFormationDebugHtml`
- **train-progress-build.js** (60 KB) — `buildTrainProgress`
- **train-progress.js** (74 KB) — `weatherIconForCode`, `localWallClockString`, `hourKeyFor`, `fetchWeatherForPoints`, `openTrainProgress`
- **settings.js** (44 KB) — `openSettingsMenu`, `openCostsMenu`, `openPollingSettingsEditor`, `openPwaWriteSecretEditor`, `openDriveCheckEditor`, `renderDriveCheckResult`, `openGeofenceSettingsEditor`, `openPreferredGoogleEditor`
- **settings-trains.js** (12 KB) — `openRailConfig`, `openHomeWorkStationsManager`
- **backup-restore.js** (18 KB) — `exportBackup`, `openBackupRestore`, `openImportHistory`, `openDelayClaimsImport`
- **depboard.js** (12 KB) — `depBoardRowData`, `openDepartureBoardView`
- **claims-ui.js** (33 KB) — `openPassPhotoDB`, `savePassPhoto`, `getPassPhoto`, `deletePassPhoto`, `copySmartcardToClipboard`, `showClaimBandNotification`, `triggerClaimDetailsDownload`, `triggerAllClaimDownloads`, `triggerPassPhotoDownload`, `railDetailRows`, `railPerfStatusText`, `railDetailRowsForClaim`, `notClaimingButtonHtml`, `wireClaimHandlers`, `startDelayClaimForDate`, `openCancelledBandPicker`, `openDelayClaimsManager`, `openPassPhotoManager`
- **performance.js** (20 KB) — `openRailDetail`, `renderPerfHistoryInto`, `openPerformanceHistoryView`, `openPerformanceStatsView`
- **buy.js** (17 KB) — `shouldFetchFreshFares`, `openManagePurchases`, `fetchFaresUpdate`, `openBuyScreen`
- **roi.js** (16 KB) — `openROIDashboardView`, `renderROIWhatIf`, `projectOfficePattern`, `estimateTravelDaysInWindow`
- **help.js** (25 KB) — `renderHelpMarkdown`, `buildHelpGuideMd`, `openHelpGuide`
- **backlog.js** (10 KB) — `openBacklogView`
- **easter-eggs.js** (6 KB) — `runSeasonalEasterEgg`, `spawnHalloweenGhost`, `spawnBonfireFireworks`, `spawnFireworkBurst`
- **init.js** (8 KB) — _(declarations only)_
