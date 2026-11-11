// settings-trains.js — openRailConfig, Home & Work stations.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

function openRailConfig(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  // Edit a private copy. Add/remove/time changes should not affect the live
  // configuration until Save is pressed; Cancel must genuinely cancel.
  let draftTrains = railTrains.map(t => ({ ...t }));
  // 2026-09-18 — target-train alert settings, edited alongside the trains
  // and committed on the same Save. Held separately from draftTrains so the
  // existing draft/Save/Cancel behaviour for the times themselves is
  // untouched. draftAlertCheck: trainKey -> 'HH:MM' or '' (no alert);
  // draftDefaultTargets: { AM, PM } -> trainKey or '' (none). The 'change'
  // listeners below write into these as you go, so add/remove re-renders
  // don't lose an alert time you've just entered.
  const draftAlertCheck = {};
  railTrains.forEach(t => { draftAlertCheck[t.key] = (trainAlertConfig[t.key] && trainAlertConfig[t.key].checkTime) || ''; });
  const draftDefaultTargets = { AM: defaultTargetTrains.AM || '', PM: defaultTargetTrains.PM || '' };

  function buildSectionHtml(direction, title, fromLoc, toLoc){
    const trains = draftTrains.filter(t => t.direction === direction).sort((a, b) => a.time.localeCompare(b.time));
    const rows = trains.map(t => `
      <div style="margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <input type="time" class="rail-time-input" data-key="${t.key}" value="${t.time.slice(0,2)}:${t.time.slice(2,4)}" style="flex:1;" />
          <span class="modal-close" data-remove-key="${t.key}" style="margin:0; font-size:13px;">Remove</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:12px; color:var(--ink-dim); white-space:nowrap;">Watch alert at</span>
          <input type="time" class="rail-check-input" data-key="${t.key}" value="${draftAlertCheck[t.key] || ''}" style="flex:1;" />
          <span class="modal-close" data-clear-check-key="${t.key}" style="margin:0; font-size:13px;">Clear</span>
        </div>
      </div>`).join('');
    const defaultOptions = `<option value="">None — no alerts</option>` + trains.map(t =>
      `<option value="${t.key}" ${draftDefaultTargets[direction] === t.key ? 'selected' : ''}>${t.label}</option>`).join('');
    return `
      <div class="rail-col-header">${title} (${fromLoc} → ${toLoc})</div>
      <div id="rail-section-${direction}">${rows}</div>
      <div class="settings-link" id="rail-add-${direction}" style="margin-top:4px; margin-bottom:16px;">+ Add another time</div>
      <label style="display:block; font-size:13px; color:var(--ink-dim); margin-bottom:6px;">Default watch-alert train</label>
      <select class="rail-default-target" data-direction="${direction}" style="margin-bottom:18px;">${defaultOptions}</select>
    `;
  }

  function renderConfig(){
    overlay.innerHTML = `
      ${uiPageBar('Trains', { backId: 'rail-config-close', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'rail-config-save' })}
      <div class="ui-page-body">
        <div class="sub">Used to check delay repay eligibility on your travel days. Add every time you sometimes catch, not just your default.</div>
        <div class="sub">Watch alert: at the time set for a train, your watch checks how the day's target train is running and buzzes with on time / delayed / cancelled and the platform. Leave a train's time blank for no alert. You can switch tomorrow's target train on the Live screen.</div>
        ${buildSectionHtml('AM', 'Morning', 'CRE', 'WGN')}
        ${buildSectionHtml('PM', 'Evening', 'WGN', 'CRE')}
      </div>
    `;

    overlay.querySelector('#rail-add-AM').addEventListener('click', () => addTrain('AM'));
    overlay.querySelector('#rail-add-PM').addEventListener('click', () => addTrain('PM'));

    overlay.querySelectorAll('[data-remove-key]').forEach(el => {
      el.addEventListener('click', () => {
        draftTrains = draftTrains.filter(t => t.key !== el.dataset.removeKey);
        renderConfig();
      });
    });

    // 2026-09-18 — target-train alert inputs (see draftAlertCheck above).
    overlay.querySelectorAll('.rail-check-input').forEach(inp => {
      inp.addEventListener('change', () => { draftAlertCheck[inp.dataset.key] = inp.value || ''; });
    });
    overlay.querySelectorAll('[data-clear-check-key]').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.clearCheckKey;
        draftAlertCheck[key] = '';
        // Direct DOM update rather than renderConfig(), so an unsaved
        // change to a train's own time above isn't thrown away by a re-render.
        const inp = overlay.querySelector(`.rail-check-input[data-key="${key}"]`);
        if (inp) inp.value = '';
      });
    });
    overlay.querySelectorAll('.rail-default-target').forEach(sel => {
      sel.addEventListener('change', () => { draftDefaultTargets[sel.dataset.direction] = sel.value; });
    });

    overlay.querySelector('#rail-config-save').addEventListener('click', async () => {
      overlay.querySelectorAll('.rail-time-input').forEach(input => {
        const train = draftTrains.find(t => t.key === input.dataset.key);
        if (train && input.value){
          train.time = input.value.replace(':', '');
          train.label = input.value;
        }
      });

      // Invalidate cached performance only for a train whose ROUTE changed
      // (fromLoc/toLoc) — that's genuinely a different service. A pure
      // time-only edit (e.g. a timetable change retiming 08:08 to 08:10)
      // keeps the same key and its full history: the label above already
      // updated, and this is deliberately not treated as invalidating,
      // so Performance history continuity survives a retimed-but-otherwise-
      // unchanged usual train. A removed train (no newTrain) or a newly
      // added one (no oldTrain) has nothing to invalidate either way.
      const oldByKey = Object.fromEntries(railTrains.map(t => [t.key, t]));
      const newByKey = Object.fromEntries(draftTrains.map(t => [t.key, t]));
      const changedKeys = new Set();
      for (const key of new Set([...Object.keys(oldByKey), ...Object.keys(newByKey)])){
        const oldTrain = oldByKey[key];
        const newTrain = newByKey[key];
        if (!oldTrain || !newTrain) continue;
        if (oldTrain.fromLoc !== newTrain.fromLoc || oldTrain.toLoc !== newTrain.toLoc){
          changedKeys.add(key);
        }
      }
      if (changedKeys.size){
        for (const dateKey in railPerfCache){
          for (const key of changedKeys) delete railPerfCache[dateKey][key];
          if (Object.keys(railPerfCache[dateKey]).length === 0) delete railPerfCache[dateKey];
        }
        await saveRailPerfCache();
      }

      railTrains = draftTrains;

      // 2026-09-18 — commit the alert settings alongside the trains. Only
      // trains still present, with a valid time, keep an alert; a default
      // target that was removed (or set to None) means no alert for that
      // direction, and any override pointing at a removed train is dropped.
      overlay.querySelectorAll('.rail-check-input').forEach(inp => { draftAlertCheck[inp.dataset.key] = inp.value || ''; });
      overlay.querySelectorAll('.rail-default-target').forEach(sel => { draftDefaultTargets[sel.dataset.direction] = sel.value; });
      const nextAlertConfig = {};
      draftTrains.forEach(t => {
        const v = draftAlertCheck[t.key];
        if (v && ALERT_CHECK_TIME_PATTERN.test(v)){
          const prev = trainAlertConfig[t.key];
          nextAlertConfig[t.key] = { checkTime: v, earlyWarningLeadMin: (prev && typeof prev.earlyWarningLeadMin === 'number') ? prev.earlyWarningLeadMin : null };
        }
      });
      trainAlertConfig = nextAlertConfig;
      const nextDefaultTargets = {};
      ['AM', 'PM'].forEach(dir => {
        const k = draftDefaultTargets[dir];
        if (k && draftTrains.some(t => t.key === k && t.direction === dir)) nextDefaultTargets[dir] = k;
      });
      defaultTargetTrains = nextDefaultTargets;
      pruneTargetTrainOverrides();

      await saveRailTrains();
      await saveTrainAlertConfig();
      await saveTargetTrains();
      overlay.remove();
      railSyncMissingDates();
      if (cameFromSettings) openSettingsMenu(); else render();
    });
    overlay.querySelector('#rail-config-close').addEventListener('click', () => {
      overlay.remove();
      if (cameFromSettings) openSettingsMenu();
    });
  }

  function addTrain(direction){
    const fromLoc = direction === 'AM' ? 'CRE' : 'WGN';
    const toLoc = direction === 'AM' ? 'WGN' : 'CRE';
    const key = `${direction.toLowerCase()}-${Date.now()}`;
    draftTrains.push({ key, direction, fromLoc, toLoc, time: direction === 'AM' ? '0800' : '1700', label: direction === 'AM' ? '08:00' : '17:00' });
    renderConfig();
  }

  document.body.appendChild(overlay);
  renderConfig();
}

