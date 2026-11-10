// settings.js — Settings grid, Costs, polling, geofence, write secret, drive check, preferred Google account.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// Same stroke style as REFRESH_ICON/REMOVE_ICON — one consistent
// visual language for every icon in the app, not a second one just for
// this grid.
const SETTINGS_ICONS = {
  costs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>',
  polling: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>',
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5a6 6 0 0 1 11 0"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  train: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="13" rx="4"/><path d="M6 12h12M9 3v9M15 3v9"/><circle cx="9" cy="19" r="1.3"/><circle cx="15" cy="19" r="1.3"/><path d="M7 16l-2 4M17 16l2 4"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v5h5"/><path d="M8 13h8M8 17h5"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .3-8 6 6 0 0 0-11.6 1.6A4 4 0 0 0 7 18z"/></svg>',
  bug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="8" height="10" rx="4"/><path d="M12 8V5M8 11H4M20 11h-4M9 6 7.5 4.5M15 6l1.5-1.5M8 18l-2 2M16 18l2 2M9 13h6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  geo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l3 3M14.5 8.5l2 2"/></svg>',
  car: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16V11l2-5h10l2 5v5"/><path d="M3 16h18v2H3z"/><path d="M5 11h14"/><circle cx="7.5" cy="18.5" r="1.5"/><circle cx="16.5" cy="18.5" r="1.5"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

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
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Settings</h3>
      <div class="settings-grid">
        <div class="settings-grid-item" id="settings-costs-link">${SETTINGS_ICONS.costs}<span class="cat-label">Costs</span></div>
        <div class="settings-grid-item" id="settings-polling-link">${SETTINGS_ICONS.polling}<span class="cat-label">Polling</span></div>
        <div class="settings-grid-item" id="settings-geofence-link">${SETTINGS_ICONS.geo}<span class="cat-label">Geofence</span></div>
        <div class="settings-grid-item${preferredGoogleEmail ? ' active' : ''}" id="settings-preferred-google-link">${SETTINGS_ICONS.account}<span class="cat-label">Account</span><span class="status-label">${preferredGoogleEmail ? 'Connected' : 'Not connected'}</span></div>
        <div class="settings-grid-item${gcalEnabled ? ' active' : ''}" id="settings-gcal-link">${SETTINGS_ICONS.calendar}<span class="cat-label">Calendar</span><span class="status-label">${gcalEnabled ? 'Connected' : 'Not connected'}</span></div>
        <div class="settings-grid-item" id="settings-rail-config-link">${SETTINGS_ICONS.train}<span class="cat-label">Trains</span></div>
        <div class="settings-grid-item${driveCheckConfig.enabled ? ' active' : ''}" id="settings-drive-check-link">${SETTINGS_ICONS.car}<span class="cat-label">Drive check</span><span class="status-label">${driveCheckConfig.enabled ? 'On' : 'Off'}</span></div>
        <div class="settings-grid-item" id="settings-pass-photo-link">${SETTINGS_ICONS.card}<span class="cat-label">Smartcard</span></div>
        <div class="settings-grid-item${produceClaimDetailsFile ? ' active' : ''}" id="settings-claim-file-link">${SETTINGS_ICONS.file}<span class="cat-label">Claim file</span><span class="status-label">${produceClaimDetailsFile ? 'On' : 'Off'}</span></div>
        <div class="settings-grid-item${weatherEnabled ? ' active' : ''}" id="settings-weather-link">${SETTINGS_ICONS.cloud}<span class="cat-label">Weather</span><span class="status-label">${weatherEnabled ? 'On' : 'Off'}</span></div>
        <div class="settings-grid-item${debugModeEnabled ? ' active' : ''}" id="settings-debug-link">${SETTINGS_ICONS.bug}<span class="cat-label">Debug</span><span class="status-label">${debugModeEnabled ? 'On' : 'Off'}</span></div>
        <div class="settings-grid-item${paydayVisible ? ' active' : ''}" id="settings-payday-visibility-link">${SETTINGS_ICONS.eye}<span class="cat-label">Payday card</span><span class="status-label">${paydayVisible ? 'Visible' : 'Hidden'}</span></div>
        <div class="settings-grid-item${parkingSavingsVisible ? ' active' : ''}" id="settings-parking-savings-visibility-link">${SETTINGS_ICONS.eye}<span class="cat-label">Savings card</span><span class="status-label">${parkingSavingsVisible ? 'Visible' : 'Hidden'}</span></div>
        <div class="settings-grid-item${spendingVisible ? ' active' : ''}" id="settings-spending-visibility-link">${SETTINGS_ICONS.eye}<span class="cat-label">Spending card</span><span class="status-label">${spendingVisible ? 'Visible' : 'Hidden'}</span></div>
        <div class="settings-grid-item" id="settings-emergency-routes-link">${SETTINGS_ICONS.warning}<span class="cat-label">Emergency routes</span></div>
        <div class="settings-grid-item${emergencyTabVisible ? ' active' : ''}" id="settings-emergency-tab-link">${SETTINGS_ICONS.warning}<span class="cat-label">Emergency tab</span><span class="status-label">${emergencyTabVisible ? 'Shown' : 'Hidden'}</span></div>
        <div class="settings-grid-item" id="settings-home-work-link">${SETTINGS_ICONS.geo}<span class="cat-label">Home & Work stations</span><span class="status-label">${escapeHtml(homeStation.code)} / ${escapeHtml(workStation.code)}</span></div>
        <div class="settings-grid-item${pwaWriteSecret ? ' active' : ''}" id="settings-write-secret-link">${SETTINGS_ICONS.key}<span class="cat-label">Write secret</span><span class="status-label">${pwaWriteSecret ? 'Set' : 'Not set'}</span></div>
      </div>
      <div class="modal-close" id="settings-close-btn" style="margin-top:20px;">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);
  function close(){ if (overlay.isConnected) document.body.removeChild(overlay); }

  function toggleStatus(id, isActive, text){
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active', isActive);
    const statusEl = el.querySelector('.status-label');
    if (statusEl) statusEl.textContent = text;
  }

  document.getElementById('settings-costs-link').addEventListener('click', () => { close(); openCostsMenu(true); });
  document.getElementById('settings-polling-link').addEventListener('click', () => { close(); openPollingSettingsEditor(true); });
  document.getElementById('settings-geofence-link').addEventListener('click', () => { close(); openGeofenceSettingsEditor(true); });
  document.getElementById('settings-preferred-google-link').addEventListener('click', () => { close(); openPreferredGoogleEditor(true); });
  document.getElementById('settings-rail-config-link').addEventListener('click', () => { close(); openRailConfig(true); });
  document.getElementById('settings-drive-check-link').addEventListener('click', () => { close(); openDriveCheckEditor(true); });
  document.getElementById('settings-pass-photo-link').addEventListener('click', () => { close(); openPassPhotoManager(true); });
  document.getElementById('settings-claim-file-link').addEventListener('click', async () => {
    produceClaimDetailsFile = !produceClaimDetailsFile;
    await saveProduceClaimDetailsFile();
    toggleStatus('settings-claim-file-link', produceClaimDetailsFile, produceClaimDetailsFile ? 'On' : 'Off');
  });
  document.getElementById('settings-weather-link').addEventListener('click', async () => {
    weatherEnabled = !weatherEnabled;
    await saveWeatherEnabled();
    toggleStatus('settings-weather-link', weatherEnabled, weatherEnabled ? 'On' : 'Off');
  });
  document.getElementById('settings-emergency-routes-link').addEventListener('click', () => { close(); openAlternativeRoutesManager(true); });
  document.getElementById('settings-emergency-tab-link').addEventListener('click', async () => {
    emergencyTabVisible = !emergencyTabVisible;
    await saveEmergencyTabVisible();
    toggleStatus('settings-emergency-tab-link', emergencyTabVisible, emergencyTabVisible ? 'Shown' : 'Hidden');
  });
  document.getElementById('settings-home-work-link').addEventListener('click', () => { close(); openHomeWorkStationsManager(); });
  document.getElementById('settings-write-secret-link').addEventListener('click', () => { close(); openPwaWriteSecretEditor(true); });
  document.getElementById('settings-debug-link').addEventListener('click', async () => {
    debugModeEnabled = !debugModeEnabled;
    await saveDebugMode();
    toggleStatus('settings-debug-link', debugModeEnabled, debugModeEnabled ? 'On' : 'Off');
  });
  // These three are genuine bidirectional toggles now, not one-way
  // "restore" actions — tapping hides the card if it's showing, or
  // brings it back if it's hidden, matching every other toggle in this
  // grid rather than only ever appearing once something's already been
  // dismissed elsewhere.
  document.getElementById('settings-payday-visibility-link').addEventListener('click', async () => {
    if (dismissedMonths[currentPeriodStartKey]) delete dismissedMonths[currentPeriodStartKey];
    else dismissedMonths[currentPeriodStartKey] = true;
    await saveDismissedMonths();
    const nowVisible = !dismissedMonths[currentPeriodStartKey];
    toggleStatus('settings-payday-visibility-link', nowVisible, nowVisible ? 'Visible' : 'Hidden');
  });
  document.getElementById('settings-parking-savings-visibility-link').addEventListener('click', async () => {
    if (dismissedParkingSavingsPeriods[currentPeriodStartKey]) delete dismissedParkingSavingsPeriods[currentPeriodStartKey];
    else dismissedParkingSavingsPeriods[currentPeriodStartKey] = true;
    await saveDismissedParkingSavingsPeriods();
    const nowVisible = !dismissedParkingSavingsPeriods[currentPeriodStartKey];
    toggleStatus('settings-parking-savings-visibility-link', nowVisible, nowVisible ? 'Visible' : 'Hidden');
  });
  document.getElementById('settings-spending-visibility-link').addEventListener('click', async () => {
    ticketsSpentCardDismissed = !ticketsSpentCardDismissed;
    await saveTicketsSpentCardDismissed();
    const nowVisible = !ticketsSpentCardDismissed;
    toggleStatus('settings-spending-visibility-link', nowVisible, nowVisible ? 'Visible' : 'Hidden');
  });
  document.getElementById('settings-gcal-link').addEventListener('click', async () => {
    if (gcalEnabled){
      gcalEnabled = false;
      await saveGcalEnabled();
      await deleteGoogleCalendarEvent(); // same reasoning as the other disconnect path — nothing else will ever clean this up once disconnected
      close();
      render();
      return;
    }
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
  document.getElementById('settings-close-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

function openCostsMenu(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Costs</h3>
      <div class="sub">Daily costs used to estimate what to set aside each payday.</div>
      <div class="settings-link" id="costs-parking-link">Set daily parking cost (currently £${parkingCost.toFixed(2)})</div>
      <div class="settings-link" id="costs-day-return-link">Set day return price (currently £${dayReturnPrice.toFixed(2)})</div>
      <div class="modal-close" id="costs-close-btn" style="margin-top:16px;">${cameFromSettings ? '← Back to Settings' : 'Close'}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  function close(){ if (overlay.isConnected) document.body.removeChild(overlay); }
  document.getElementById('costs-parking-link').addEventListener('click', () => { close(); openParkingCostEditor(); });
  document.getElementById('costs-day-return-link').addEventListener('click', () => { close(); openDayReturnPriceEditor(); });
  document.getElementById('costs-close-btn').addEventListener('click', () => { close(); if (cameFromSettings) openSettingsMenu(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay){ close(); if (cameFromSettings) openSettingsMenu(); } });
}

function openParkingCostEditor(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Daily parking cost</h3>
      <div class="sub">Used to estimate what to set aside each month, on days you might drive in.</div>
      <input type="number" id="parking-cost-input" value="${parkingCost.toFixed(2)}" step="0.01" min="0" style="margin-bottom:12px;" />
      <button class="save-btn" id="parking-cost-save">Save</button>
      <div class="modal-close" id="parking-cost-close">Cancel</div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('parking-cost-save').addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('parking-cost-input').value);
    if (!isNaN(val) && val >= 0){
      parkingCost = val;
      await saveParkingCost();
      document.body.removeChild(overlay); render();
    }
  });
  document.getElementById('parking-cost-close').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}

function openPollingSettingsEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Live progress polling</h3>
      <div class="sub">A train that's already been cancelled shows up the moment you open the screen either way — this only affects how often it keeps checking in afterward, while it hasn't departed yet.</div>
      <div style="margin-top:14px; font-size:13px; color:var(--ink-dim);">Resume normal checking this many minutes before scheduled departure</div>
      <input type="number" id="poll-before-departure-input" value="${pollBeforeDepartureMin}" step="1" min="0" max="${POLL_BEFORE_DEPARTURE_MIN_MAX}" style="margin-bottom:12px;" />
      <div style="font-size:13px; color:var(--ink-dim);">Longest gap allowed between checks before that</div>
      <input type="number" id="poll-check-in-input" value="${pollCheckInIntervalMin}" step="1" min="1" max="${POLL_CHECK_IN_INTERVAL_MIN_MAX}" style="margin-bottom:12px;" />
      <button class="save-btn" id="poll-settings-save">Save</button>
      <div class="modal-close" id="poll-settings-close">${cameFromSettings ? '← Back to Settings' : 'Cancel'}</div>
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
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay){
      document.body.removeChild(overlay);
      if (cameFromSettings) openSettingsMenu();
    }
  });
}

// 2026-09-24: per-device entry for the Worker's PWA_SHARED_SECRET. Stored in
// localStorage only. Saving triggers an immediate push, so a wrong value
// shows up straight away as the 401 toast rather than on the next app open.
function openPwaWriteSecretEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Write secret</h3>
      <div class="sub">Lets this device save settings to the Worker (watch config, geofence radii, trains). Needed once per browser or phone. The value is in Bitwarden (PWA_SHARED_SECRET).</div>
      <input type="password" id="pwa-write-secret-input" value="${escapeHtml(pwaWriteSecret)}" autocomplete="off" autocapitalize="off" spellcheck="false" style="margin-top:14px; margin-bottom:6px;" />
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink-dim); margin-bottom:16px; cursor:pointer; -webkit-user-select:none; user-select:none;">
        <input type="checkbox" id="pwa-write-secret-show" /> Show
      </label>
      <button class="save-btn" id="pwa-write-secret-save">Save</button>
      <div class="modal-close" id="pwa-write-secret-close">${cameFromSettings ? '← Back to Settings' : 'Cancel'}</div>
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
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay){
      document.body.removeChild(overlay);
      if (cameFromSettings) openSettingsMenu();
    }
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
  overlay.className = 'modal-overlay';
  const draft = JSON.parse(JSON.stringify(driveCheckConfig));
  if (!draft.checkTimesByTrain) draft.checkTimesByTrain = {};
  const amTrains = railTrains.filter(t => t.direction === 'AM').sort((a, b) => a.time.localeCompare(b.time));

  function routeRowHtml(r, i){
    const vias = [0, 1, 2].map(n => `
      <input type="text" class="dc-via" data-route="${i}" data-via="${n}" inputmode="decimal" autocomplete="off" spellcheck="false"
        placeholder="Via point ${n + 1}${n === 0 ? '' : ' (optional)'} — lat, lng" value="${escapeHtml(fmtLatLng(r.via[n]))}" style="margin-bottom:6px;" />`).join('');
    return `
      <div style="border:1px solid var(--line); border-radius:10px; padding:10px; margin-bottom:10px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <input type="text" class="dc-route-name" data-route="${i}" maxlength="24" value="${escapeHtml(r.name)}" placeholder="Route name" style="flex:1;" />
          <label style="display:flex; align-items:center; gap:4px; font-size:12px; color:var(--ink-dim); white-space:nowrap;">
            <input type="radio" name="dc-usual" class="dc-usual" data-route="${i}" ${r.usual ? 'checked' : ''} /> Usual
          </label>
          ${draft.routes.length > 1 ? `<span class="modal-close" data-dc-remove="${i}" style="margin:0; font-size:13px;">Remove</span>` : ''}
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
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <span style="font-size:13px; min-width:92px;">${escapeHtml(t.label)} train<br><span style="font-size:11px; color:var(--ink-dim);">${alertAt ? `watch alert ${escapeHtml(alertAt)}` : 'no watch alert'}</span></span>
          <input type="time" class="dc-slot" data-key="${t.key}" value="${escapeHtml(draft.checkTimesByTrain[t.key] || '')}" style="flex:1;" />
          <span class="modal-close" data-dc-clear-slot="${t.key}" style="margin:0; font-size:13px;">Clear</span>
        </div>`;
    }).join('');
    const homeText = draft._homeText !== undefined ? draft._homeText : fmtLatLng(driveCheckHome);
    const stationText = draft._stationText !== undefined ? draft._stationText : fmtLatLng(draft.station);

    overlay.innerHTML = `
      <div class="modal">
        <h3>Morning drive check</h3>
        <div class="sub">Just before you leave for the station, your watch checks live traffic on each route below and tells you which way to go — "Go via…", "…slow", or "…clear" when the usual way is fine. Nothing happens on weekends or tagged days (WFH, holiday, etc).</div>

        <label style="display:flex; align-items:center; gap:8px; margin:14px 0; font-size:14px; cursor:pointer;">
          <input type="checkbox" id="dc-enabled" ${draft.enabled ? 'checked' : ''} /> Drive check on
        </label>

        <div class="rail-col-header">Check at (follows that morning's target train)</div>
        ${slotRows || '<div class="sub">No morning trains set up — add them in Settings → Trains.</div>'}

        <div class="rail-col-header" style="margin-top:14px;">Locations</div>
        <div class="sub" style="margin-bottom:8px;">Paste "lat, lng" — on a computer, right-click the spot in Google Maps and click the numbers at the top of the menu. Home stays on this device and the Worker only; it isn't included in backups.</div>
        <div style="font-size:13px; color:var(--ink-dim); margin-bottom:4px;">Home (on the road outside)</div>
        <input type="text" id="dc-home" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="lat, lng" value="${escapeHtml(homeText)}" style="margin-bottom:10px;" />
        <div style="font-size:13px; color:var(--ink-dim); margin-bottom:4px;">Station car park entrance</div>
        <input type="text" id="dc-station" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="lat, lng" value="${escapeHtml(stationText)}" style="margin-bottom:14px;" />

        <div class="rail-col-header">Routes</div>
        <div class="sub" style="margin-bottom:8px;">Each route is forced through its via points, in order. Put them mid-way along a plain stretch of road, away from junctions, on the side you drive along.</div>
        ${draft.routes.map(routeRowHtml).join('')}
        ${draft.routes.length < DRIVE_CHECK_MAX_ROUTES ? '<div class="settings-link" id="dc-add-route" style="margin-bottom:14px;">+ Add another route</div>' : ''}

        <div class="rail-col-header">Thresholds (minutes)</div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="font-size:13px; flex:1;">Alert if usual route is this much over normal</span>
          <input type="number" id="dc-delay" min="1" max="30" step="1" value="${Number.isFinite(draft.delayThresholdMin) ? draft.delayThresholdMin : 5}" style="width:70px;" />
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="font-size:13px; flex:1;">Suggest another route if it saves at least</span>
          <input type="number" id="dc-switch" min="1" max="30" step="1" value="${Number.isFinite(draft.switchThresholdMin) ? draft.switchThresholdMin : 5}" style="width:70px;" />
        </div>
        <div class="sub" style="margin-bottom:14px;">"Normal" is Google's empty-road time plus 5 minutes.</div>

        <div id="dc-error" style="color:var(--danger); font-size:13px; margin-bottom:10px; display:none;"></div>
        <div id="dc-result" style="display:none; margin-bottom:12px;"></div>

        <button class="save-btn" id="dc-test" style="margin-bottom:8px;">Save &amp; test now</button>
        <button class="save-btn" id="dc-save">Save</button>
        <div class="modal-close" id="dc-close">${cameFromSettings ? '← Back to Settings' : 'Cancel'}</div>
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
      el.style.display = msg ? 'block' : 'none';
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
        resultEl.style.display = 'block';
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
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
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
    return `<div style="font-size:13px;"><strong>Couldn't check traffic.</strong> ${why}</div>`;
  }
  if (data.status === 'skipped'){
    return `<div style="font-size:13px;">Skipped: ${escapeHtml(data.reason || '')}</div>`;
  }
  const rows = (data.routes || []).map(r => `
    <tr>
      <td style="padding:2px 8px 2px 0;">${escapeHtml(r.name)}${r.usual ? ' <span style="color:var(--ink-dim);">(usual)</span>' : ''}</td>
      <td style="padding:2px 8px; text-align:right;">${r.failed ? '—' : `${r.minutes} min`}</td>
      <td style="padding:2px 0 2px 8px; text-align:right; color:var(--ink-dim);">${r.failed ? 'no route' : `empty road ${r.freeFlowMinutes}`}</td>
    </tr>`).join('');
  return `
    <div style="font-size:14px; font-weight:600;">${escapeHtml(data.title || '')}</div>
    <div style="font-size:13px; margin-bottom:6px; white-space:pre-line;">${escapeHtml(data.text || '')}</div>
    <table style="font-size:13px; border-collapse:collapse;">${rows}</table>
    <div style="font-size:11px; color:var(--ink-dim); margin-top:4px;">Checked ${escapeHtml(data.checkedAt || '')}.${showPinHint ? ' If a route looks far too long, one of its via pins has probably snapped to the wrong road.' : ''}</div>`;
}

function openGeofenceSettingsEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Geofence radius</h3>
      <div class="sub">How close you need to be to a station before the app will silently confirm a train or suggest one. Tighter catches false positives (like a nearby office on your walk in), but too tight risks missing a real detection if GPS wanders once you're on the platform itself.</div>

      <div style="margin-top:14px; font-size:13px; color:var(--ink-dim);">Crewe radius (metres)</div>
      <input type="number" id="geofence-crewe-input" value="${geofenceRadiusCrewe}" step="10" min="${GEOFENCE_RADIUS_MIN_M}" max="${GEOFENCE_RADIUS_MAX_M}" style="margin-bottom:6px;" />
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink-dim); margin-bottom:16px; cursor:pointer; -webkit-user-select:none; user-select:none;">
        <input type="checkbox" id="geofence-crewe-match" ${geofenceCreweMatchesWigan ? 'checked' : ''} /> Match Wigan
      </label>

      <div style="font-size:13px; color:var(--ink-dim);">Wigan radius (metres)</div>
      <input type="number" id="geofence-wigan-input" value="${geofenceRadiusWigan}" step="10" min="${GEOFENCE_RADIUS_MIN_M}" max="${GEOFENCE_RADIUS_MAX_M}" style="margin-bottom:6px;" />
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink-dim); margin-bottom:12px; cursor:pointer; -webkit-user-select:none; user-select:none;">
        <input type="checkbox" id="geofence-wigan-match" ${geofenceWiganMatchesCrewe ? 'checked' : ''} /> Match Crewe
      </label>

      <button class="save-btn" id="geofence-settings-save">Save</button>
      <div class="modal-close" id="geofence-settings-close">${cameFromSettings ? '← Back to Settings' : 'Cancel'}</div>
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
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay){
      document.body.removeChild(overlay);
      if (cameFromSettings) openSettingsMenu();
    }
  });
}


