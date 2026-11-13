// confirm-train.js — Likely-train and likely-arrival checks, openConfirmTrain.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// The core check: are you plausibly at the station right now, and is an
// earlier (delayed) configured train about to leave in place of your
// nominally-expected one? Deliberately conservative — only fires when
// there's a genuine, geofenced, time-window-matched mismatch, not on
// every open.
async function checkLikelyTrain(){
  if (!railTrains || railTrains.length === 0) return;
  const now = new Date();
  const nowLondonParts = londonParts(now);
  const todayKeyLocal = londonDateKey(now);
  const nowMinutes = nowLondonParts.hour * 60 + nowLondonParts.minute;

  for (const direction of ['AM', 'PM']){
    const dirTrains = railTrains.filter(t => t.direction === direction).sort((a,b) => a.time.localeCompare(b.time));
    if (dirTrains.length === 0) continue;

    // Skip entirely if we're nowhere near any configured time for this
    // direction — avoids pointless API calls and geolocation prompts
    // outside commute hours.
    const inWindow = dirTrains.some(t => {
      const tMin = parseInt(t.time.slice(0,2),10)*60 + parseInt(t.time.slice(2,4),10);
      return Math.abs(nowMinutes - tMin) <= LIKELY_TRAIN_TIME_WINDOW_MIN;
    });
    if (!inWindow) continue;

    // Already confirmed for this direction today — nothing to detect.
    if (confirmedTrains[todayKeyLocal] && confirmedTrains[todayKeyLocal][direction] !== undefined) continue;

    const fromLoc = dirTrains[0].fromLoc;
    const stationCoord = STATION_COORDS[fromLoc];
    if (!stationCoord) continue;

    const pos = await getCurrentPositionOnce();
    if (!pos) continue; // no permission or unavailable — skip silently
    const distM = distanceKm(pos.latitude, pos.longitude, stationCoord.lat, stationCoord.lon) * 1000;
    if (distM > geofenceRadiusForCrs(fromLoc)) continue; // not plausibly at the station

    let boards;
    try{ boards = await fetchLiveBoards(); }catch(e){ continue; }
    const board = boards[`${dirTrains[0].fromLoc}-${dirTrains[0].toLoc}`] || [];

    // Which configured train is nominally "current" if everything ran on
    // schedule — the earliest one whose scheduled time hasn't yet passed
    // by more than a few minutes.
    const nominal = dirTrains.find(t => {
      const tMin = parseInt(t.time.slice(0,2),10)*60 + parseInt(t.time.slice(2,4),10);
      return tMin >= nowMinutes - 5;
    }) || dirTrains[dirTrains.length - 1];

    // Which configured train's live departure is actually closest to
    // happening right now — the one you're plausibly boarding.
    let closest = null, closestDiff = Infinity;
    dirTrains.forEach(t => {
      const wanted = `${t.time.slice(0,2)}:${t.time.slice(2,4)}`;
      const service = board.find(s => s.std === wanted);
      if (!service) return;
      const liveTime = liveTimeToDate(
        (service.etd && service.etd !== 'On time') ? service.etd.replace(':','') : t.time,
        now
      );
      if (!liveTime) return;
      const diffMin = Math.abs((liveTime - now) / 60000);
      if (diffMin <= 15 && diffMin < closestDiff){
        closest = t; closestDiff = diffMin;
      }
    });

    if (closest && closest.key !== nominal.key){
      // A genuine surprise — you appear to be catching a different train
      // than expected. This needs your confirmation, since it's a real
      // ambiguity we can't resolve on our own.
      const suggestionId = `${todayKeyLocal}-${direction}-${closest.key}`;
      if (dismissedLikelyTrainKeys.has(suggestionId)) continue;
      likelyTrainSuggestion = { dateKey: todayKeyLocal, direction, trainKey: closest.key, label: closest.label };
      noteJourneyTextTarget(); // 2026-09-27: start building the Copy for WhatsApp text now, ahead of the Yes tap
      if (!notifiedLikelyTrainKeys.has(suggestionId)){
        notifiedLikelyTrainKeys.add(suggestionId);
        showLocalNotification('Is this your train?', `Looks like you might be on the delayed ${closest.label} instead of your usual one — open the app to confirm.`, suggestionId);
      }
      render();
      return; // one interactive suggestion at a time is plenty
    } else if (closest && closest.key === nominal.key && closestDiff <= SILENT_CONFIRM_MAX_DIFF_MIN){
      // No surprise — you're at the station, and the train that's actually
      // about to leave is the one you'd expect anyway. Nothing ambiguous
      // to ask about, so just quietly confirm it. Only once its own live
      // departure is genuinely imminent, though — being merely "in range"
      // isn't enough to commit a silent, un-askable write for the rest of
      // the day; it previously used the same loose 15-minute threshold as
      // candidate selection above, which let an early false match lock in
      // hours before you'd actually left for the station.
      if (!confirmedTrains[todayKeyLocal]) confirmedTrains[todayKeyLocal] = {};
      confirmedTrains[todayKeyLocal][direction] = closest.key;
      saveConfirmedTrains();
      // A passive notice that this just happened — otherwise the silent
      // path lives up to its name a little too well, and the only way to
      // know it fired at all is to go check "Confirm train used" and
      // look for yourself. source:'phone' vs 'watch' (see
      // checkPendingConfirmation) is a temporary visibility aid while
      // the watch-detection path is being shaken out — fine to drop
      // once it's proven reliable.
      silentConfirmBanner = { dateKey: todayKeyLocal, direction, trainKey: closest.key, label: closest.label, source: 'phone' };
      saveSilentConfirmBanner();
      renderSilentConfirmBanner();
      pushConfirmedTrain(todayKeyLocal, direction, closest.key, closest.label);
      render();
    }
  }
}

