// backup-restore.js — Export, restore, history imports.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

function exportBackup(){
  const backup = { exportedAt: new Date().toISOString(), version: 1, data: {} };
  BACKUP_KEYS.forEach(k => {
    const v = localStorage.getItem(k);
    if (v !== null) backup.data[k] = v;
  });
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ticket-tracker-backup-${fmtKey(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function openBackupRestore(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const lastBackupLabel = lastDriveBackupTime
    ? new Date(lastDriveBackupTime).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'Never yet';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Backup &amp; restore</h3>
      <div class="sub">Export your app data to a file you can keep safe (e.g. before switching phones), or restore from a previous export. Restoring replaces all current data. Not included: your Worker write secret, the drive-check home location and the pass photo — re-enter those after restoring. Google normally stays connected; reconnect only if Automatic sign-in below says it's needed.</div>
      <button class="save-btn" id="backup-export-btn">Export backup</button>
      <label style="display:block; font-size:13px; color:var(--ink-dim); margin:16px 0 6px;">Restore from a backup file</label>
      <input type="file" id="backup-import-input" accept="application/json" style="margin-bottom:12px; width:100%;" />
      <button class="save-btn" id="backup-import-btn">Restore from file</button>
      <div id="backup-status" style="font-size:13px; color:var(--ink-dim); margin-top:10px;"></div>

      <div class="rail-col-header">Automatic Drive backup</div>
      <label style="display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:14px; color:var(--ink-dim); cursor:pointer;">
        <input type="checkbox" id="drive-backup-toggle" ${driveBackupEnabled ? 'checked' : ''} style="width:16px; height:16px;" />
        Automatically back up to Google Drive
      </label>
      <div class="sub" style="margin-bottom:10px;">Backs up whenever you leave the app, if something's changed and it's been at least 30 minutes since the last one. Keeps the 2 most recent backups in a "Ticket Tracker Backups" folder. Connect automatic sign-in once and backups run on their own from then on. If a backup still can't run and the last one is over a day old, a red banner will ask you to tap to back up.</div>
      <div id="drive-backup-status" style="font-size:13px; color:var(--ink-dim); margin-bottom:10px;">Last backup: ${lastBackupLabel}</div>
      <button class="save-btn" id="drive-backup-now-btn" ${driveBackupEnabled ? '' : 'disabled'}>Back up now</button>

      <div class="rail-col-header">Automatic sign-in</div>
      <div class="sub" style="margin-bottom:10px;">Google's sign-in only lasts about an hour. Connect once and your own Worker keeps it renewed, so backups (and Calendar updates) don't need a tap. You may see a "Google hasn't verified this app" screen — tap Advanced, then Go to Ticket Tracker.</div>
      <div id="google-worker-status" style="font-size:13px; color:var(--ink-dim); margin-bottom:10px;">${escapeHtml(googleWorkerStatusText())}</div>
      <button class="save-btn" id="google-connect-btn">${googleWorkerState() === 'connected' ? 'Reconnect automatic sign-in' : googleWorkerState() === 'needs-reconnect' ? 'Reconnect automatic sign-in' : 'Connect automatic sign-in'}</button>
      <div class="settings-link" id="google-disconnect-link" style="margin-top:10px; ${googleWorkerState() === 'connected' ? '' : 'display:none;'}">Disconnect automatic sign-in</div>

      <div class="rail-col-header">Share with Personal Finance</div>
      <label style="display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:14px; color:var(--ink-dim); cursor:pointer;">
        <input type="checkbox" id="transport-share-toggle" ${transportShareEnabled ? 'checked' : ''} style="width:16px; height:16px;" />
        Share estimates with Personal Finance
      </label>
      <div class="sub" style="margin-bottom:10px;">Saves your "Set aside on payday" figures for this pay period and the next 12 to a small file in your "Ticket Tracker Backups" Drive folder, for your Personal Finance app to read. Works with automatic backup off. Updates by itself when the figures change, whenever you open or leave the app. Turning this off stops updates; the last file stays in Drive.</div>
      <div id="transport-share-status" style="font-size:13px; color:var(--ink-dim); margin-bottom:10px;">${escapeHtml(transportShareStatusText())}</div>
      <button class="save-btn" id="transport-share-now-btn" ${transportShareEnabled ? '' : 'disabled'}>Share now</button>

      <div class="modal-close" id="backup-close-btn" style="margin-top:16px;">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('backup-export-btn').addEventListener('click', exportBackup);

  const driveToggle = document.getElementById('drive-backup-toggle');
  const driveStatus = document.getElementById('drive-backup-status');
  const driveNowBtn = document.getElementById('drive-backup-now-btn');

  driveToggle.addEventListener('change', async () => {
    if (driveToggle.checked){
      driveStatus.textContent = 'Connecting…';
      const token = await getGoogleAccessToken();
      if (!token){
        driveStatus.textContent = 'Could not connect to Google Drive.';
        driveToggle.checked = false;
        return;
      }
      driveBackupEnabled = true;
      await saveDriveBackupEnabled();
      driveNowBtn.disabled = false;
      driveStatus.textContent = 'Connected — running first backup…';
      const result = await attemptDriveBackup(true);
      driveStatus.textContent = result.ok
        ? `Last backup: ${new Date(lastDriveBackupTime).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
        : `First backup failed: ${driveBackupReasonText(result.reason)} — tap Back up now to retry`;
      renderBackupNudge();
    } else {
      driveBackupEnabled = false;
      await saveDriveBackupEnabled();
      driveNowBtn.disabled = true;
      driveStatus.textContent = 'Automatic backup turned off.';
    }
  });

  const googleStatusEl = document.getElementById('google-worker-status');
  const googleConnectBtn = document.getElementById('google-connect-btn');
  const googleDisconnectLink = document.getElementById('google-disconnect-link');
  const refreshGoogleWorkerUi = () => {
    const state = googleWorkerState();
    googleConnectBtn.textContent = (state === 'connected' || state === 'needs-reconnect') ? 'Reconnect automatic sign-in' : 'Connect automatic sign-in';
    googleDisconnectLink.style.display = state === 'connected' ? '' : 'none';
  };
  googleConnectBtn.addEventListener('click', async () => {
    const connectPromise = connectGoogleViaWorker(); // first — opens Google's popup off this tap
    googleConnectBtn.disabled = true;
    googleStatusEl.textContent = 'Connecting…';
    const r = await connectPromise;
    googleConnectBtn.disabled = false;
    googleStatusEl.textContent = r.message || googleWorkerStatusText();
    refreshGoogleWorkerUi();
    renderBackupNudge();
  });
  googleDisconnectLink.addEventListener('click', async () => {
    if (!confirm('Disconnect automatic sign-in? Backups will need a tap again until you reconnect.')) return;
    googleStatusEl.textContent = 'Disconnecting…';
    const r = await disconnectGoogleViaWorker();
    googleStatusEl.textContent = r.ok ? googleWorkerStatusText() : r.message;
    refreshGoogleWorkerUi();
  });

  // 2026-10-06 — Share with Personal Finance. Both handlers call
  // attemptTransportPublish() before anything is awaited, so Google's popup
  // (if a sign-in is needed) still has the tap behind it.
  const transportToggle = document.getElementById('transport-share-toggle');
  const transportStatus = document.getElementById('transport-share-status');
  const transportNowBtn = document.getElementById('transport-share-now-btn');
  const runTransportShare = async (busyText) => {
    const publishPromise = attemptTransportPublish({ interactive: true, force: true });
    transportNowBtn.disabled = true;
    transportStatus.textContent = busyText;
    const r = await publishPromise;
    transportNowBtn.disabled = !transportShareEnabled;
    transportStatus.textContent = r.ok ? transportShareStatusText() : `Couldn't share: ${r.reason} — tap Share now to retry`;
  };
  transportToggle.addEventListener('change', () => {
    transportShareEnabled = transportToggle.checked;
    saveTransportShareEnabled();
    if (transportShareEnabled){
      runTransportShare('Sharing…');
    } else {
      if (transportPublishTimer){ clearTimeout(transportPublishTimer); transportPublishTimer = null; }
      transportNowBtn.disabled = true;
      transportStatus.textContent = transportShareStatusText();
    }
  });
  transportNowBtn.addEventListener('click', () => { runTransportShare('Sharing…'); });

  driveNowBtn.addEventListener('click', async () => {
    driveStatus.textContent = 'Backing up…';
    const result = await attemptDriveBackup(true);
    driveStatus.textContent = result.ok
      ? `Last backup: ${new Date(lastDriveBackupTime).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      : `Backup failed: ${driveBackupReasonText(result.reason)} — tap Back up now to retry`;
    renderBackupNudge();
  });

  document.getElementById('backup-import-btn').addEventListener('click', () => {
    const fileInput = document.getElementById('backup-import-input');
    const status = document.getElementById('backup-status');
    const file = fileInput.files[0];
    if (!file){ status.textContent = 'Choose a file first.'; return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
      let parsed;
      try{ parsed = JSON.parse(e.target.result); }
      catch(err){ status.textContent = 'Could not read that file — is it a valid backup?'; return; }
      if (!parsed || typeof parsed.data !== 'object'){
        status.textContent = 'That doesn\'t look like a valid backup file.';
        return;
      }
      if (!confirm('This will replace all current app data with the contents of this backup. Continue?')){
        return;
      }
      // A restore is a replacement, not a merge. Clear known app data first
      // so keys that existed only in the current device cannot survive the restore.
      BACKUP_KEYS.forEach(key => {
        try{ localStorage.removeItem(key); }catch(err){ /* ignore individual key failures */ }
      });
      for (const key of BACKUP_KEYS){
        if (!Object.prototype.hasOwnProperty.call(parsed.data, key)) continue;
        try{ localStorage.setItem(key, parsed.data[key]); }catch(err){ /* ignore individual key failures */ }
      }
      status.textContent = 'Restored — reloading…';
      await loadData();
      document.body.removeChild(overlay);
      render();
    };
    reader.readAsText(file);
  });

  document.getElementById('backup-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}

function openImportHistory(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Bulk import comments</h3>
      <div class="sub">Paste a JSON object of date → comment entries — WFH, holidays, or anything else — e.g. from an old spreadsheet export. Existing entries for the same date are kept as-is; only blank dates get filled in.</div>
      <textarea id="import-textarea" rows="8" style="width:100%; background:var(--tile); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:10px; font-family:'Courier New',monospace; font-size:13px; margin-bottom:12px;" placeholder='{"2025-09-26": "WFH", "2025-11-10": "HOLIDAY"}'></textarea>
      <div id="import-status" style="font-size:13px; color:var(--ink-dim); margin-bottom:10px;"></div>
      <button class="save-btn" id="import-save-btn">Import</button>
      <div class="modal-close" id="import-close-btn">Cancel</div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('import-save-btn').addEventListener('click', async () => {
    const raw = document.getElementById('import-textarea').value.trim();
    const status = document.getElementById('import-status');
    if (!raw){
      status.textContent = 'Paste some JSON first.';
      status.style.color = 'var(--danger)';
      return;
    }
    let parsed;
    try{
      parsed = JSON.parse(raw);
    }catch(e){
      status.textContent = 'That is not valid JSON — check for missing quotes or commas.';
      status.style.color = 'var(--danger)';
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)){
      status.textContent = 'Expected a JSON object of "YYYY-MM-DD": "comment" pairs.';
      status.style.color = 'var(--danger)';
      return;
    }
    let added = 0;
    for (const key in parsed){
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      if (!comments[key]){
        comments[key] = String(parsed[key]);
        added++;
      }
    }
    await saveComments();
    document.body.removeChild(overlay);
    render();
  });

  document.getElementById('import-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}

// Bulk-inserts/updates delayClaims from Avanti's own claims-history table —
// used for the 2026-09 backfill against real bank/Avanti records, and
// reusable for any future top-up. Always sets status: 'confirmed', since
// the whole point of this screen is entering claims you've already
// verified as paid — it is not for logging a claim you've just started.
// Matches an existing delayClaims[date][dir] entry and updates it in
// place (adding claimRef/minutesLate, correcting amount if it differs)
// rather than creating a duplicate; entries with no existing match are
// added fresh. minutesLate: null marks a cancelled train, shown as
// "Cancelled" rather than a delay figure on the claims manager screen.
function openDelayClaimsImport(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Import delay repay claims</h3>
      <div class="sub">Paste a JSON array of claims from Avanti's claims history — each already verified as paid. Existing entries for the same date/direction are updated (claim ref, minutes late, amount corrected if needed); new ones are added. All entries are marked Confirmed. Include "trainKey" (e.g. "pm-1731") so the claim shows a scheduled time rather than just a direction.</div>
      <textarea id="claims-import-textarea" rows="8" style="width:100%; background:var(--tile); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:10px; font-family:'Courier New',monospace; font-size:12px; margin-bottom:12px;" placeholder='[{"date":"2026-09-14","dir":"AM","claimRef":"AWC-3242-966-216","amount":2.4,"minutesLate":16,"trainKey":"am-0727"}]'></textarea>
      <div id="claims-import-status" style="font-size:13px; color:var(--ink-dim); margin-bottom:10px;"></div>
      <button class="save-btn" id="claims-import-save-btn">Import</button>
      <div class="modal-close" id="claims-import-close-btn">Cancel</div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('claims-import-save-btn').addEventListener('click', async () => {
    const raw = document.getElementById('claims-import-textarea').value.trim();
    const status = document.getElementById('claims-import-status');
    if (!raw){
      status.textContent = 'Paste some JSON first.';
      status.style.color = 'var(--danger)';
      return;
    }
    let parsed;
    try{
      parsed = JSON.parse(raw);
    }catch(e){
      status.textContent = 'That is not valid JSON — check for missing quotes or commas.';
      status.style.color = 'var(--danger)';
      return;
    }
    if (!Array.isArray(parsed)){
      status.textContent = 'Expected a JSON array of claim entries.';
      status.style.color = 'var(--danger)';
      return;
    }
    let added = 0, updated = 0, skipped = 0;
    for (const entry of parsed){
      const dateKey = entry && entry.date;
      const dir = entry && entry.dir;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || (dir !== 'AM' && dir !== 'PM')){ skipped++; continue; }
      if (!delayClaims[dateKey]) delayClaims[dateKey] = {};
      const isNew = !delayClaims[dateKey][dir];
      const existing = delayClaims[dateKey][dir] || {};
      delayClaims[dateKey][dir] = {
        status: 'confirmed',
        minutesLate: (entry.minutesLate === null || entry.minutesLate === undefined) ? null : Number(entry.minutesLate),
        amount: Number(entry.amount) || existing.amount || 0,
        claimRef: entry.claimRef || existing.claimRef || '',
        trainKey: entry.trainKey || existing.trainKey || undefined,
        expiredAcknowledged: existing.expiredAcknowledged || false,
      };
      if (isNew) added++; else updated++;
    }
    await saveDelayClaims();
    status.textContent = `${added} added, ${updated} updated${skipped ? `, ${skipped} skipped (bad date/dir)` : ''}.`;
    status.style.color = 'var(--good)';
  });

  document.getElementById('claims-import-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}
