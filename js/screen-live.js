// screen-live.js — openLiveScreen — the Live tab.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// Single "Live" screen combining your usual AM/PM trains, everything
// currently tracked, and the ability to track any other train — three
// things that used to live in separate places (the Live nav tab, a
// menu-only "Tracked trains" screen, and a debug-gated search tool).
// initialSubTab lets a caller land directly on 'tracked' (e.g. closing a
// train that was opened from this list should return to this list, not
// to whichever sub-tab happened to be active before).
// Shared refresh icon — used wherever a manual refresh action needs an
// icon rather than plain text, so every instance stays visually
// identical and only ever needs updating in one place.
const REFRESH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.5L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.5L3 16"/><path d="M3 21v-5h5"/></svg>';

// Last from/to searched on the Tracked tab's "Track a train" form
// (2026-09-16, replacing a localStorage-backed version). Deliberately a
// plain module-level variable, not localStorage: it needs to survive
// switching sub-tabs and reopening the add form within one Live screen
// session (the original point of remembering it at all — repeating a
// lookup shouldn't mean retyping both stations), but genuinely not
// survive a fresh app open, which localStorage did by design and Wayne
// didn't want. Being plain memory also fixes a related bug: previously
// the "X" clear button only cleared the on-screen picker, never the
// persisted value, so switching tabs and back silently resurrected the
// stations just cleared. Updated directly by the pickers' onChange below
// (not just on Search), so a clear takes effect immediately everywhere
// this gets read.
let lastTrackedSearch = null;