// Arrival-side fallback for checkLikelyTrain above — only ever gets a
// chance to run at all once departure-side detection has already had
// its shot and missed for that direction (same "already confirmed?"
// guard as the departure side, reused directly). Geofences the
// destination (toLoc) instead of the origin, and uses the arrivals
// board only to answer "has a train genuinely arrived here around now"
// — not "which one, specifically". Identity comes from the same
// schedule-based "nominal" reasoning already trusted on the departure
// side: with only one plausible configured train per direction inside
// a 20-minute window, and you genuinely standing at the right station,
// there's little real ambiguity left to resolve — unlike the departure
// side, which actively has to watch for a *different* train being
// caught instead of the expected one. Honest limitation: if another,
// unrelated service happened to arrive at the same station within the
// same few minutes, this could plausibly latch onto that instead —
// low-probability given the geofence and time-window already narrow
// things down heavily, but worth knowing rather than pretending this
// is as precisely matched as the departure side's own logic.
async function checkLikelyArrival(){
  if (!railTrains || railTrains.length === 0) return;
  const now = new Date();
  const nowLondonParts = londonParts(now);
  const todayKeyLocal = londonDateKey(now);
  const nowMinutes = nowLondonParts.hour * 60 + nowLondonParts.minute;

  for (const direction of ['AM', 'PM']){
    const dirTrains = railTrains.filter(t => t.direction === direction).sort((a,b) => a.time.localeCompare(b.time));
    if (dirTrains.length === 0) continue;

    if (confirmedTrains[todayKeyLocal] && confirmedTrains[todayKeyLocal][direction] !== undefined) continue;

    // Forward-only window from each departure time, not the departure
    // side's own symmetric ±20 minutes — that check made sense for
    // "am I roughly near my departure time", but by the time you've
    // genuinely arrived at the destination, a real journey (Wigan→Crewe
    // is ~29 minutes) already puts you well outside a 20-minute window
    // centred on departure. Confirmed this would have made the whole
    // function silently never fire on a real journey before catching it.
    // 90 minutes (2026-11-06, was 50) covers a normal journey plus a
    // heavy delay. 50 was chosen to stay under the hourly train spacing,
    // but this is only a pre-filter: which train it was comes from the
    // arriving service's scheduled time at our origin (within 2 minutes)
    // below, so overlapping windows can't mix trains up. 50 meant a train
    // more than ~20 minutes late was never confirmed here — and since
    // 5 Nov the Worker deliberately leaves a "Delayed" train unconfirmed
    // at departure, so this arrival check has to cover it.
    const inWindow = dirTrains.some(t => {
      const tMin = parseInt(t.time.slice(0,2),10)*60 + parseInt(t.time.slice(2,4),10);
      return nowMinutes >= tMin && nowMinutes <= tMin + LIKELY_ARRIVAL_WINDOW_FORWARD_MIN;
    });
    if (!inWindow) continue;

    const toLoc = dirTrains[0].toLoc;
    const fromLoc = dirTrains[0].fromLoc;
    const stationCoord = STATION_COORDS[toLoc];
    if (!stationCoord) continue;

    const pos = await getCurrentPositionOnce();
    if (!pos) continue;
    const distM = distanceKm(pos.latitude, pos.longitude, stationCoord.lat, stationCoord.lon) * 1000;
    if (distM > geofenceRadiusForCrs(toLoc)) continue;

    let arrivals;
    try{ arrivals = await fetchPureBoard(toLoc, 'arr', 20); }catch(e){ continue; }

    // Identity now comes from genuinely verified data, not a schedule
    // guess — GetArrBoardWithDetails (what fetchPureBoard already calls
    // for 'arr') includes each service's previousCallingPoints, so this
    // checks whether the arriving service actually called at our origin
    // station at all, and if so, which configured train its real
    // departure time from there actually matches. Checked via calling
    // points rather than the service's own top-level origin field,
    // since many of these services are part of a much longer working
    // (e.g. continuing from Glasgow through Wigan to Crewe and beyond)
    // — the true physical origin often isn't Wigan/Crewe at all, even
    // though it's a real calling point along the way. This is what
    // actually answers "is this genuinely my train", rather than just
    // "did something arrive around the right time" — a real, different
    // train arriving at a similar moment is now correctly ruled out
    // rather than risked.
    let closestDiff = Infinity;
    let matchedTrain = null;
    arrivals.forEach(s => {
      const liveTime = liveTimeToDate(
        (s.eta && s.eta !== 'On time') ? s.eta.replace(':','') : (s.sta || '').replace(':',''),
        now
      );
      if (!liveTime) return;
      const diffMin = Math.abs((liveTime - now) / 60000);
      if (diffMin > SILENT_CONFIRM_MAX_DIFF_MIN) return; // not close enough to be worth checking further

      const prevPoints = (s.previousCallingPoints && s.previousCallingPoints[0] && s.previousCallingPoints[0].callingPoint) || [];
      const calledAtOrigin = prevPoints.find(cp => cp.crs === fromLoc);
      if (!calledAtOrigin) return; // never called at our origin at all — definitely not this journey

      // Matched against the SCHEDULED departure from our origin, not the
      // live one — schedule is the stable, fixed reference that both
      // this calling point and each configured train's own `time`
      // ultimately share, while live time is precisely what drifts with
      // delay. Using live time here was a real bug: a severely delayed
      // earlier train (e.g. the 16:31 running ~64 minutes late,
      // genuinely departing Wigan around 17:35) would end up closer in
      // raw value to the *next* configured train's scheduled slot than
      // to its own, and get silently misidentified as that later train
      // instead — confirmed reproducing exactly that before fixing it.
      const rawTime = calledAtOrigin.st;
      if (!rawTime || !rawTime.includes(':')) return;
      const originDepMin = parseInt(rawTime.slice(0,2),10)*60 + parseInt(rawTime.slice(3,5),10);

      // Which configured train does the scheduled departure from our
      // origin actually match? Tight bound now (schedule-to-schedule
      // should be an exact or near-exact match for a genuine configured
      // train) — the old 15-minute allowance made sense for the
      // delay-sensitive live-time comparison this replaces, not for a
      // comparison that shouldn't drift at all.
      let best = null;
      dirTrains.forEach(t => {
        const tMin = parseInt(t.time.slice(0,2),10)*60 + parseInt(t.time.slice(2,4),10);
        const diff = Math.abs(tMin - originDepMin);
        if (!best || diff < best.diff) best = { train: t, diff };
      });
      if (!best || best.diff > 2) return;

      if (diffMin < closestDiff){ closestDiff = diffMin; matchedTrain = best.train; }
    });

    if (matchedTrain && closestDiff <= SILENT_CONFIRM_MAX_DIFF_MIN){
      if (!confirmedTrains[todayKeyLocal]) confirmedTrains[todayKeyLocal] = {};
      confirmedTrains[todayKeyLocal][direction] = matchedTrain.key;
      saveConfirmedTrains();
      silentConfirmBanner = { dateKey: todayKeyLocal, direction, trainKey: matchedTrain.key, label: matchedTrain.label, source: 'phone' };
      saveSilentConfirmBanner();
      renderSilentConfirmBanner();
      pushConfirmedTrain(todayKeyLocal, direction, matchedTrain.key, matchedTrain.label);
      render();
    }
  }
}