function openDayReturnPriceEditor(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Day return price</h3>
      <div class="sub">Used by the ticket purchase advisor to compare against your season ticket.</div>
      <input type="number" id="day-return-price-input" value="${dayReturnPrice.toFixed(2)}" step="0.01" min="0" style="margin-bottom:12px;" />
      <button class="save-btn" id="day-return-price-save">Save</button>
      <div class="modal-close" id="day-return-price-close">Cancel</div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('day-return-price-save').addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('day-return-price-input').value);
    if (!isNaN(val) && val >= 0){
      dayReturnPrice = val;
      await saveDayReturnPrice();
      document.body.removeChild(overlay); render();
    }
  });
  document.getElementById('day-return-price-close').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}

function openPreferredGoogleEditor(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Preferred Google account</h3>
      <div class="sub">If you have more than one Google account, entering the email here skips the account picker when connecting to Calendar.</div>
      <input type="email" id="preferred-google-input" value="${escapeHtml(preferredGoogleEmail)}" placeholder="you@gmail.com" style="margin-bottom:12px;" />
      <button class="save-btn" id="preferred-google-save">Save</button>
      <div class="modal-close" id="preferred-google-close">${cameFromSettings ? '← Back to Settings' : 'Cancel'}</div>
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
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay){
      document.body.removeChild(overlay);
      if (cameFromSettings) openSettingsMenu();
    }
  });
}
