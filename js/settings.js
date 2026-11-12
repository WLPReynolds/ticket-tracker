// settings.js — the Settings page (grouped list), Costs, polling, geofence, write secret, drive check, preferred Google account.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// Where the Settings list was scrolled to when a sub-page was opened, so coming
// back puts you in the same place instead of at the top (2026-11-11).
let settingsReturnScroll = 0;

// 2026-11-11 — facelift stage 2: Settings is a full-screen page (the shared
// page frame) with one grouped list. Pages that open another page show their
// current value and a chevron; on/off items are switches flipped in place.
// Every sub-page uses the same frame and returns here. See STYLEGUIDE.md.
function openSettingsMenu(){
  // Recomputed locally, the same way the other Settings sub-screens
  // already do, rather than relying on render()'s own closure — this
  // function is opened independently of any specific render() call.
  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const currentPeriodStartKey = fmtKey(getPayPeriodByOffset(today, 0).start);
  const paydayVisible = !dismissedMonths[currentPeriodStartKey];
  const parkingSavingsVisible = !dismissedParkingSavingsPeriods[currentPeriodStartKey];
  const spendingVisible = !ticketsSpentCardDismissed;

  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = uiPageBar('Settings', { backId: 'settings-close-btn', backLabel: 'Back to Home' }) + `
    <div class="ui-page-list">
      ${uiGroup('Travel', [
        uiRow('settings-rail-config-link', 'Trains', `${railTrains.length} tracked`),
        uiRow('settings-home-work-link', 'Home and work stations', `${homeStation.code} / ${workStation.code}`),
        uiRow('settings-emergency-routes-link', 'Emergency routes'),
        uiSwitchRow('settings-emergency-tab-link', 'Emergency tab', emergencyTabVisible),
      ])}
      ${uiGroup('Costs', [
        uiRow('settings-costs-link', 'Parking and day return'),
      ])}
      ${uiGroup('Alerts and watch', [
        uiRow('settings-drive-check-link', 'Drive check', driveCheckConfig.enabled ? 'On' : 'Off'),
        uiRow('settings-geofence-link', 'Geofence'),
        uiRow('settings-polling-link', 'Polling'),
        uiSwitchRow('settings-weather-link', 'Weather', weatherEnabled),
      ])}
      ${uiGroup('Home screen', [
        uiSwitchRow('settings-payday-visibility-link', 'Payday figure', paydayVisible),
        uiSwitchRow('settings-parking-savings-visibility-link', 'Parking savings figure', parkingSavingsVisible),
        uiSwitchRow('settings-spending-visibility-link', 'Spending figure', spendingVisible),
      ])}
      ${uiGroup('Delay repay', [
        uiRow('settings-pass-photo-link', 'Smartcard photo'),
        uiSwitchRow('settings-claim-file-link', 'Claim details file', produceClaimDetailsFile),
      ])}
      ${uiGroup('Accounts', [
        uiRow('settings-preferred-google-link', 'Google account', preferredGoogleEmail ? 'Connected' : 'Not connected'),
        uiSwitchRow('settings-gcal-link', 'Calendar sync', gcalEnabled),
      ])}
      ${uiGroup('Advanced', [
        uiRow('settings-write-secret-link', 'Write secret', pwaWriteSecret ? 'Set' : 'Not set'),
        uiSwitchRow('settings-debug-link', 'Debug', debugModeEnabled),
      ])}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.scrollTop = settingsReturnScroll;
  settingsReturnScroll = 0;
  function close(){ if (overlay.isConnected) document.body.removeChild(overlay); }
  // Opening a sub-page: remember where we were scrolled to, then swap pages.
  function goTo(openFn){ settingsReturnScroll = overlay.scrollTop; close(); openFn(); }
  function onTap(id, fn){ document.getElementById(id).addEventListener('click', fn); }

  onTap('settings-costs-link', () => goTo(() => openCostsMenu(true)));
  onTap('settings-polling-link', () => goTo(() => openPollingSettingsEditor(true)));
  onTap('settings-geofence-link', () => goTo(() => openGeofenceSettingsEditor(true)));
  onTap('settings-preferred-google-link', () => goTo(() => openPreferredGoogleEditor(true)));
  onTap('settings-rail-config-link', () => goTo(() => openRailConfig(true)));
  onTap('settings-drive-check-link', () => goTo(() => openDriveCheckEditor(true)));
  onTap('settings-pass-photo-link', () => goTo(() => openPassPhotoManager(true)));
  onTap('settings-emergency-routes-link', () => goTo(() => openAlternativeRoutesManager(true)));
  onTap('settings-home-work-link', () => goTo(() => openHomeWorkStationsManager(true)));
  onTap('settings-write-secret-link', () => goTo(() => openPwaWriteSecretEditor(true)));

  onTap('settings-claim-file-link', async () => {
    produceClaimDetailsFile = !produceClaimDetailsFile;
    await saveProduceClaimDetailsFile();
    uiSetSwitch('settings-claim-file-link', produceClaimDetailsFile);
  });
  onTap('settings-weather-link', async () => {
    weatherEnabled = !weatherEnabled;
    await saveWeatherEnabled();
    uiSetSwitch('settings-weather-link', weatherEnabled);
  });
  onTap('settings-emergency-tab-link', async () => {
    emergencyTabVisible = !emergencyTabVisible;
    await saveEmergencyTabVisible();
    uiSetSwitch('settings-emergency-tab-link', emergencyTabVisible);
  });
  onTap('settings-debug-link', async () => {
    debugModeEnabled = !debugModeEnabled;
    await saveDebugMode();
    uiSetSwitch('settings-debug-link', debugModeEnabled);
  });
  // These three are genuine bidirectional toggles — switching one off hides
  // that Home figure, switching it on brings it back. The payday and parking
  // savings ones are stored per pay period, the spending one once for all.
  onTap('settings-payday-visibility-link', async () => {
    if (dismissedMonths[currentPeriodStartKey]) delete dismissedMonths[currentPeriodStartKey];
    else dismissedMonths[currentPeriodStartKey] = true;
    await saveDismissedMonths();
    uiSetSwitch('settings-payday-visibility-link', !dismissedMonths[currentPeriodStartKey]);
  });
  onTap('settings-parking-savings-visibility-link', async () => {
    if (dismissedParkingSavingsPeriods[currentPeriodStartKey]) delete dismissedParkingSavingsPeriods[currentPeriodStartKey];
    else dismissedParkingSavingsPeriods[currentPeriodStartKey] = true;
    await saveDismissedParkingSavingsPeriods();
    uiSetSwitch('settings-parking-savings-visibility-link', !dismissedParkingSavingsPeriods[currentPeriodStartKey]);
  });
  onTap('settings-spending-visibility-link', async () => {
    ticketsSpentCardDismissed = !ticketsSpentCardDismissed;
    await saveTicketsSpentCardDismissed();
    uiSetSwitch('settings-spending-visibility-link', !ticketsSpentCardDismissed);
  });
  onTap('settings-gcal-link', async () => {
    if (gcalEnabled){
      gcalEnabled = false;
      await saveGcalEnabled();
      await deleteGoogleCalendarEvent(); // same reasoning as the other disconnect path — nothing else will ever clean this up once disconnected
      uiSetSwitch('settings-gcal-link', false);
      render(); // refresh Home behind this page
      return;
    }
    // Connecting runs Google's sign-in, which needs this page out of the way.
    close();
    render();
    if (GOOGLE_CLIENT_ID.includes('YOUR_CLIENT_ID')){
      alert('Google Calendar isn\'t set up yet. See the setup notes for what\'s needed.');
      return;
    }
    const token = await getGoogleAccessToken();
    if (token){
      gcalEnabled = true;
      await saveGcalEnabled();
      // today/todayKey aren't available here the way they are inside
      // render() itself (where this logic used to live) — recomputed
      // the same way render() does, rather than assuming a global.
      const nb = findNextBuyDateKey(today, fmtKey(today));
      if (nb){ gcalPendingSync = true; await syncGoogleCalendarEvent(nb); }
      render();
    }
  });
  onTap('settings-close-btn', () => { settingsReturnScroll = 0; close(); });
}

// 2026-11-10 — one combined form (backlog item 2, spec
// claude/codebase-split-and-costs-form-spec.md Part B). Replaces the old
// two-link menu and its two single-field editors (openParkingCostEditor,
// openDayReturnPriceEditor). Invalid input is now shown, not silently
// ignored; only changed values are saved; a parking-cost change republishes
// the Personal Finance estimates straight away rather than on the next
// app foreground.
function openCostsMenu(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `
    ${uiPageBar('Costs', { backId: 'costs-close-btn', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'costs-save' })}
    <div class="ui-page-body">
      <div class="sub">Daily costs used to estimate what to set aside each payday.</div>
      <div class="ui-card">
        <div class="ui-field">
          <label class="ui-field-label" for="costs-parking-input">Daily parking cost (£)</label>
          <input class="ui-input" type="number" inputmode="decimal" id="costs-parking-input" value="${parkingCost.toFixed(2)}" step="0.01" min="0" />
          <div class="ui-field-error" id="costs-parking-error" hidden></div>
          <div class="ui-field-help">Used for the payday estimate on days you might drive in, and as the default when you tick 'I parked today'.</div>
        </div>
        <div class="ui-field">
          <label class="ui-field-label" for="costs-day-return-input">Day return price (£)</label>
          <input class="ui-input" type="number" inputmode="decimal" id="costs-day-return-input" value="${dayReturnPrice.toFixed(2)}" step="0.01" min="0" />
          <div class="ui-field-error" id="costs-day-return-error" hidden></div>
          <div class="ui-field-help">Used by the Buy tab to compare singles against a season ticket. The Buy tab can also update this from the live fares check.</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  function close(){ if (overlay.isConnected) document.body.removeChild(overlay); }
  function back(){ close(); if (cameFromSettings) openSettingsMenu(); }

  // Blank, negative or non-numeric → null. An <input type="number"> already
  // reports junk as '' — the isFinite check covers anything else.
  function readMoney(inputId, errorId){
    const raw = document.getElementById(inputId).value.trim();
    const val = raw === '' ? NaN : Number(raw);
    const errEl = document.getElementById(errorId);
    if (!Number.isFinite(val) || val < 0){
      errEl.textContent = 'Enter an amount of £0 or more.';
      errEl.style.display = 'block';
      return null;
    }
    errEl.style.display = 'none';
    return val;
  }
  // Compared in pennies, so an untouched field (shown to 2dp) never counts
  // as a change just because the stored value had more decimal places.
  const pennies = (v) => Math.round(v * 100);

  document.getElementById('costs-save').addEventListener('click', async () => {
    const parkingVal = readMoney('costs-parking-input', 'costs-parking-error');
    const dayReturnVal = readMoney('costs-day-return-input', 'costs-day-return-error');
    if (parkingVal === null || dayReturnVal === null) return; // nothing saved

    const parkingChanged = pennies(parkingVal) !== pennies(parkingCost);
    const dayReturnChanged = pennies(dayReturnVal) !== pennies(dayReturnPrice);
    if (parkingChanged){
      parkingCost = parkingVal;
      await saveParkingCost();
      scheduleTransportPublish(); // Personal Finance estimates — agreed 2026-11-10
    }
    if (dayReturnChanged){
      dayReturnPrice = dayReturnVal;
      await saveDayReturnPrice();
    }
    close();
    // Re-render whenever something changed, so the Home payday card behind
    // Settings is already up to date when Settings is closed.
    if (parkingChanged || dayReturnChanged) render();
    if (cameFromSettings) openSettingsMenu();
  });
  document.getElementById('costs-close-btn').addEventListener('click', back);
}

function openPollingSettingsEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `
    ${uiPageBar('Polling', { backId: 'poll-settings-close', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'poll-settings-save' })}
    <div class="ui-page-body">
      <div class="sub">A train that's already been cancelled shows up the moment you open the screen either way — this only affects how often it keeps checking in afterward, while it hasn't departed yet.</div>
      <div class="ui-card">
        <div class="ui-field">
          <label class="ui-field-label" for="poll-before-departure-input">Resume normal checking (minutes before departure)</label>
          <input type="number" inputmode="numeric" id="poll-before-departure-input" value="${pollBeforeDepartureMin}" step="1" min="0" max="${POLL_BEFORE_DEPARTURE_MIN_MAX}" />
        </div>
        <div class="ui-field">
          <label class="ui-field-label" for="poll-check-in-input">Longest gap between checks before that (minutes)</label>
          <input type="number" inputmode="numeric" id="poll-check-in-input" value="${pollCheckInIntervalMin}" step="1" min="1" max="${POLL_CHECK_IN_INTERVAL_MIN_MAX}" />
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('poll-settings-save').addEventListener('click', async () => {
    const beforeVal = parseInt(document.getElementById('poll-before-departure-input').value, 10);
    const checkInVal = parseInt(document.getElementById('poll-check-in-input').value, 10);
    if (!isNaN(beforeVal) && beforeVal >= 0 && !isNaN(checkInVal) && checkInVal >= 1){
      // Clamped here too, not just constrained by the input's own max
      // attribute — that's only a UI hint a browser can choose to
      // enforce loosely (or not at all), not a real guarantee on the
      // value actually saved.
      pollBeforeDepartureMin = clampPollBeforeDepartureMin(beforeVal);
      pollCheckInIntervalMin = clampPollCheckInIntervalMin(checkInVal);
      await savePollingSettings();
      document.body.removeChild(overlay);
      if (cameFromSettings) openSettingsMenu(); else render();
    }
  });
  document.getElementById('poll-settings-close').addEventListener('click', () => {
    document.body.removeChild(overlay);
    if (cameFromSettings) openSettingsMenu();
  });
}

// 2026-09-24: per-device entry for the Worker's PWA_SHARED_SECRET. Stored in
// localStorage only. Saving triggers an immediate push, so a wrong value
// shows up straight away as the 401 toast rather than on the next app open.
function openPwaWriteSecretEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `
    ${uiPageBar('Write secret', { backId: 'pwa-write-secret-close', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'pwa-write-secret-save' })}
    <div class="ui-page-body">
      <div class="sub">Lets this device save settings to the Worker (watch config, geofence radii, trains). Needed once per browser or phone. The value is in Bitwarden (PWA_SHARED_SECRET).</div>
      <div class="ui-card">
        <div class="ui-field">
          <label class="ui-field-label" for="pwa-write-secret-input">Write secret</label>
          <input type="password" id="pwa-write-secret-input" value="${escapeHtml(pwaWriteSecret)}" autocomplete="off" autocapitalize="off" spellcheck="false" />
          ${uiCheck('pwa-write-secret-show', 'Show', false, { small: true })}
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('pwa-write-secret-input');
  document.getElementById('pwa-write-secret-show').addEventListener('change', (e) => {
    input.type = e.target.checked ? 'text' : 'password';
  });

  document.getElementById('pwa-write-secret-save').addEventListener('click', async () => {
    pwaWriteSecret = input.value.trim();
    await savePwaWriteSecret();
    document.body.removeChild(overlay);
    if (pwaWriteSecret) pushWatchConfig();
    if (cameFromSettings) openSettingsMenu(); else render();
  });
  document.getElementById('pwa-write-secret-close').addEventListener('click', () => {
    document.body.removeChild(overlay);
    if (cameFromSettings) openSettingsMenu();
  });
}