// Decides how soon the next cycle should run. The normal 2-minute cadence
// is fine most of the time, but right around a configured departure — the
// exact stretch where SILENT_CONFIRM_MAX_DIFF_MIN-based silent confirmation
// can actually fire — a 2-minute gap can eat most of the 5-minute confirm
// window before the next check even happens. Tightens to 30s just for that
// stretch instead of for the whole 20/50-minute check window, to avoid the
// extra geolocation/board-fetch cost the rest of the time. Only considers
// directions not already confirmed today, same as the checks themselves —
// no point polling fast for a direction there's nothing left to detect.
function computeLikelyTrainCheckDelay(){
  if (!railTrains || railTrains.length === 0) return LIKELY_TRAIN_CHECK_INTERVAL_MS;
  const now = new Date();
  const todayKeyLocal = londonDateKey(now);
  const nowMinutes = londonParts(now).hour * 60 + londonParts(now).minute;
  for (const direction of ['AM', 'PM']){
    if (confirmedTrains[todayKeyLocal] && confirmedTrains[todayKeyLocal][direction] !== undefined) continue;
    const dirTrains = railTrains.filter(t => t.direction === direction);
    const nearDeparture = dirTrains.some(t => {
      const tMin = parseInt(t.time.slice(0,2),10)*60 + parseInt(t.time.slice(2,4),10);
      return nowMinutes >= tMin - LIKELY_TRAIN_FAST_WINDOW_BEFORE_MIN && nowMinutes <= tMin + LIKELY_TRAIN_FAST_WINDOW_AFTER_MIN;
    });
    if (nearDeparture) return LIKELY_TRAIN_FAST_CHECK_INTERVAL_MS;
  }
  return LIKELY_TRAIN_CHECK_INTERVAL_MS;
}