// Home/Work stations — the two ends of the commute, used to work out
// each Emergency route's "direction" for AM/PM grouping and sorting on
// the Emergency tab (see checkAllEmergencyRoutes's caller in
// openLiveScreen). A small dedicated screen rather than an inline
// Settings toggle, since it needs two full station pickers.
function openHomeWorkStationsManager(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  let draftHome = { ...homeStation };
  let draftWork = { ...workStation };

  function stationStatusHtml(){
    if (stationIndexCache){
      const date = stationIndexCache.fetchedAt ? new Date(stationIndexCache.fetchedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'unknown date';
      return `${stationIndexCache.list.length.toLocaleString()} stations · updated ${date}`;
    }
    return `Loading station list… codes still work meanwhile (e.g. CRE, WGN).`;
  }

  function render(){
    overlay.innerHTML = `
      ${uiPageBar('Home and work stations', { backId: 'hw-close', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'hw-save' })}
      <div class="ui-page-body">
        <div class="sub">Used to work out which Emergency routes get you home vs. to work, so the Emergency tab can group and sort them for whichever direction you're travelling in.</div>
        <div class="sub" style="font-size:11.5px; margin-bottom:12px;">${stationStatusHtml()}</div>
        <div class="rail-col-header" style="margin-bottom:4px;">Home station</div>
        <div id="hw-home-picker" style="margin-bottom:14px;"></div>
        <div class="rail-col-header" style="margin-bottom:4px;">Work station</div>
        <div id="hw-work-picker" style="margin-bottom:18px;"></div>
      </div>
    `;
    const homePicker = createStationPicker({
      placeholder: 'Home station',
      initialCode: draftHome.code,
      initialName: draftHome.name,
      onChange: (code, name) => { draftHome = { code, name }; }
    });
    const workPicker = createStationPicker({
      placeholder: 'Work station',
      initialCode: draftWork.code,
      initialName: draftWork.name,
      onChange: (code, name) => { draftWork = { code, name }; }
    });
    document.getElementById('hw-home-picker').appendChild(homePicker.el);
    document.getElementById('hw-work-picker').appendChild(workPicker.el);

    document.getElementById('hw-save').addEventListener('click', async () => {
      if (draftHome.code) { homeStation = draftHome; await saveHomeStation(); }
      if (draftWork.code) { workStation = draftWork; await saveWorkStation(); }
      overlay.remove();
      if (cameFromSettings) openSettingsMenu();
    });
    document.getElementById('hw-close').addEventListener('click', () => {
      overlay.remove();
      if (cameFromSettings) openSettingsMenu();
    });
  }

  document.body.appendChild(overlay);
  render();
  if (!stationIndexCache){
    loadStationIndex(false).then(() => { if (overlay.isConnected) render(); }).catch(() => { if (overlay.isConnected) render(); });
  }
}