// ---------------------------------------------------------------------
// Settings → Drive check (2026-09-30, drive-check-spec.md, slice 2).
// Edits a draft; Save commits and pushes. "Save & test now" does the same,
// waits for the push to be accepted, then asks the Worker to run a check
// immediately (?force=1 — ignores the day, the slot and the On/Off switch)
// and shows every route's time, so the via pins can be sanity-checked.
// ---------------------------------------------------------------------
function openDriveCheckEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  const draft = JSON.parse(JSON.stringify(driveCheckConfig));
  if (!draft.checkTimesByTrain) draft.checkTimesByTrain = {};
  const amTrains = railTrains.filter(t => t.direction === 'AM').sort((a, b) => a.time.localeCompare(b.time));

  function routeRowHtml(r, i){
    const vias = [0, 1, 2].map(n => `
      <input type="text" class="dc-via" data-route="${i}" data-via="${n}" inputmode="decimal" autocomplete="off" spellcheck="false"
        placeholder="Via point ${n + 1}${n === 0 ? '' : ' (optional)'} — lat, lng" value="${escapeHtml(fmtLatLng(r.via[n]))}" />`).join('');
    return `
      <div class="ui-subcard ui-stack">
        <div class="ui-inline">
          <input type="text" class="dc-route-name" data-route="${i}" maxlength="24" value="${escapeHtml(r.name)}" placeholder="Route name" />
          <label class="ui-check ui-check-small"><input type="radio" name="dc-usual" class="dc-usual" data-route="${i}" ${r.usual ? 'checked' : ''} /><span>Usual</span></label>
          ${draft.routes.length > 1 ? `<span class="ui-link ui-link-dim ui-inline-action" role="button" data-dc-remove="${i}">Remove</span>` : ''}
        </div>
        ${vias}
      </div>`;
  }

  function readForm(){
    draft.enabled = overlay.querySelector('#dc-enabled').checked;
    overlay.querySelectorAll('.dc-slot').forEach(inp => {
      if (inp.value) draft.checkTimesByTrain[inp.dataset.key] = inp.value;
      else delete draft.checkTimesByTrain[inp.dataset.key];
    });
    draft._homeText = overlay.querySelector('#dc-home').value;
    draft._stationText = overlay.querySelector('#dc-station').value;
    draft.delayThresholdMin = parseInt(overlay.querySelector('#dc-delay').value, 10);
    draft.switchThresholdMin = parseInt(overlay.querySelector('#dc-switch').value, 10);
    overlay.querySelectorAll('.dc-route-name').forEach(inp => { draft.routes[+inp.dataset.route].name = inp.value.trim(); });
    overlay.querySelectorAll('.dc-usual').forEach(inp => { draft.routes[+inp.dataset.route].usual = inp.checked; });
    draft.routes.forEach(r => { r._viaText = []; });
    overlay.querySelectorAll('.dc-via').forEach(inp => { draft.routes[+inp.dataset.route]._viaText[+inp.dataset.via] = inp.value; });
  }

  // Returns an error message, or null and commits the draft into the live
  // settings (not yet saved/pushed — the caller does that).
  function validateAndCommit(){
    readForm();
    const home = draft._homeText.trim() ? parseLatLng(draft._homeText) : null;
    if (draft._homeText.trim() && !home) return 'Home location isn\'t a valid "lat, lng" in the UK.';
    const station = draft._stationText.trim() ? parseLatLng(draft._stationText) : null;
    if (draft._stationText.trim() && !station) return 'Station car park isn\'t a valid "lat, lng" in the UK.';
    for (const [label, n] of [['Slow-route threshold', draft.delayThresholdMin], ['Quicker-route threshold', draft.switchThresholdMin]]){
      if (!Number.isInteger(n) || n < 1 || n > 30) return `${label} must be 1–30 minutes.`;
    }
    const routes = [];
    for (const r of draft.routes){
      if (!r.name) return 'Every route needs a name.';
      const via = [];
      for (const t of r._viaText){
        if (!t || !t.trim()) continue;
        const p = parseLatLng(t);
        if (!p) return `"${r.name}": a via point isn't a valid "lat, lng" in the UK.`;
        via.push(p);
      }
      routes.push({ key: r.key, name: r.name, via, usual: !!r.usual });
    }
    if (routes.filter(r => r.usual).length !== 1) return 'Pick one route as your usual.';
    const names = routes.map(r => r.name.toLowerCase());
    if (new Set(names).size !== names.length) return 'Route names must be different.';
    driveCheckConfig = {
      enabled: draft.enabled,
      checkTimesByTrain: { ...draft.checkTimesByTrain },
      station,
      delayThresholdMin: draft.delayThresholdMin,
      switchThresholdMin: draft.switchThresholdMin,
      routes,
    };
    driveCheckHome = home;
    return null;
  }

  function incompleteReason(){
    if (!isValidLatLng(driveCheckHome)) return 'home location';
    if (!isValidLatLng(driveCheckConfig.station)) return 'station car park';
    const noVia = driveCheckConfig.routes.find(r => !r.via.length);
    if (noVia) return `a via point for ${noVia.name}`;
    return null;
  }

  function renderEditor(){
    const slotRows = amTrains.map(t => {
      const alertAt = trainAlertConfig[t.key] && trainAlertConfig[t.key].checkTime;
      return `
        <div class="ui-inline">
          <span class="ui-inline-label">${escapeHtml(t.label)} train<br><span class="ui-dim">${alertAt ? `watch alert ${escapeHtml(alertAt)}` : 'no watch alert'}</span></span>
          <input type="time" class="dc-slot" data-key="${t.key}" value="${escapeHtml(draft.checkTimesByTrain[t.key] || '')}" />
          <span class="ui-link ui-link-dim ui-inline-action" role="button" data-dc-clear-slot="${t.key}">Clear</span>
        </div>`;
    }).join('');
    const homeText = draft._homeText !== undefined ? draft._homeText : fmtLatLng(driveCheckHome);
    const stationText = draft._stationText !== undefined ? draft._stationText : fmtLatLng(draft.station);

    overlay.innerHTML = `
      ${uiPageBar('Drive check', { backId: 'dc-close', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'dc-save' })}
      <div class="ui-page-body">
        <div class="sub">Just before you leave for the station, your watch checks live traffic on each route below and tells you which way to go — "Go via…", "…slow", or "…clear" when the usual way is fine. Nothing happens on weekends or tagged days (WFH, holiday, etc).</div>

        <div class="ui-card">${uiCheck('dc-enabled', 'Drive check on', draft.enabled)}</div>

        <div class="ui-subhead">Check at (follows that morning's target train)</div>
        <div class="ui-card">${slotRows || '<div class="ui-empty">No morning trains set up — add them in Settings → Trains.</div>'}</div>

        <div class="ui-subhead">Locations</div>
        <div class="sub">Paste "lat, lng" — on a computer, right-click the spot in Google Maps and click the numbers at the top of the menu. Home stays on this device and the Worker only; it isn't included in backups.</div>
        <div class="ui-card">
          <div class="ui-field">
            <label class="ui-field-label" for="dc-home">Home (on the road outside)</label>
            <input type="text" id="dc-home" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="lat, lng" value="${escapeHtml(homeText)}" />
          </div>
          <div class="ui-field">
            <label class="ui-field-label" for="dc-station">Station car park entrance</label>
            <input type="text" id="dc-station" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="lat, lng" value="${escapeHtml(stationText)}" />
          </div>
        </div>

        <div class="ui-subhead">Routes</div>
        <div class="sub">Each route is forced through its via points, in order. Put them mid-way along a plain stretch of road, away from junctions, on the side you drive along.</div>
        ${draft.routes.map(routeRowHtml).join('')}
        ${draft.routes.length < DRIVE_CHECK_MAX_ROUTES ? '<span class="ui-link" role="button" id="dc-add-route">Add another route</span>' : ''}

        <div class="ui-subhead">Thresholds (minutes)</div>
        <div class="ui-card">
          <div class="ui-inline">
            <label class="ui-inline-label" for="dc-delay">Alert if usual route is this much over normal</label>
            <input type="number" inputmode="numeric" class="ui-input-short" id="dc-delay" min="1" max="30" step="1" value="${Number.isFinite(draft.delayThresholdMin) ? draft.delayThresholdMin : 5}" />
          </div>
          <div class="ui-inline">
            <label class="ui-inline-label" for="dc-switch">Suggest another route if it saves at least</label>
            <input type="number" inputmode="numeric" class="ui-input-short" id="dc-switch" min="1" max="30" step="1" value="${Number.isFinite(draft.switchThresholdMin) ? draft.switchThresholdMin : 5}" />
          </div>
          <div class="ui-field-help ui-gap-top-sm">"Normal" is Google's empty-road time plus 5 minutes.</div>
        </div>

        <div class="ui-notice ui-notice-bad ui-gap-top" id="dc-error" hidden></div>
        <div class="ui-notice ui-gap-top" id="dc-result" hidden></div>

        <button type="button" class="ui-btn-secondary ui-btn-block ui-gap-top" id="dc-test">Save &amp; test now</button>
      </div>
    `;

    overlay.querySelectorAll('[data-dc-clear-slot]').forEach(el => {
      el.addEventListener('click', () => {
        const inp = overlay.querySelector(`.dc-slot[data-key="${el.dataset.dcClearSlot}"]`);
        if (inp) inp.value = '';
      });
    });
    overlay.querySelectorAll('[data-dc-remove]').forEach(el => {
      el.addEventListener('click', () => {
        readForm();
        const idx = +el.dataset.dcRemove;
        const wasUsual = draft.routes[idx].usual;
        draft.routes.splice(idx, 1);
        if (wasUsual && draft.routes.length) draft.routes[0].usual = true;
        draft.routes.forEach(r => { r.via = (r._viaText || []).map(t => parseLatLng(t)).filter(Boolean); });
        renderEditor();
      });
    });
    const addBtn = overlay.querySelector('#dc-add-route');
    if (addBtn) addBtn.addEventListener('click', () => {
      readForm();
      draft.routes.forEach(r => { r.via = (r._viaText || []).map(t => parseLatLng(t)).filter(Boolean); });
      let n = draft.routes.length + 1, key;
      do { key = `route-${n++}`; } while (draft.routes.some(r => r.key === key));
      draft.routes.push({ key, name: '', via: [], usual: false });
      renderEditor();
    });

    const showError = (msg) => {
      const el = overlay.querySelector('#dc-error');
      el.textContent = msg || '';
      el.hidden = !msg;
    };

    overlay.querySelector('#dc-save').addEventListener('click', async () => {
      const err = validateAndCommit();
      if (err){ showError(err); return; }
      saveDriveCheckSettings();
      const missing = incompleteReason();
      if (!missing) pushWatchConfig();
      document.body.removeChild(overlay);
      if (missing && driveCheckConfig.enabled) showToast(`Drive check saved, but it won't run until you add the ${missing}.`);
      if (cameFromSettings) openSettingsMenu();
    });

    overlay.querySelector('#dc-test').addEventListener('click', async () => {
      const err = validateAndCommit();
      if (err){ showError(err); return; }
      showError('');
      saveDriveCheckSettings();
      const missing = incompleteReason();
      if (missing){ showError(`Add the ${missing} first.`); return; }
      if (!pwaWriteSecret){ showError('Set the write secret first (Settings → Write secret).'); return; }
      const btn = overlay.querySelector('#dc-test');
      const resultEl = overlay.querySelector('#dc-result');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try{
        const pushed = await pushWatchConfig();
        if (!pushed){ showError('Couldn\'t save the settings to the Worker, so the test didn\'t run.'); return; }
        const resp = await fetch(`${DARWIN_WORKER_URL}/api/drive-check?force=1`, { headers: { 'X-PWA-Secret': pwaWriteSecret } });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data){ showError(`Test failed: ${resp.status}`); return; }
        resultEl.innerHTML = renderDriveCheckResult(data);
        resultEl.hidden = false;
      } catch(e){
        showError('Test failed — are you offline?');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save & test now';
      }
    });

    const close = () => {
      if (overlay.isConnected) document.body.removeChild(overlay);
      if (cameFromSettings) openSettingsMenu();
    };
    overlay.querySelector('#dc-close').addEventListener('click', close);
  }

  document.body.appendChild(overlay);
  renderEditor();
}