// Runs the two checks sequentially, not concurrently — checkLikelyArrival
// is meant to be a fallback that only gets a real turn once departure-side
// detection has already had its own shot (and, via each function's own
// "already confirmed?" guard, correctly does nothing further once the
// other has succeeded). Firing both at once undermined that: no
// guarantee departure detection had actually completed before arrival
// detection also started, and no guard against a slow cycle overlapping
// with the next scheduled run. The in-flight guard below stops that too —
// a cycle still running when the next run would otherwise fire is skipped
// rather than allowed to overlap with it.
//
// Self-rescheduling setTimeout rather than a single setInterval, since
// the delay needs to change from one cycle to the next: normally the
// LIKELY_TRAIN_CHECK_INTERVAL_MS baseline, tightened to
// LIKELY_TRAIN_FAST_CHECK_INTERVAL_MS via computeLikelyTrainCheckDelay()
// whenever a configured, not-yet-confirmed departure is imminent — see
// that function for why. Same pattern already used for the train-progress
// screen's own adaptive polling.
async function runLikelyTrainCycle(){
  if (likelyTrainCycleRunning) return;
  likelyTrainCycleRunning = true;
  try{
    await checkLikelyTrain();
    await checkLikelyArrival();
  }catch(e){ /* each check already handles its own failures internally — this is just a final safety net so a cycle failure can't leave the guard stuck on */ }
  finally{
    likelyTrainCycleRunning = false;
    if (likelyTrainChecksActive){
      likelyTrainCheckTimer = setTimeout(runLikelyTrainCycle, computeLikelyTrainCheckDelay());
    }
  }
}
function startLikelyTrainChecks(){
  if (likelyTrainChecksActive) return;
  likelyTrainChecksActive = true;
  runLikelyTrainCycle();
}
function stopLikelyTrainChecks(){
  likelyTrainChecksActive = false;
  if (likelyTrainCheckTimer){ clearTimeout(likelyTrainCheckTimer); likelyTrainCheckTimer = null; }
}