function openLiveScreen(initialSubTab){
  let activeSubTab = initialSubTab === 'tracked' ? 'tracked' : 'yours';
  let showAddForm = false;
  // Session-only, same reasoning as the old Tracked Trains screen: this
  // is "what happened last time we checked", not data worth persisting.
  const trackedErrors = {}; // serviceId -> error message string
  // The Live board doesn't auto-refresh once open (same as before — the
  // status line says as much), but switching between sub-tabs shouldn't
  // force a re-fetch every time either. Cached for this screen's
  // lifetime; a fresh fetch only happens on a genuine reopen.
  let yoursBoardsPromise = null;

  const REMOVE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  // Facelift stage 5 (2026-11-13): a tab page — full screen with the bottom
  // nav still showing, no Close link (tap another tab to leave). Keeps the
  // modal-overlay class so closeAllModals() clears it like before.
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ui-tabpage';
  overlay.innerHTML = `
    <div class="ui-tabpage-head">
      <div class="ui-tabpage-title">Live trains</div>
      <div class="ui-segmented" role="tablist">
        <button type="button" id="live-subtab-yours">My trains</button>
        <button type="button" id="live-subtab-tracked">Tracked</button>
        ${emergencyTabVisible ? '<button type="button" id="live-subtab-emergency">Emergency</button>' : ''}
      </div>
    </div>
    <div class="ui-page-body" id="live-screen-body"></div>
  `;
  document.body.appendChild(overlay);

  const bodyEl = document.getElementById('live-screen-body');
  const tabYoursBtn = document.getElementById('live-subtab-yours');
  const tabTrackedBtn = document.getElementById('live-subtab-tracked');
  const tabEmergencyBtn = document.getElementById('live-subtab-emergency'); // null unless emergencyTabVisible

  // Session-only, same reasoning as trackedErrors — cleared on every
  // reopen of this screen, never persisted.
  let emergencyResults = null;
  let emergencyChecking = false;
  // The exact route list actually checked (alternativeRoutes plus the
  // synthetic direct-service route built fresh each check) — grouping
  // and direction logic look routes up here, not in alternativeRoutes
  // directly, since the direct-service route was never authored/saved.
  let emergencyRoutesChecked = null;

  function styleTabs(){
    tabYoursBtn.classList.toggle('is-selected', activeSubTab === 'yours');
    tabTrackedBtn.classList.toggle('is-selected', activeSubTab === 'tracked');
    tabTrackedBtn.textContent = trackedTrains.length ? `Tracked (${trackedTrains.length})` : 'Tracked';
    if (tabEmergencyBtn) tabEmergencyBtn.classList.toggle('is-selected', activeSubTab === 'emergency');
  }

  // ---- "My trains" tab (your configured AM/PM services) ----
  function timeToHHMM(t){ return t.slice(0,2) + ':' + t.slice(2,4); }

  // One train as a line, using Home's Your trains parts (stage 5) so a
  // train looks the same in both places: time, status pill, platform.
  function rowForConfigured(train, service){
    if (!service){
      return `<div class="ui-train-line is-static"><span class="ui-train-line-time">${train.label}</span><span class="ui-pill">No live data</span><span class="ui-train-line-text"></span></div>`;
    }
    if (service.isCancelled){
      const why = service.cancelReason ? service.cancelReason.replace(/^This service has been cancelled /,'') : '';
      return `<div class="ui-train-line is-static"><span class="ui-train-line-time">${train.label}</span><span class="ui-pill ui-pill-bad">Cancelled</span><span class="ui-train-line-text">${escapeHtml(why)}</span></div>`;
    }
    const onTime = !service.etd || service.etd === 'On time';
    const pill = onTime ? '<span class="ui-pill ui-pill-good">On time</span>'
      : service.etd === 'Delayed' ? '<span class="ui-pill ui-pill-warn">Delayed</span>'
      : `<span class="ui-pill ui-pill-warn">Now ${escapeHtml(service.etd)}</span>`;
    const platformText = service.platform ? `Platform ${escapeHtml(String(service.platform))}` : '';
    return `<div class="ui-train-line" data-train-key="${train.key}"><span class="ui-train-line-time">${train.label}</span>${pill}<span class="ui-train-line-text">${platformText}</span><span class="ui-train-chev">${UI_ICON_CHEV}</span></div>`;
  }

  // ---- "Watch alert target" strip (2026-09-18, target-train-alert-spec.md) ----
  // The evening-before override: which train the watch should report on for
  // today or tomorrow, if not the default. Sits above the live board on the
  // My trains tab (not on the rows themselves — those already tap through to
  // train progress). Defaults to Today in the morning and Tomorrow from
  // midday, since the point is setting it the evening before.
  let targetStripDay = new Date().getHours() < 12 ? 'today' : 'tomorrow';
  // 2026-09-30: collapsed by default to keep the tab clean — a one-line
  // summary of the targets, tap to open the full controls. Open/closed is
  // remembered on this device ('live-target-strip-open', not backed up).
  let targetStripOpen = loadJSON('live-target-strip-open', false) === true;
  function targetStripDateKey(){
    const d = new Date();
    if (targetStripDay === 'tomorrow') d.setDate(d.getDate() + 1);
    return fmtKey(d);
  }
  function renderTargetStrip(){
    const el = document.getElementById('live-target-strip');
    if (!el || !overlay.isConnected) return;
    const dateKey = targetStripDateKey();
    const overrides = targetTrainOverrides[dateKey] || {};
    const noCommute = nonTravelLabelFor(dateKey);
    const notes = [];
    if (noCommute) notes.push(`${escapeHtml(noCommute)} — not a commute day, so no alerts.`);

    function rowHtml(dir, label){
      const trains = railTrains.filter(t => t.direction === dir).sort((a, b) => a.time.localeCompare(b.time));
      if (!trains.length) return '';
      const defTrain = trains.find(t => t.key === defaultTargetTrains[dir]);
      const ovKey = overrides[dir] || '';
      const effTrain = trains.find(t => t.key === (ovKey || defaultTargetTrains[dir]));
      if (effTrain && !(trainAlertConfig[effTrain.key] && trainAlertConfig[effTrain.key].checkTime)){
        notes.push(`No alert time set for the ${effTrain.label} — add one in Settings → Trains.`);
      }
      const opts = `<option value="">${defTrain ? `Default (${defTrain.label})` : 'Default (no alert)'}</option>` +
        trains.map(t => `<option value="${t.key}" ${ovKey === t.key ? 'selected' : ''}>${t.label}</option>`).join('');
      return `<div class="live-target-row"><span>${label}</span><select data-target-dir="${dir}" aria-label="${label} watch alert train">${opts}</select></div>`;
    }
    const rows = rowHtml('AM', 'Morning') + rowHtml('PM', 'Evening');

    // One-line summary for the collapsed state: the effective target per
    // direction (an override from the default shows in amber).
    const summaryParts = ['AM', 'PM'].map(dir => {
      const trains = railTrains.filter(t => t.direction === dir);
      const ovKey = overrides[dir] || '';
      const eff = trains.find(t => t.key === (ovKey || defaultTargetTrains[dir]));
      if (!eff) return null;
      return ovKey ? `<span class="ui-amber">${escapeHtml(eff.label)}</span>` : escapeHtml(eff.label);
    }).filter(Boolean);
    const summary = noCommute ? `${escapeHtml(noCommute)} · no alerts` : (summaryParts.join(' · ') || 'none set');
    const dayWord = targetStripDay === 'today' ? 'Today' : 'Tomorrow';

    el.innerHTML = `
      <div class="ui-card ui-card-flush ui-disclosure${targetStripOpen ? ' is-open' : ''}">
        <div class="ui-disclosure-head" data-target-toggle role="button" aria-expanded="${targetStripOpen}">
          <span class="ui-disclosure-label">Watch alert</span>
          <span class="ui-disclosure-value">${dayWord}: ${summary}</span>
          <span class="ui-disclosure-chev">${UI_ICON_CHEV}</span>
        </div>
        ${targetStripOpen ? `
        <div class="ui-disclosure-body">
          <div class="live-target-date">
            <span>${dateLabel(parseKey(dateKey))}</span>
            <div class="ui-segmented">
              <button type="button" class="${targetStripDay === 'today' ? 'is-selected' : ''}" data-target-day="today">Today</button>
              <button type="button" class="${targetStripDay === 'tomorrow' ? 'is-selected' : ''}" data-target-day="tomorrow">Tomorrow</button>
            </div>
          </div>
          ${rows || '<div class="ui-empty">No trains configured.</div>'}
          ${notes.map(n => `<div class="live-note">${n}</div>`).join('')}
        </div>` : ''}
      </div>`;

    el.querySelector('[data-target-toggle]').addEventListener('click', () => {
      targetStripOpen = !targetStripOpen;
      try{ localStorage.setItem('live-target-strip-open', JSON.stringify(targetStripOpen)); }catch(e){}
      renderTargetStrip();
    });
    el.querySelectorAll('[data-target-day]').forEach(chip => {
      chip.addEventListener('click', () => { targetStripDay = chip.dataset.targetDay; renderTargetStrip(); });
    });
    el.querySelectorAll('select[data-target-dir]').forEach(sel => {
      sel.addEventListener('change', async () => {
        const dir = sel.dataset.targetDir;
        const val = sel.value;
        const per = targetTrainOverrides[dateKey] ? { ...targetTrainOverrides[dateKey] } : {};
        // Sparse: choosing "Default" (or the train that already IS the
        // default) stores nothing, rather than an override that just repeats it.
        if (!val || val === defaultTargetTrains[dir]) delete per[dir]; else per[dir] = val;
        if (Object.keys(per).length) targetTrainOverrides[dateKey] = per; else delete targetTrainOverrides[dateKey];
        await saveTargetTrains();
        renderTargetStrip();
      });
    });
  }

  // ---- "Drive to station" row + morning banner (2026-09-30, drive-check-spec.md slice 4) ----
  // A one-line row under the Watch alert panel: tap to check traffic now
  // (Worker ?now=1). Shows the verdict collapsed; tap again to see every
  // route's minutes. Between 07:30 and 07:45 on a travel day with the drive
  // check on, opening this tab runs it automatically and shows the result as
  // a banner at the top, dismissible for the rest of that morning.
  let driveRowOpen = false;
  let driveLoading = false;
  let driveError = null;
  function renderDriveRow(){
    const el = document.getElementById('live-drive-row');
    if (!el || !overlay.isConnected) return;
    const d = lastDriveCheck && lastDriveCheck.data;
    let right;
    if (!buildDriveCheckPayload()) right = 'Set up';
    else if (driveLoading) right = 'Checking…';
    else if (driveError) right = `<span class="ui-bad">Couldn't check</span>`;
    else if (d && (d.status === 'alert' || d.status === 'clear')) {
      right = `<span class="${d.status === 'alert' ? 'ui-amber' : 'ui-good'}">${escapeHtml(d.title || '')}</span>`;
    } else right = 'Check';
    const open = driveRowOpen && !driveLoading && (d || driveError);
    el.innerHTML = `
      <div class="ui-card ui-card-flush ui-disclosure${open ? ' is-open' : ''}">
        <div class="ui-disclosure-head" data-drive-toggle role="button">
          <span class="ui-disclosure-label">Drive to station</span>
          <span class="ui-disclosure-value">${right}</span>
          <span class="ui-disclosure-chev">${UI_ICON_CHEV}</span>
        </div>
        ${driveRowOpen && d && !driveLoading ? `
        <div class="ui-disclosure-body">${renderDriveCheckResult(d, { hidePinHint: true })}
          <span class="ui-link" role="button" data-drive-recheck>Check again</span></div>` : ''}
        ${driveRowOpen && driveError && !driveLoading ? `<div class="ui-disclosure-body"><div class="live-note">${escapeHtml(driveError)}</div></div>` : ''}
      </div>`;
    el.querySelector('[data-drive-toggle]').addEventListener('click', () => {
      if (!buildDriveCheckPayload()){ openDriveCheckEditor(false); return; }
      if (driveLoading) return;
      const fresh = lastDriveCheck && (Date.now() - lastDriveCheck.at) < DRIVE_CHECK_REUSE_MS;
      if (fresh && !driveError){ driveRowOpen = !driveRowOpen; renderDriveRow(); return; }
      runDriveCheck(true);
    });
    const again = el.querySelector('[data-drive-recheck]');
    if (again) again.addEventListener('click', () => runDriveCheck(true));
  }
  async function runDriveCheck(openAfter, fromAuto){
    if (!pwaWriteSecret){ driveError = 'Set the write secret first (Settings → Write secret).'; driveRowOpen = true; renderDriveRow(); return; }
    driveLoading = true; driveError = null; renderDriveRow();
    try{
      await fetchDriveCheckNow();
      if (openAfter) driveRowOpen = true;
      if (fromAuto) renderDriveBanner();
    } catch(e){
      driveError = e && e.message ? e.message : 'Offline?';
      if (openAfter) driveRowOpen = true;
    } finally {
      driveLoading = false;
      renderDriveRow();
    }
  }
  function driveBannerDismissedToday(){
    return loadJSON('drive-banner-dismissed', '') === fmtKey(new Date());
  }
  function renderDriveBanner(){
    const el = document.getElementById('live-drive-banner');
    if (!el || !overlay.isConnected) return;
    const d = lastDriveCheck && lastDriveCheck.data;
    if (!d || (d.status !== 'alert' && d.status !== 'clear') || driveBannerDismissedToday()){ el.innerHTML = ''; return; }
    const isAlert = d.status === 'alert';
    el.innerHTML = `
      <div class="ui-notice ${isAlert ? 'ui-notice-warn' : 'ui-notice-good'} live-drive-banner">
        <div>
          <div class="live-drive-banner-title ${isAlert ? 'ui-amber' : 'ui-good'}">${escapeHtml(d.title || '')}</div>
          <div>${escapeHtml(d.text || '')}</div>
          <div class="ui-dim">Checked ${escapeHtml(d.checkedAt || '')}</div>
        </div>
        <button type="button" class="ui-icon-btn" data-drive-dismiss aria-label="Dismiss">${UI_ICON_CLOSE}</button>
      </div>`;
    el.querySelector('[data-drive-dismiss]').addEventListener('click', () => {
      try{ localStorage.setItem('drive-banner-dismissed', JSON.stringify(fmtKey(new Date()))); }catch(e){}
      el.innerHTML = '';
    });
  }
  function maybeAutoDriveCheck(){
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    if (mins < DRIVE_AUTO_START_MIN || mins > DRIVE_AUTO_END_MIN) return;
    if (!driveCheckConfig.enabled || !driveCheckIsSetUp()) return;
    if (nonTravelLabelFor(fmtKey(now))) return; // weekend or tagged day — same rule as the watch
    if (driveBannerDismissedToday()) return;
    const recent = lastDriveCheck && (Date.now() - lastDriveCheck.at) < DRIVE_CHECK_REUSE_MS;
    if (recent){ renderDriveBanner(); return; }
    runDriveCheck(false, true);
  }

  function renderYoursTab(){
    bodyEl.innerHTML = `<div id="live-drive-banner"></div><div id="live-target-strip"></div><div id="live-drive-row" class="ui-gap-top-sm"></div><div id="live-board-content"></div><div class="live-status" id="live-board-status">Loading…</div>`;
    renderTargetStrip();
    renderDriveRow();
    maybeAutoDriveCheck();
    if (!yoursBoardsPromise) yoursBoardsPromise = fetchLiveBoards();
    yoursBoardsPromise.then(boards => {
      // The person may have switched to the other sub-tab, or closed the
      // screen entirely, while this was in flight.
      if (activeSubTab !== 'yours' || !overlay.isConnected) return;
      const amTrains = railTrains.filter(t => t.direction === 'AM').sort((a,b) => a.time.localeCompare(b.time));
      const pmTrains = railTrains.filter(t => t.direction === 'PM').sort((a,b) => a.time.localeCompare(b.time));
      const matchedServices = {}; // trainKey -> { train, service }

      function sectionHtml(trains){
        return trains.map(t => {
          const board = boards[`${t.fromLoc}-${t.toLoc}`] || [];
          const wanted = timeToHHMM(t.time);
          const service = board.find(s => s.std === wanted);
          if (service && !service.isCancelled) matchedServices[t.key] = { train: t, service };
          return rowForConfigured(t, service);
        }).join('');
      }

      const statusEl = document.getElementById('live-board-status');
      if (statusEl) statusEl.textContent = 'Live from National Rail. Tap a train for its progress; tap Live in the bar below to refresh.';
      const contentEl = document.getElementById('live-board-content');
      if (contentEl) contentEl.innerHTML = `
        <div class="ui-section-head"><span class="ui-label">Morning</span></div>
        <div class="ui-card ui-card-flush ui-train-list">${amTrains.length ? sectionHtml(amTrains) : '<div class="ui-empty">None configured</div>'}</div>
        <div class="ui-section-head"><span class="ui-label">Evening</span></div>
        <div class="ui-card ui-card-flush ui-train-list">${pmTrains.length ? sectionHtml(pmTrains) : '<div class="ui-empty">None configured</div>'}</div>
      `;
      document.querySelectorAll('#live-board-content [data-train-key]').forEach(row => {
        row.addEventListener('click', () => {
          const m = matchedServices[row.dataset.trainKey];
          if (m) openTrainProgress(m.train, m.service);
        });
      });
    }).catch(err => {
      if (activeSubTab !== 'yours' || !overlay.isConnected) return;
      const statusEl = document.getElementById('live-board-status');
      if (statusEl) statusEl.textContent = `Couldn't load live data: ${err.message}`;
    });
  }

  // ---- "Tracked" tab (everything tracked, plus adding a new one) ----
  function buildTrackedListHtml(){
    if (trackedTrains.length === 0){
      return `<div class="ui-empty">Nothing being tracked right now. Use "Track a train" above, or tap one of your usual trains — it'll keep working here even after it leaves the station.</div>`;
    }
    return `<div class="ui-card ui-card-flush">${trackedTrains.map(t => {
      const ageMin = Math.round((Date.now() - t.addedAt) / 60000);
      const ageLabel = ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin/60)} hr ago`;
      const errorMsg = trackedErrors[t.serviceId];
      const subLine = errorMsg
        ? `<div class="live-tracked-sub is-bad">${escapeHtml(errorMsg)}</div>`
        : `<div class="live-tracked-sub">Added ${ageLabel}</div>`;
      const refreshBtn = errorMsg
        ? `<button type="button" class="ui-icon-btn ui-icon-btn-good tracked-refresh-btn" data-refresh-service-id="${t.serviceId}" aria-label="Refresh">${REFRESH_ICON}</button>`
        : '';
      return `<div class="live-tracked-row" data-tracked-row="${t.serviceId}">
        <div class="live-tracked-main">
          <div class="live-tracked-label">${t.toLoc ? '<span class="ui-amber">★</span> ' : ''}${t.label}</div>
          ${subLine}
        </div>
        ${refreshBtn}
        <button type="button" class="ui-icon-btn ui-icon-btn-bad tracked-remove-btn" data-remove-service-id="${t.serviceId}" aria-label="Remove">${REMOVE_ICON}</button>
      </div>`;
    }).join('')}</div>`;
  }

  function wireTrackedList(){
    async function attemptOpen(serviceId){
      const tracked = trackedTrains.find(t => t.serviceId === serviceId);
      if (!tracked) return;
      const row = overlay.querySelector(`[data-tracked-row="${serviceId}"]`);
      if (row) row.style.opacity = '0.5';
      delete trackedErrors[serviceId];
      try{
        const service = await fetchServiceDetails(serviceId);
        if (!overlay.isConnected) return;
        // Re-check after the await, not just before it — if this train
        // was removed while the request was in flight, trackedTrains no
        // longer has it, and opening it now would silently re-add it via
        // openTrainProgress's own "remember this journey" logic, undoing
        // the removal the person deliberately just made.
        if (!trackedTrains.some(t => t.serviceId === serviceId)) return;
        overlay.remove();
        openTrainProgress({ label: tracked.label, fromLoc: tracked.fromLoc, toLoc: tracked.toLoc || null, serviceId, labelIsFinal: true }, service);
      }catch(e){
        if (!overlay.isConnected) return;
        if (e.transient){
          trackedErrors[serviceId] = `Couldn't reach Darwin — ${e.message}`;
          const listEl = document.getElementById('tracked-list');
          if (listEl) listEl.innerHTML = buildTrackedListHtml();
          wireTrackedList();
          return;
        }
        trackedTrains = trackedTrains.filter(t => t.serviceId !== serviceId);
        delete trackedErrors[serviceId];
        await saveTrackedTrains();
        const listEl = document.getElementById('tracked-list');
        if (listEl) listEl.innerHTML = buildTrackedListHtml();
        wireTrackedList();
        styleTabs();
      }
    }
    overlay.querySelectorAll('#tracked-list [data-tracked-row]').forEach(row => {
      row.addEventListener('click', () => attemptOpen(row.dataset.trackedRow));
    });
    overlay.querySelectorAll('#tracked-list [data-refresh-service-id]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); attemptOpen(btn.dataset.refreshServiceId); });
    });
    overlay.querySelectorAll('#tracked-list [data-remove-service-id]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const serviceId = btn.dataset.removeServiceId;
        trackedTrains = trackedTrains.filter(t => t.serviceId !== serviceId);
        delete trackedErrors[serviceId];
        await saveTrackedTrains();
        const listEl = document.getElementById('tracked-list');
        if (listEl) listEl.innerHTML = buildTrackedListHtml();
        wireTrackedList();
        styleTabs();
      });
    });
  }

  function wireAddFormResultRows(){
    overlay.querySelectorAll('[data-debug-service-id]').forEach(row => {
      row.addEventListener('click', async () => {
        const serviceId = row.dataset.debugServiceId;
        const label = row.dataset.debugLabel;
        const fromLoc = row.dataset.debugFrom;
        const schedTime = row.dataset.debugTime;
        const recoveryHint = schedTime
          ? { crs: fromLoc, boardType: row.dataset.debugDepartsHere === '1' ? 'dep' : 'arr', schedTime }
          : undefined;
        // Opening a train you've already got tracked just refreshes its
        // position — no new slot needed. Only a genuinely new one needs
        // checking against the cap, and needs checking *before* it's
        // added — the cap inside openTrainProgress enforces the limit
        // either way, but silently, by dropping whichever tracked train
        // is oldest. That's the right fallback for it being hit some
        // other way, but here, where the person's deliberately choosing
        // to track something new, they should find out and get the
        // choice, not lose an existing one without being told.
        const alreadyTracked = trackedTrains.some(t => t.serviceId === serviceId);
        if (!alreadyTracked && trackedTrains.length >= TRACKED_TRAIN_MAX){
          row.innerHTML = `<span class="live-result-msg">You're tracking ${TRACKED_TRAIN_MAX} already — remove one from the list below first.</span>`;
          return;
        }
        row.style.opacity = '0.5';
        row.style.pointerEvents = 'none';
        try{
          const service = await fetchServiceDetails(serviceId, recoveryHint);
          if (!overlay.isConnected) return;
          overlay.remove();
          openTrainProgress({ label, fromLoc, serviceId }, service);
        }catch(e){
          if (!overlay.isConnected) return;
          row.style.opacity = '1';
          row.style.pointerEvents = '';
          // Appended alongside the row's existing time/description/status
          // grid cells (grid-column:1/-1 spans it under all three) rather
          // than replacing them via innerHTML — the train itself is still
          // useful to see, the failure is additional information, not a
          // reason to hide what was already shown. Any message from an
          // earlier failed attempt on this same row is cleared first, so
          // repeated taps don't stack multiple lines underneath.
          const existingMsg = row.querySelector('.live-result-msg');
          if (existingMsg) existingMsg.remove();
          const msgEl = document.createElement('div');
          msgEl.className = 'live-result-msg';
          const minsAway = schedTime ? minutesUntilLocalTime(schedTime) : null;
          if (minsAway !== null && minsAway > LIKELY_NOT_YET_ACTIVATED_MIN_AWAY){
            msgEl.classList.add('is-dim');
            msgEl.textContent = `Not showing live details yet — booked for ${schedTime}, try again closer to departure.`;
          } else {
            msgEl.textContent = `Couldn't load that one (${e.message}) — tap to try again`;
          }
          row.appendChild(msgEl);
        }
      });
    });
  }

  function renderTrackedTab(){
    bodyEl.innerHTML = `
      ${showAddForm ? '' : `<button type="button" class="ui-btn-secondary ui-btn-block" id="tracked-add-toggle">Track a train</button>`}
      <div class="ui-card" id="tracked-add-form"${showAddForm ? '' : ' hidden'}>
        <div class="live-pickers" id="tracked-picker-row"></div>
        <div class="ui-field-help ui-gap-top-sm" id="tracked-station-list-status">Loading station list…</div>
        <div class="ui-sheet-actions">
          <button type="button" class="ui-btn-secondary" id="tracked-add-cancel">Cancel</button>
          <button type="button" class="ui-btn-primary" id="tracked-search-btn">Search</button>
        </div>
        <div id="tracked-search-results" class="ui-gap-top"></div>
      </div>
      <div class="ui-section-head"><span class="ui-label">Tracked</span></div>
      <div id="tracked-list">${buildTrackedListHtml()}</div>
    `;
    wireTrackedList();

    const addToggle = document.getElementById('tracked-add-toggle');
    if (addToggle) addToggle.addEventListener('click', () => {
      showAddForm = true;
      renderTrackedTab();
    });
    const addCancel = document.getElementById('tracked-add-cancel');
    if (addCancel) addCancel.addEventListener('click', () => {
      showAddForm = false;
      renderTrackedTab();
    });

    if (!showAddForm) return;

    const resultsEl = document.getElementById('tracked-search-results');
    // Restores whichever from/to stations were last searched (this app
    // session only — see lastTrackedSearch's own declaration), so
    // repeating the same lookup (e.g. checking the next available
    // service on a route already searched once) doesn't mean retyping
    // both stations from scratch every time the form is reopened.
    function saveLastSearch(fromCode, fromName, toCode, toName){
      lastTrackedSearch = { fromCode, fromName, toCode, toName };
    }
    const fromPicker = createStationPicker({
      placeholder: 'From: name or code',
      initialCode: lastTrackedSearch && lastTrackedSearch.fromCode,
      initialName: lastTrackedSearch && lastTrackedSearch.fromName,
      // Keeps lastTrackedSearch current the moment either field changes —
      // in particular the "X" clear button, so a clear is reflected
      // immediately if the person switches tabs and back, rather than
      // only once Search is next pressed.
      onChange: (code, name) => saveLastSearch(code, name, toPicker.getCode(), toPicker.getName())
    });
    const toPicker = createStationPicker({
      placeholder: 'To (optional)',
      initialCode: lastTrackedSearch && lastTrackedSearch.toCode,
      initialName: lastTrackedSearch && lastTrackedSearch.toName,
      onChange: (code, name) => saveLastSearch(fromPicker.getCode(), fromPicker.getName(), code, name)
    });
    document.getElementById('tracked-picker-row').appendChild(fromPicker.el);
    document.getElementById('tracked-picker-row').appendChild(toPicker.el);

    const stationStatusEl = document.getElementById('tracked-station-list-status');
    function stationListSummary(idx){
      const date = idx.fetchedAt ? new Date(idx.fetchedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'unknown date';
      return `${idx.list.length.toLocaleString()} stations · updated ${date}`;
    }
    function wireStationRefreshLink(){
      const el = document.getElementById('tracked-station-refresh-link');
      if (el) el.addEventListener('click', () => refreshStationList(true));
    }
    async function refreshStationList(force){
      if (!stationStatusEl.isConnected) return;
      stationStatusEl.textContent = force ? 'Refreshing station list…' : 'Loading station list…';
      try{
        const idx = await loadStationIndex(force);
        if (!stationStatusEl.isConnected) return;
        stationStatusEl.innerHTML = `${stationListSummary(idx)} — <span class="live-text-link" role="button" id="tracked-station-refresh-link">Refresh</span>`;
        wireStationRefreshLink();
      }catch(e){
        if (!stationStatusEl.isConnected) return;
        stationStatusEl.innerHTML = `Couldn't load the station list (${escapeHtml(e.message)}) — codes still work, just no name lookup yet. <span class="live-text-link" role="button" id="tracked-station-refresh-link">Try again</span>`;
        wireStationRefreshLink();
      }
    }
    refreshStationList(false);

    document.getElementById('tracked-search-btn').addEventListener('click', async () => {
      const fromCrs = fromPicker.getCode();
      const toCrs = toPicker.getCode();
      if (!fromCrs){
        resultsEl.innerHTML = `<div class="live-note">Pick a station to search from — type a name or a 3-letter code (e.g. EUS, BHM, GLC).</div>`;
        return;
      }
      if (trackedTrains.length >= TRACKED_TRAIN_MAX){
        resultsEl.innerHTML = `<div class="live-note">You're already tracking ${TRACKED_TRAIN_MAX} trains — remove one from the list below before adding another.</div>`;
        return;
      }
      const fromLabel = fromPicker.getName() || fromCrs;
      saveLastSearch(fromCrs, fromPicker.getName(), toCrs, toPicker.getName());
      resultsEl.innerHTML = `<div class="live-note">Searching…</div>`;
      try{
        const allServices = await fetchDebugBoard(fromCrs, toCrs);
        // Drop anything already sitting in the Tracked list below — no
        // point offering to track the same service twice, and it just
        // clutters the results with an entry tapping it would've
        // refreshed anyway rather than added.
        const services = allServices.filter(s => !trackedTrains.some(t => t.serviceId === s.serviceID));
        if (services.length === 0){
          resultsEl.innerHTML = allServices.length
            ? `<div class="live-note">No new services — every live result for that station is already in your Tracked list below.</div>`
            : `<div class="live-note">No live services found for that station right now.</div>`;
          return;
        }
        resultsEl.innerHTML = '<div class="ui-card ui-card-flush">' + services.slice(0, 15).map(s => {
          // Darwin's board here is combined arrivals+departures: a result
          // can be a service that departs FROM the searched station
          // (has std), or one that only arrives there — e.g. terminates
          // there — which has no std at all, only sta. Treating the
          // searched station as "the origin" regardless produced results
          // like "Manchester Victoria → Manchester Victoria" for a train
          // actually arriving there from Clitheroe. origin/destination
          // are always both present on the service itself no matter
          // which kind of board entry this is, so those — not which
          // station was searched from — are what determine the label.
          const departsHere = !!s.std;
          const origin = departsHere ? fromLabel : ((s.origin && s.origin[0] && s.origin[0].locationName) || '?');
          const dest = departsHere ? ((s.destination && s.destination[0] && s.destination[0].locationName) || '?') : fromLabel;
          const time = departsHere ? (s.std || '?') : (s.sta || s.eta || '?');
          // For an arrival-only record, `time` is when it arrives at
          // `dest`, not when it departs `origin` — spelled out in full
          // now rather than the more compact arrow format used for a
          // genuine departure, so it can't be misread as one. (The title
          // shown after actually tapping into one of these no longer
          // reuses this text either way — it's rebuilt from the real
          // calling points once they're available — but this is still
          // what's visible here in the results list itself.)
          const descriptionText = departsHere
            ? `Departure from ${origin} to ${dest}`
            : `Arrival at ${dest} from ${origin}`;
          const displayText = `${time} ${descriptionText}`;
          const liveField = departsHere ? s.etd : (s.eta || s.ata);
          const statusText = (!liveField || liveField === 'On time') ? 'On time' : liveField;
          // Three columns (time / description / status) rather than the
          // usual two — this description is a full sentence and can run
          // to two lines on a narrow phone screen, and a plain two-column
          // flex row put the status off awkwardly to the side of the
          // wrapped text rather than pinned cleanly to the top. Grid with
          // top alignment keeps time and status both anchored to the
          // first line regardless of how many lines the description
          // itself wraps to.
          // data-debug-time/data-debug-departs-here carry just enough to
          // rebuild a recoveryHint for fetchServiceDetails if
          // GetServiceDetails rejects this row's serviceID — the same
          // station (fromCrs) and schedule time already shown here, plus
          // which pure board (dep/arr) it'll actually be found on. Left
          // empty when time is '?' (no std/sta on this entry) so no
          // recovery is attempted rather than sending an invalid schedTime.
          return `<div class="live-result-row" data-debug-service-id="${s.serviceID}" data-debug-label="${escapeHtml(displayText)}" data-debug-from="${fromCrs}" data-debug-time="${time === '?' ? '' : escapeHtml(time)}" data-debug-departs-here="${departsHere ? '1' : '0'}">
            <span>${escapeHtml(time)}</span>
            <span>${escapeHtml(descriptionText)}</span>
            <span>${escapeHtml(statusText)}</span>
          </div>`;
        }).join('') + '</div>';
        wireAddFormResultRows();
      }catch(e){
        resultsEl.innerHTML = `<div class="live-note ui-bad">Search failed: ${escapeHtml(e.message)}</div>`;
      }
    });
  }

  // ---- "Emergency" tab (pre-defined fallback routes, checked live) ----
  function legTimeLabel(leg){
    if (leg.error) return `<span class="is-bad">${escapeHtml(leg.error)}</span>`;
    if (!leg.candidate){
      const boardNote = (leg.board && leg.board.length)
        ? `${leg.board.length} service${leg.board.length === 1 ? '' : 's'} on the board, none usable`
        : 'no services found';
      return `<span class="is-bad">Dead end — ${boardNote}</span>`;
    }
    const c = leg.candidate;
    const timeShown = (c.etd && c.etd !== 'On time') ? `${c.std} (now ${c.etd})` : c.std;
    const platformText = c.platform ? ` · Plat ${c.platform}` : '';
    const arrivalText = c.arrivalStr
      ? ` — due ${c.arrivalStr}`
      : (c.arrivalLookupFailed ? ' — arrival time unavailable, chain stops here' : '');
    return `Catch the ${timeShown}${platformText} to ${escapeHtml(leg.toName || leg.to)}${arrivalText}`;
  }

  function routeCardHtml(result, ri){
    const legsHtml = result.legs.map(leg => `
        <div class="live-leg">
          <div>${escapeHtml(leg.fromName || leg.from)} → ${escapeHtml(leg.toName || leg.to)}</div>
          <div class="live-leg-sub">${legTimeLabel(leg)}</div>
        </div>`).join('');
    const statusBadge = result.status === 'complete'
      ? '<span class="ui-pill ui-pill-good">Full plan</span>'
      : '<span class="ui-pill ui-pill-bad">Partial</span>';
    // Add to Tracked only offered once a full chained plan exists — a
    // partial/dead route has nothing complete enough to hand off to the
    // tracking flow.
    const addBtn = result.status === 'complete'
      ? `<span class="ui-link" role="button" data-add-route-idx="${ri}">Add to Tracked</span>`
      : '';
    // The overall-journey heading lives once per GROUP (groupHeadingHtml),
    // not per card — routes sharing the same origin/destination town are
    // clustered together, so repeating it on every card would be noise.
    return `
      <div class="ui-card">
        <div class="live-route-head"><span>${escapeHtml(result.label || 'Untitled route')}</span>${statusBadge}</div>
        ${legsHtml}
        ${addBtn}
      </div>`;
  }

  // A group heading in the holiday blue, so it reads as a distinct band
  // above the route cards that share that journey.
  function groupHeadingHtml(originName, destName){
    return `<div class="live-group-head">${escapeHtml(originName)} to ${escapeHtml(destName)}</div>`;
  }

  // Commits already-capacity-checked legs into trackedTrains, reusing
  // the exact same upsert-by-serviceId shape as the block inside
  // openTrainProgress (preserve addedAt for an already-tracked service,
  // otherwise stamp it fresh) — but deliberately WITHOUT that block's
  // trailing slice(0, TRACKED_TRAIN_MAX). Capacity here is guaranteed by
  // the caller (either there was already room, or the picker below freed
  // enough of it), so silently evicting the oldest entries would be
  // wrong — it could drop something the picker step just decided to keep.
  function commitEmergencyLegsToTracked(legs){
    for (const leg of legs){
      const existing = trackedTrains.find(t => t.serviceId === leg.serviceId);
      const addedAt = existing ? existing.addedAt : Date.now();
      trackedTrains = trackedTrains.filter(t => t.serviceId !== leg.serviceId);
      trackedTrains.unshift({ serviceId: leg.serviceId, label: leg.label, fromLoc: leg.fromLoc, toLoc: leg.toLoc, addedAt });
    }
    saveTrackedTrains();
  }

  // A short pick-what-to-drop confirmation, only shown when adding this
  // route's legs would exceed TRACKED_TRAIN_MAX. Requires selecting at
  // least `overflow` currently-tracked trains before Confirm is enabled
  // — per the spec, this never self-prunes by just dropping the oldest.
  function openEmergencyCapacityPicker(overflow, legsToAdd){
    // Stage 5: a bottom sheet (uiOpenSheet). Same rule as before: at least
    // `overflow` tracked trains must be ticked before Confirm is enabled.
    const selected = new Set();
    const sheet = uiOpenSheet('Make room to track this route', '<div id="emergency-drop-body"></div>');

    function render(){
      const body = sheet.sheet.querySelector('#emergency-drop-body');
      if (!body) return;
      const enoughSelected = selected.size >= overflow;
      body.innerHTML = `
        <div class="ui-sheet-sub">Adding this route needs ${legsToAdd.length} tracked train${legsToAdd.length === 1 ? '' : 's'}, but you're already at the ${TRACKED_TRAIN_MAX}-train limit. Choose at least ${overflow} to remove.</div>
        <div id="emergency-drop-list">${trackedTrains.map((t, i) => uiCheck(null, t.label, selected.has(i), { extra: `class="emergency-drop-checkbox" data-idx="${i}"` })).join('')}</div>
        <div class="ui-sheet-actions"><button type="button" class="ui-btn-primary" id="emergency-drop-confirm" ${enoughSelected ? '' : 'disabled'}>Remove selected and add route</button></div>`;
      body.querySelectorAll('.emergency-drop-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
          const idx = Number(cb.dataset.idx);
          if (cb.checked) selected.add(idx); else selected.delete(idx);
          render();
        });
      });
      body.querySelector('#emergency-drop-confirm').addEventListener('click', () => {
        if (!enoughSelected) return;
        trackedTrains = trackedTrains.filter((t, i) => !selected.has(i));
        commitEmergencyLegsToTracked(legsToAdd);
        sheet.close();
        // switchTab (not renderEmergencyTab) so the "Tracked (N)" counter
        // on the tab button refreshes and the person lands on the Tracked
        // tab to see what they just added (2026-09-16).
        switchTab('tracked');
      });
    }
    render();
  }

  function handleAddRouteToTracked(result){
    // TRACKED_TRAIN_MAX_AGE_MS is normally enforced once, at app load —
    // fine for a session that gets reloaded regularly, but Emergency
    // Routes is specifically for a PWA left open through a live,
    // possibly hours-long disruption. Re-pruning here means a genuinely
    // expired entry from earlier in that same session can't wrongly
    // count against the cap or show up as a removal option in the
    // capacity picker below.
    const now = Date.now();
    trackedTrains = trackedTrains.filter(t => (now - t.addedAt) < TRACKED_TRAIN_MAX_AGE_MS);

    const legsToAdd = result.legs
      .filter(leg => leg.candidate)
      .map(leg => ({
        serviceId: leg.candidate.serviceId,
        label: `${leg.candidate.std} ${leg.fromName || leg.from}→${leg.toName || leg.to}`,
        fromLoc: leg.from,
        toLoc: leg.to,
      }));
    if (!legsToAdd.length) return;
    // Legs whose service is already tracked are refreshed in place by
    // commitEmergencyLegsToTracked, not added again — they don't cost a
    // slot, so only the genuinely new ones count against the cap.
    const newCount = legsToAdd.filter(l => !trackedTrains.some(t => t.serviceId === l.serviceId)).length;
    const overflow = (trackedTrains.length + newCount) - TRACKED_TRAIN_MAX;
    if (overflow > 0){
      openEmergencyCapacityPicker(overflow, legsToAdd);
    } else {
      commitEmergencyLegsToTracked(legsToAdd);
      // switchTab (not renderEmergencyTab) so the "Tracked (N)" counter
      // refreshes and the person lands on the Tracked tab to see what
      // they just added (2026-09-16) — see the matching fix in
      // openEmergencyCapacityPicker's confirm handler above for the
      // overflow path.
      switchTab('tracked');
    }
  }

  // Reduces a station name to "the town it's in" for grouping purposes
  // — just the first word, lowercased. Crewe has one station so this is
  // just "crewe"; Wigan has two (Wallgate and North Western) that both
  // reduce to "wigan", which is exactly the point: Wayne's routes fan
  // out from/into different physical Wigan stations that all mean the
  // same thing for grouping ("this gets me to/from Wigan").
  // KNOWN LIMITATION: this would also merge, say, "Manchester Victoria"
  // and "Manchester Piccadilly" if either were ever used as a route's
  // actual start/end point (rather than just an intermediate leg, which
  // is all they are in Wayne's current routes) — there's no station
  // locality/grouping data available to do this more precisely, only
  // name and coordinates.
  function areaKeyFor(name){
    const n = (name || '').trim();
    return n ? n.split(/\s+/)[0].toLowerCase() : '';
  }

  // The same "first word" reduction as areaKeyFor, but keeping the
  // source station name's own casing — used for the group heading text.
  // Deliberately NOT any one member route's full station name: a group
  // can legitimately contain routes ending at different physical
  // stations in the same town (e.g. Wigan Wallgate and Wigan North
  // Western both group under "Wigan"), so showing one route's full name
  // on the heading would misrepresent the routes that end at the OTHER
  // station in that same group.
  function areaDisplayName(name){
    const n = (name || '').trim();
    return n ? n.split(/\s+/)[0] : name;
  }

  // Works out whether a result's route currently matches "the direction
  // I'm travelling right now" — before 12:00, that's routes that end at
  // Work (the AM commute); from 12:00 on, routes that end at Home (the
  // PM commute). Matched on each route's AUTHORED final destination
  // (alternativeRoutes, not the possibly-truncated result.legs — a
  // partial result's legs array stops wherever the chain died, which
  // isn't necessarily the route's real intended destination), and on
  // town (areaKeyFor) rather than exact station code — Wayne's own
  // routes fan out from/into different nearby stations (e.g. Wigan
  // Wallgate vs. Wigan North Western) that all still mean "going home"
  // or "going to work".
  function isPrimaryDirection(route){
    if (!route || !route.legs.length) return false;
    const isPM = londonParts(new Date()).hour >= 12;
    const targetStation = isPM ? homeStation : workStation;
    const lastLeg = route.legs[route.legs.length - 1];
    return areaKeyFor(lastLeg.toName || lastLeg.to) === areaKeyFor(targetStation.name);
  }

  // Groups routes that share the same overall journey (same start town,
  // same end town) under one heading, then sorts groups — matching-
  // direction groups first, then by how soon the soonest full plan in
  // that group actually arrives — and sorts routes within a group the
  // same way, with any partial/dead route pushed to the bottom since it
  // has no real arrival time to sort by.
  function groupedEmergencyResults(){
    if (!emergencyResults) return [];
    const routesChecked = emergencyRoutesChecked || alternativeRoutes;
    const groups = new Map();
    emergencyResults.forEach((result, originalIndex) => {
      // Isolated per result: a .forEach() callback that throws aborts
      // every remaining iteration silently, with nothing shown on
      // screen to say so — one malformed or unexpected result could
      // wipe out every route checked after it in the list without any
      // visible error. Catching per-item means the worst case is one
      // route missing, not everything from that point on.
      try{
        const route = routesChecked.find(r => r.id === result.id);
        if (!route || !route.legs.length) return;
        const firstLeg = route.legs[0];
        const lastLeg = route.legs[route.legs.length - 1];
        const originName = firstLeg.fromName || firstLeg.from;
        const destName = lastLeg.toName || lastLeg.to;
        const key = `${areaKeyFor(originName)}|${areaKeyFor(destName)}`;
        const lastResultLeg = result.legs[result.legs.length - 1];
        const arrivalTimestamp = (result.status === 'complete' && lastResultLeg && lastResultLeg.candidate)
          ? lastResultLeg.candidate.arrivalTimestamp
          : null;
        if (!groups.has(key)){
          groups.set(key, { originName: areaDisplayName(originName), destName: areaDisplayName(destName), primary: isPrimaryDirection(route), members: [] });
        }
        groups.get(key).members.push({ result, originalIndex, arrivalTimestamp });
      }catch(e){ /* one bad result shouldn't take the rest down with it */ }
    });

    const groupList = Array.from(groups.values());
    // Infinity - Infinity is NaN, not 0 — when every member of a group
    // is partial/dead (no real arrival time), the old subtraction-based
    // comparator could return NaN for a tied comparison. Sort behaviour
    // with a NaN-returning comparator isn't guaranteed consistent by
    // spec, so this compares explicitly instead of relying on arithmetic
    // that can produce NaN.
    function byArrival(a, b){
      const aVal = a.arrivalTimestamp ?? Infinity;
      const bVal = b.arrivalTimestamp ?? Infinity;
      if (aVal === bVal) return 0;
      return aVal - bVal;
    }
    groupList.forEach(g => {
      g.members.sort(byArrival);
      g.bestArrival = g.members.length ? (g.members[0].arrivalTimestamp ?? Infinity) : Infinity;
    });
    groupList.sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      return byArrival(a, b);
    });
    return groupList;
  }

  // A same-check, no-authoring-required safety net: disruption recovery
  // sometimes introduces or reinstates a direct service between Home
  // and Work that wouldn't normally run, and it's easy to be so focused
  // on authored alternative routes that a simple direct one gets missed
  // entirely. Built fresh every check (direction depends on the time of
  // day), never saved to alternativeRoutes — it's not something Wayne
  // authors or manages, just always checked alongside whatever he has.
  function buildDirectServiceRoutes(){
    // Both directions, always — not just whichever matches the current
    // time of day. Wayne asked for Home→Work "and vice versa" both to
    // be checked; only building the current-direction one silently
    // dropped the other direction entirely (it was never even attempted,
    // not a display bug — the "Checking N routes" count only ever
    // included +1 for this, never +2).
    return [
      { id: '__direct_service_home_to_work__', label: 'Direct service', legs: [{ from: homeStation.code, fromName: homeStation.name, to: workStation.code, toName: workStation.name }] },
      { id: '__direct_service_work_to_home__', label: 'Direct service', legs: [{ from: workStation.code, fromName: workStation.name, to: homeStation.code, toName: homeStation.name }] },
    ];
  }

  async function runEmergencyCheck(){
    if (emergencyChecking) return;
    emergencyChecking = true;
    renderEmergencyTab();
    try{
      const routesToCheck = [...alternativeRoutes, ...buildDirectServiceRoutes()];
      emergencyRoutesChecked = routesToCheck;
      emergencyResults = await checkAllEmergencyRoutes(routesToCheck);
    }catch(e){
      emergencyResults = [];
      emergencyRoutesChecked = [];
    }
    emergencyChecking = false;
    if (activeSubTab === 'emergency' && overlay.isConnected) renderEmergencyTab();
  }

  function renderEmergencyTab(){
    if (emergencyChecking){
      const totalToCheck = alternativeRoutes.length + 2;
      bodyEl.innerHTML = `<div class="ui-empty" id="emergency-status">Checking ${totalToCheck} route${totalToCheck === 1 ? '' : 's'}…</div>`;
      return;
    }
    // The direct-service check is always available (Home/Work stations
    // have sensible defaults), so there's no "nothing configured" state
    // that blocks the whole tab any more — just a gentle nudge when
    // there are no authored fallback routes to fall back on beyond it.
    const noRoutesNote = alternativeRoutes.length
      ? ''
      : `<div class="ui-notice ui-notice-info ui-gap-top">No fallback routes configured yet — showing the direct service only. Add some in Settings → Emergency routes for more coverage.</div>`;
    const groups = groupedEmergencyResults();
    const resultsHtml = groups.map(g => {
      const cardsHtml = g.members.map(({ result, originalIndex }) => routeCardHtml(result, originalIndex)).join('');
      return `<div>${groupHeadingHtml(g.originName, g.destName)}${cardsHtml}</div>`;
    }).join('');
    bodyEl.innerHTML = `
      <button type="button" class="ui-btn-secondary ui-btn-block" id="emergency-recheck-btn">${emergencyResults ? 'Recheck' : 'Check now'}</button>
      ${noRoutesNote}
      <div id="emergency-results">${resultsHtml}</div>
    `;
    document.getElementById('emergency-recheck-btn').addEventListener('click', runEmergencyCheck);
    bodyEl.querySelectorAll('[data-add-route-idx]').forEach(el => {
      el.addEventListener('click', () => handleAddRouteToTracked(emergencyResults[Number(el.dataset.addRouteIdx)]));
    });
    // Opening the tab runs the check automatically — this only fires
    // once per screen-open (emergencyResults is session-only, cleared
    // whenever the Live screen is reopened), matching the spec's
    // "triggered manually — opening the tab runs the check" behaviour
    // while still leaving Recheck available for a manual refresh.
    if (!emergencyResults) runEmergencyCheck();
  }

  function switchTab(tab){
    activeSubTab = tab;
    styleTabs();
    if (tab === 'yours') renderYoursTab();
    else if (tab === 'emergency') renderEmergencyTab();
    else renderTrackedTab();
  }

  tabYoursBtn.addEventListener('click', () => switchTab('yours'));
  tabTrackedBtn.addEventListener('click', () => switchTab('tracked'));
  if (tabEmergencyBtn) tabEmergencyBtn.addEventListener('click', () => switchTab('emergency'));
  styleTabs();
  switchTab(activeSubTab);

}