// Inline result for "Save & test now" — the same title/text the watch would
// show, plus every route's live and empty-road minutes.
function renderDriveCheckResult(data, opts){
  const showPinHint = !(opts && opts.hidePinHint);
  if (data.status === 'error'){
    const why = data.reason === 'no-maps-key' ? 'The Worker has no MAPS_API_KEY secret yet.'
      : data.reason === 'usual-route-failed' ? 'Google couldn\'t route the usual way — check its via points.'
      : `(${escapeHtml(data.reason || 'unknown')})`;
    return `<div><strong>Couldn't check traffic.</strong> ${why}</div>`;
  }
  if (data.status === 'skipped'){
    return `<div>Skipped: ${escapeHtml(data.reason || '')}</div>`;
  }
  const rows = (data.routes || []).map(r => `
    <tr>
      <td>${escapeHtml(r.name)}${r.usual ? ' <span class="ui-dim">(usual)</span>' : ''}</td>
      <td>${r.failed ? '—' : `${r.minutes} min`}</td>
      <td class="ui-dim">${r.failed ? 'no route' : `empty road ${r.freeFlowMinutes}`}</td>
    </tr>`).join('');
  return `
    <div class="dc-result-title">${escapeHtml(data.title || '')}</div>
    <div class="dc-result-text">${escapeHtml(data.text || '')}</div>
    <table class="ui-data-table">${rows}</table>
    <div class="dc-result-checked">Checked ${escapeHtml(data.checkedAt || '')}.${showPinHint ? ' If a route looks far too long, one of its via pins has probably snapped to the wrong road.' : ''}</div>`;
}

function openGeofenceSettingsEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `
    ${uiPageBar('Geofence', { backId: 'geofence-settings-close', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'geofence-settings-save' })}
    <div class="ui-page-body">
      <div class="sub">How close you need to be to a station before the app will silently confirm a train or suggest one. Tighter catches false positives (like a nearby office on your walk in), but too tight risks missing a real detection if GPS wanders once you're on the platform itself.</div>

      <div class="ui-card">
        <div class="ui-field">
          <label class="ui-field-label" for="geofence-crewe-input">Crewe radius (metres)</label>
          <input type="number" inputmode="numeric" id="geofence-crewe-input" value="${geofenceRadiusCrewe}" step="10" min="${GEOFENCE_RADIUS_MIN_M}" max="${GEOFENCE_RADIUS_MAX_M}" />
          ${uiCheck('geofence-crewe-match', 'Match Wigan', geofenceCreweMatchesWigan, { small: true })}
        </div>
        <div class="ui-field">
          <label class="ui-field-label" for="geofence-wigan-input">Wigan radius (metres)</label>
          <input type="number" inputmode="numeric" id="geofence-wigan-input" value="${geofenceRadiusWigan}" step="10" min="${GEOFENCE_RADIUS_MIN_M}" max="${GEOFENCE_RADIUS_MAX_M}" />
          ${uiCheck('geofence-wigan-match', 'Match Crewe', geofenceWiganMatchesCrewe, { small: true })}
        </div>
      </div>

    </div>
  `;
  document.body.appendChild(overlay);

  const creweInput = document.getElementById('geofence-crewe-input');
  const wiganInput = document.getElementById('geofence-wigan-input');
  const creweMatch = document.getElementById('geofence-crewe-match');
  const wiganMatch = document.getElementById('geofence-wigan-match');

  // Reflects the active sync direction (if any) in the fields themselves —
  // the "driven" field is disabled and kept showing the other one's value,
  // so it's visually obvious which side is in control before Save is even
  // pressed.
  function applyMatchUI(){
    creweInput.disabled = creweMatch.checked;
    wiganInput.disabled = wiganMatch.checked;
    if (creweMatch.checked) creweInput.value = wiganInput.value;
    if (wiganMatch.checked) wiganInput.value = creweInput.value;
  }
  applyMatchUI();

  creweMatch.addEventListener('change', () => {
    // Mutually exclusive — at most one direction of sync active at a
    // time, or the two fields would each be trying to drive the other.
    if (creweMatch.checked) wiganMatch.checked = false;
    applyMatchUI();
  });
  wiganMatch.addEventListener('change', () => {
    if (wiganMatch.checked) creweMatch.checked = false;
    applyMatchUI();
  });
  creweInput.addEventListener('input', () => { if (wiganMatch.checked) wiganInput.value = creweInput.value; });
  wiganInput.addEventListener('input', () => { if (creweMatch.checked) creweInput.value = wiganInput.value; });

  document.getElementById('geofence-settings-save').addEventListener('click', async () => {
    const creweVal = parseInt(creweInput.value, 10);
    const wiganVal = parseInt(wiganInput.value, 10);
    if (isNaN(creweVal) || isNaN(wiganVal)) return;
    geofenceCreweMatchesWigan = creweMatch.checked;
    geofenceWiganMatchesCrewe = wiganMatch.checked;
    // Resolve to the actual effective numbers before storing — the
    // geofence check (and anything else reading these later, including a
    // future Wear OS companion) only ever needs two plain radii, not the
    // sync relationship that produced them.
    if (geofenceCreweMatchesWigan){
      geofenceRadiusWigan = clampGeofenceRadius(wiganVal);
      geofenceRadiusCrewe = geofenceRadiusWigan;
    } else if (geofenceWiganMatchesCrewe){
      geofenceRadiusCrewe = clampGeofenceRadius(creweVal);
      geofenceRadiusWigan = geofenceRadiusCrewe;
    } else {
      geofenceRadiusCrewe = clampGeofenceRadius(creweVal);
      geofenceRadiusWigan = clampGeofenceRadius(wiganVal);
    }
    await saveGeofenceSettings();
    document.body.removeChild(overlay);
    if (cameFromSettings) openSettingsMenu(); else render();
  });
  document.getElementById('geofence-settings-close').addEventListener('click', () => {
    document.body.removeChild(overlay);
    if (cameFromSettings) openSettingsMenu();
  });
}

function openPreferredGoogleEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `
    ${uiPageBar('Google account', { backId: 'preferred-google-close', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'preferred-google-save' })}
    <div class="ui-page-body">
      <div class="sub">If you have more than one Google account, entering the email here skips the account picker when connecting to Calendar.</div>
      <div class="ui-card">
        <div class="ui-field">
          <label class="ui-field-label" for="preferred-google-input">Google account email</label>
          <input type="email" id="preferred-google-input" value="${escapeHtml(preferredGoogleEmail)}" placeholder="you@gmail.com" />
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('preferred-google-save').addEventListener('click', async () => {
    const previousGoogleEmail = preferredGoogleEmail;
    preferredGoogleEmail = document.getElementById('preferred-google-input').value.trim();
    await savePreferredGoogleEmail();
    // 2026-10-04: changing this doesn't disconnect automatic sign-in (Wayne's
    // call) — just say which account it's still tied to.
    if (preferredGoogleEmail !== previousGoogleEmail && googleWorkerState() === 'connected'){
      alert('Automatic backup and Calendar are still connected to the Google account you connected before. To switch, use Reconnect automatic sign-in on Backup & restore.');
    }
    googleTokenClient = null; // force a fresh client next time, so the new hint actually takes effect
    clearGoogleTokenCache(); // any cached token was for the old hint context — don't reuse it (2026-10-02: now also clears the stored copy)
    document.body.removeChild(overlay);
    if (cameFromSettings) openSettingsMenu(); else render();
  });
  document.getElementById('preferred-google-close').addEventListener('click', () => {
    document.body.removeChild(overlay);
    if (cameFromSettings) openSettingsMenu();
  });
}