// 2026-09-30: optional dateKey — the Confirm train badge opens this on the
// delayed day. No argument (the menu) keeps opening on today as before.
function openConfirmTrain(dateKey){
  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const suggested = (typeof dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) ? dateKey : fmtKey(today);
  function optionsFor(direction, existingKey){
    const trains = railTrains.filter(t => t.direction === direction).sort((a,b) => a.time.localeCompare(b.time));
    let opts = `<option value="">— None / didn't travel —</option>`;
    trains.forEach(t => {
      opts += `<option value="${t.key}" ${existingKey === t.key ? 'selected' : ''}>${t.label}</option>`;
    });
    return opts;
  }

  function renderForDate(dateKey){
    const existing = confirmedTrains[dateKey] || {};
    document.getElementById('confirm-train-fields').innerHTML = `
      <div class="ui-field">
        <label class="ui-field-label" for="confirm-am-select">Morning train actually caught</label>
        <select id="confirm-am-select">${optionsFor('AM', existing.AM)}</select>
      </div>
      <div class="ui-field">
        <label class="ui-field-label" for="confirm-pm-select">Evening train actually caught</label>
        <select id="confirm-pm-select">${optionsFor('PM', existing.PM)}</select>
      </div>
    `;
  }

  // Stage 7 (2026-11-13): a bottom sheet with Save at the bottom.
  const sheet = uiOpenSheet('Confirm train used', `
      <div class="ui-sheet-sub">Records which specific train you actually caught, in case it wasn't your usual one (e.g. you caught an earlier delayed service instead). This doesn't affect your ticket usage tracking — it's just for more accurate delay repay matching.</div>
      <div class="ui-field">
        <label class="ui-field-label" for="confirm-date-input">Date</label>
        <input type="date" id="confirm-date-input" value="${suggested}" />
      </div>
      <div class="ui-gap-top" id="confirm-train-fields"></div>
      <div class="ui-sheet-actions"><button type="button" class="ui-btn-primary" id="confirm-train-save">Save</button></div>`, { id: 'confirm-train-sheet' });
  renderForDate(suggested);

  // 2026-09-27: Copy for WhatsApp — the chosen train isn't known until
  // Save, so build the text for every evening train now (today only).
  let manualJourneyTexts = null; // { dateKey, texts: { trainKey: text } }
  const journeyToday = journeyTodayKey();
  if (suggested === journeyToday){
    buildJourneyTextsForAllPm().then(texts => { manualJourneyTexts = { dateKey: journeyToday, texts }; }).catch(() => {});
  }

  document.getElementById('confirm-date-input').addEventListener('change', (e) => {
    renderForDate(e.target.value);
  });

  document.getElementById('confirm-train-save').addEventListener('click', async () => {
    const dateKey = document.getElementById('confirm-date-input').value;
    const amKey = document.getElementById('confirm-am-select').value;
    const pmKey = document.getElementById('confirm-pm-select').value;
    if (!dateKey) return;
    const before = confirmedTrains[dateKey] || {};
    // 2026-09-27: Copy for WhatsApp — before any await. Today only, a real
    // evening train, and only when that selection is new or changed.
    if (pmKey && dateKey === journeyTodayKey() && (before.PM || '') !== pmKey &&
        manualJourneyTexts && manualJourneyTexts.dateKey === dateKey && manualJourneyTexts.texts[pmKey] &&
        !isJourneyCopyDone(dateKey, pmKey)){
      const pmTrain = railTrains.find(t => t.key === pmKey);
      copyJourneyText(manualJourneyTexts.texts[pmKey], dateKey, pmKey, pmTrain ? pmTrain.label : pmKey, 'manual');
    }
    const entry = {};
    if (amKey) entry.AM = amKey;
    if (pmKey) entry.PM = pmKey;
    // 2026-09-25: tell the Worker — today only (the only date its
    // confirmed:{date} records and ping retries still matter for), and
    // only for a direction you actually changed, so saving an AM entry
    // in the morning can't tombstone PM before the evening ping runs.
    if (dateKey === fmtKey(new Date())){
      if ((before.AM || '') !== (amKey || '')) pushManualConfirmedTrain(dateKey, 'AM', amKey);
      if ((before.PM || '') !== (pmKey || '')) pushManualConfirmedTrain(dateKey, 'PM', pmKey);
    }
    if (Object.keys(entry).length === 0){
      delete confirmedTrains[dateKey];
    } else {
      confirmedTrains[dateKey] = entry;
    }
    await saveConfirmedTrains();
    renderSilentConfirmBanner(); // 2026-09-27: a changed evening train retires any Copy button still offering the old one
    sheet.close();
    render();
  });
}
