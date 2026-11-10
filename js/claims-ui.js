// claims-ui.js — Claim rows and handlers, claims manager, cancelled-band picker, pass photo.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

function openPassPhotoDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PASS_PHOTO_DB_NAME, PASS_PHOTO_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PASS_PHOTO_STORE)) db.createObjectStore(PASS_PHOTO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function savePassPhoto(blob){
  const db = await openPassPhotoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PASS_PHOTO_STORE, 'readwrite');
    tx.objectStore(PASS_PHOTO_STORE).put({ blob, type: blob.type, uploadedAt: new Date().toISOString() }, PASS_PHOTO_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getPassPhoto(){
  const db = await openPassPhotoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PASS_PHOTO_STORE, 'readonly');
    const req = tx.objectStore(PASS_PHOTO_STORE).get(PASS_PHOTO_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function deletePassPhoto(){
  const db = await openPassPhotoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PASS_PHOTO_STORE, 'readwrite');
    tx.objectStore(PASS_PHOTO_STORE).delete(PASS_PHOTO_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
// Silently puts the smartcard number on the clipboard the instant a
// claim starts — the actual fix for the window-switching problem, not
// a workaround for it. The number's ready to paste into Avanti's form
// the moment its page loads, with no need to ever switch back to this
// app for that specific step. Back to a single write, not a staged
// sequence — the earlier version also staged the ticket price as a
// second write, but that one was found to fail consistently in the
// real claim flow (two separate fix attempts didn't resolve it — see
// the backlog), while the smartcard number has always copied
// reliably. The claim notification shows the price now instead, so
// nothing's lost by dropping the attempt. Never throws: no number
// saved, or a denied/unavailable clipboard permission, just means the
// claim flow continues without it, same as every other best-effort
// step here.
async function copySmartcardToClipboard(){
  if (!smartcardNumber) return;
  try{ await navigator.clipboard.writeText(smartcardNumber); }
  catch(e){ /* clipboard unavailable or denied — nothing more to do */ }
}
// A plain, read-only notification — deliberately no action buttons, no
// attempt to copy anything from within it. Notification bodies aren't
// reliably text-selectable on Android, and a Service Worker (which is
// what would handle a tap on an action button) has no access to the
// clipboard at all — confirmed before building this, not assumed. This
// exists purely so the delay band(s) — the one thing you have to read
// and select rather than paste — stay glanceable from the notification
// shade while Avanti's page has the screen, covering whichever of
// AM/PM genuinely has a claim that day.
async function showClaimBandNotification(dateKey){
  try{
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!('serviceWorker' in navigator)) return;
    const dayClaims = delayClaims[dateKey] || {};
    const lines = ['AM', 'PM']
      .map(dir => isClaimBeingMade(dayClaims[dir]) && claimBandMinutes(dayClaims[dir]) !== null ? `${dir}: ${delayRepayBandLabel(claimBandMinutes(dayClaims[dir]))}` : null)
      .filter(Boolean);
    if (!lines.length) return;
    // Ticket price added alongside the band(s) — genuinely redundant
    // with the clipboard copy most of the time, but a visible backup is
    // worth having given the clipboard write for exactly this value was
    // found to fail silently in one real case.
    lines.push(`Ticket: £${getSeasonPriceForDate(dateKey).toFixed(2)}`);
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification('Delay repay claim', {
      body: lines.join('\n'),
      tag: `claim-${dateKey}`, // replaces any earlier notification for the same date rather than stacking duplicates
      icon: 'icons/icon-192.png',
    });
  }catch(e){ /* best-effort — the claim flow continues regardless */ }
}
// Drops a plain-text summary of today's claim(s) straight into the
// downloads folder, the same reliable way the pass photo already does
// — train, delay, ticket price, and payout for whichever of AM/PM
// applied. This is what actually survives the fact that there's no way
// back to this app's own claim screen once Avanti's site has taken
// over the window — a screenshot would need remembering to take one in
// the moment; this just always happens.
function triggerClaimDetailsDownload(dateKey){
  try{
    const dayClaims = delayClaims[dateKey] || {};
    const price = getSeasonPriceForDate(dateKey);
    const lines = [`Delay repay claim — ${dateLabel(parseKey(dateKey))}`, ''];
    ['AM', 'PM'].forEach(dir => {
      const claim = dayClaims[dir];
      if (!isClaimBeingMade(claim)) return;
      const confirmedKey = (confirmedTrains[dateKey] || {})[dir];
      const train = railTrains.find(t => t.key === confirmedKey);
      const trainLabel = train ? train.label : dir;
      lines.push(`${dir} — ${trainLabel}`);
      if (claim.minutesLate === null || claim.minutesLate === undefined){
        const band = claimBandMinutes(claim);
        lines.push(`  Train cancelled — claiming ${band !== null && band !== undefined ? delayRepayBandLabel(band) : 'band not chosen'}`);
        lines.push(`  Enter ${trainLabel} as your intended journey`);
      } else {
        lines.push(`  Delay: ${claim.minutesLate} minute${claim.minutesLate === 1 ? '' : 's'}`);
      }
      lines.push(`  Ticket price: £${price.toFixed(2)}`);
      lines.push(`  Estimated payout: £${claim.amount.toFixed(2)}`);
      lines.push('');
    });
    if (smartcardNumber) lines.push(`Smartcard number: ${smartcardNumber}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `claim-details-${dateKey}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }catch(e){ /* best-effort — the claim flow continues regardless */ }
}
// Runs the pass photo and claim-details downloads one after the other,
// clearly spaced apart, rather than firing both at once — Chrome tends
// to silently throttle multiple automatic downloads triggered in quick
// succession from the same interaction, and firing them close together
// once caused exactly that: the text file (a fully synchronous trigger)
// was completing before the photo download's own click ever fired,
// since that one has to wait on an IndexedDB read first. Photo goes
// first, since it's the one that actually needs attaching to Avanti's
// form — the text file is reference material, useful but not essential
// in the same way.
async function triggerAllClaimDownloads(dateKey){
  await triggerPassPhotoDownload();
  if (produceClaimDetailsFile){
    await new Promise(resolve => setTimeout(resolve, 600));
    triggerClaimDetailsDownload(dateKey);
  }
}
// Drops the saved pass photo straight into the downloads folder — named
// with today's date so repeat downloads stay distinguishable during an
// occasional manual tidy-up, with the extension matched to whatever was
// actually uploaded rather than assumed. Being the most recently
// downloaded file, it normally sorts first in a file/photo picker,
// without the app being able to pin it there directly. Silent in the
// sense of no extra tap or dialog — Android's own "file downloaded"
// notification is still outside any web app's control. Never throws:
// no photo saved (or a failed read) just means the claim flow continues
// without one, exactly as it always did before this existed.
async function triggerPassPhotoDownload(){
  let record;
  try{ record = await getPassPhoto(); }
  catch(e){ return; }
  if (!record || !record.blob) return;
  const ext = (record.type && record.type.includes('/')) ? record.type.split('/')[1].replace('jpeg', 'jpg') : 'jpg';
  const filename = `pass-photo-${fmtKey(new Date())}.${ext}`;
  const url = URL.createObjectURL(record.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoked shortly after rather than immediately — the object URL needs
  // to stay valid long enough for the download to actually complete.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function railDetailRows(trains, dayPerf){
  return trains.map(t => {
    const perf = dayPerf[t.key];
    if (!perf){
      return `<div class="rail-detail-row"><span>${t.label}</span><span style="color:var(--ink-dim);">No data</span></div>`;
    }
    const late = perfBreachesThreshold(perf);
    const color = late ? '#ff8b7e' : 'var(--good)';
    const text = railPerfStatusText(perf);
    return `<div class="rail-detail-row"><span style="color:${color}; font-weight:600;">${t.label}</span><span style="color:${color};">${text}</span></div>`;
  }).join('');
}

// 2026-10-27: day-sheet wording for one HSP record. Cancelled is checked
// first — delayMinutes is null for a cancelled train, and `null <= 0` is
// true in JS, which is how a cancelled 17:31 came to read "On time".
function railPerfStatusText(perf){
  if (perfIsCancelled(perf)) return 'Cancelled';
  if (perf.delayMinutes === null || perf.delayMinutes === undefined) return 'No data';
  return perf.delayMinutes <= 0 ? 'On time' : `${perf.delayMinutes} minute${perf.delayMinutes===1?'':'s'} delay`;
}

// Same as railDetailRows, but for the one train that was actually
// confirmed as ridden that day: if it was also delayed enough to claim
// and no claim has been started yet, it renders as a reversed, tappable
// pill. Once a claim exists (started or confirmed), it drops back to
// plain red text with a small checkmark — no longer tappable here, since
// the actual claimed/confirmed toggle now lives in its own menu screen
// rather than cluttering this view.
function railDetailRowsForClaim(trains, dayPerf, dateKey, direction){
  const confirmedKey = (confirmedTrains[dateKey] || {})[direction];
  return trains.map(t => {
    const perf = dayPerf[t.key];
    if (!perf){
      return `<div class="rail-detail-row"><span>${t.label}</span><span style="color:var(--ink-dim);">No data</span></div>`;
    }
    const late = perfBreachesThreshold(perf);
    if (t.key === confirmedKey && late){
      const claim = (delayClaims[dateKey] || {})[direction];
      const status = claim ? claim.status : null;
      if (!status){
        const delayText = railPerfStatusText(perf);
        return `<div class="rail-detail-row claimable-row" data-claim-date="${dateKey}" data-claim-direction="${direction}"
             style="cursor:pointer; margin:0 -10px; padding:8px 10px; background:#e05a4e; border-radius:8px; -webkit-user-select:none; user-select:none; touch-action:manipulation;">
          <span style="color:#14161f; font-weight:700;">${t.label}</span>
          <span style="color:#14161f;">${delayText}</span>
        </div>`;
      }
      // 2026-09-30: Not claiming — the delay still happened, so the time
      // stays, but the row goes quiet grey with the decision on it.
      if (status === 'declined'){
        return `<div class="rail-detail-row" style="flex-wrap:wrap; gap:2px 8px;">
          <span style="color:var(--ink-dim); font-weight:600;">${t.label}</span>
          <span style="color:var(--ink-dim);">Declined delay repay</span>
        </div>`;
      }
      if (status === 'expired'){
        const delayText = railPerfStatusText(perf);
        return `<div class="rail-detail-row">
          <span style="color:#ff8b7e; font-weight:600;">${t.label} <span style="color:var(--danger); font-size:11px; font-weight:700; margin-left:4px;">EXPIRED</span></span>
          <span style="color:#ff8b7e;">${delayText}</span>
        </div>`;
      }
      const checkColor = status === 'confirmed' ? '#3fb950' : '#8b949e';
      const delayText = railPerfStatusText(perf);
      return `<div class="rail-detail-row">
        <span style="color:#ff8b7e; font-weight:600;">${t.label} <span title="${status === 'confirmed' ? 'Claim confirmed' : 'Claim started'}">${checkCircleIcon(checkColor)}</span></span>
        <span style="color:#ff8b7e;">${delayText}</span>
      </div>`;
    }
    const color = late ? '#ff8b7e' : 'var(--good)';
    const text = railPerfStatusText(perf);
    return `<div class="rail-detail-row"><span style="color:${color}; font-weight:600;">${t.label}</span><span style="color:${color};">${text}</span></div>`;
  }).join('') + notClaimingButtonHtml(dateKey, direction);
}

// 2026-09-30 — sits under the Morning / Evening list, only when that
// direction has an unclaimed pill (confirmed train 15+ late, no record).
function notClaimingButtonHtml(dateKey, direction){
  if (!isDirectionClaimable(dateKey, direction)) return '';
  return `<div class="not-claiming-btn" data-claim-date="${dateKey}" data-claim-direction="${direction}">Not claiming</div>`;
}

// Wires up the claim pill inside a just-appended detail overlay. reopen()
// should close this overlay and re-show the same detail view fresh, so a
// tap is reflected immediately. Only fires for a train with no claim yet
// — once started/confirmed the row is plain text, not clickable.
// 2026-09-30: also wires the Not claiming buttons, and both now re-render
// the Home screen underneath so the header badge and blob update straight
// away (the overlay lives on document.body, so it survives render()).
function wireClaimHandlers(overlay, reopen){
  overlay.querySelectorAll('.not-claiming-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const dateKey = btn.dataset.claimDate;
      const dir = btn.dataset.claimDirection;
      const o = delayRepayOpportunities(dateKey).find(x => x.dir === dir);
      if (!o || o.claim) return; // already recorded meanwhile — nothing to decline
      if (!delayClaims[dateKey]) delayClaims[dateKey] = {};
      delayClaims[dateKey][dir] = {
        status: 'declined',
        minutesLate: o.minutesLate,
        amount: computeDelayRepayAmount(o.minutesLate, dateKey),
        trainKey: o.trainKey,
      };
      await saveDelayClaims();
      render();
      reopen();
    });
  });
  overlay.querySelectorAll('.claimable-row').forEach(row => {
    row.addEventListener('click', () => {
      const dateKey = row.dataset.claimDate;
      // 2026-10-27: a cancelled confirmed train has no delay figure, so its
      // band is picked by hand first. The band button's own tap then runs
      // the claim — keeping the clipboard copy and Avanti link inside a
      // fresh user gesture, exactly as a direct pill tap does.
      const cancelledDirs = delayRepayOpportunities(dateKey).filter(o => o.cancelled && !o.claim).map(o => o.dir);
      if (cancelledDirs.length){
        openCancelledBandPicker(dateKey, cancelledDirs, (bandByDir) => startDelayClaimForDate(dateKey, bandByDir, reopen));
        return;
      }
      startDelayClaimForDate(dateKey, {}, reopen);
    });
  });
}

// 2026-10-27: starts the claim for every claimable direction on a date.
// bandByDir supplies the hand-picked band (15 / 30 / 60) for any cancelled
// direction; a cancelled direction without one is skipped.
async function startDelayClaimForDate(dateKey, bandByDir, reopen){
      // Clipboard write kicked off first, immediately — before anything
      // else (saveDelayClaims's own await, opening the external link)
      // gets a chance to erode the trusted-gesture window it needs.
      copySmartcardToClipboard();
      // One tap covers the whole day — if both AM and PM had a confirmed
      // delay, both get marked 'started' together, since realistically
      // you'll be dealing with both while you're on Avanti's site anyway.
      if (!delayClaims[dateKey]) delayClaims[dateKey] = {};
      ['AM', 'PM'].forEach(dir => {
        const confirmedKey = (confirmedTrains[dateKey] || {})[dir];
        if (!confirmedKey) return;
        const perf = (railPerfCache[dateKey] || {})[confirmedKey];
        if (!perfBreachesThreshold(perf)) return;
        // 2026-09-30: leave ANY existing record alone — previously only a
        // 'confirmed' one was protected, which would have flipped a
        // direction marked Not claiming (or an expired one) back to started.
        if (delayClaims[dateKey][dir]) return;
        if (perfIsCancelled(perf)){
          const band = bandByDir[dir];
          if (typeof band !== 'number') return;
          delayClaims[dateKey][dir] = {
            status: 'started',
            minutesLate: null, // cancelled — no HSP delay figure
            bandMinutes: band,
            amount: cappedDelayRepayAmount(band, dateKey, dir),
            trainKey: confirmedKey,
            expiredAcknowledged: false,
          };
          return;
        }
        delayClaims[dateKey][dir] = {
          status: 'started',
          minutesLate: perf.delayMinutes,
          amount: cappedDelayRepayAmount(perf.delayMinutes, dateKey, dir),
          trainKey: confirmedKey,
          expiredAcknowledged: false,
        };
      });
      await saveDelayClaims();
      openExternalLink(AVANTI_CLAIM_URL);
      // After opening the claim site, not before — this needs to stay as
      // close to the original tap as possible to avoid the popup blocker
      // treating it as unrelated to a user gesture. Everything below
      // isn't nearly as timing-sensitive, so it's safe to let those run
      // right after instead.
      triggerAllClaimDownloads(dateKey);
      showClaimBandNotification(dateKey);
      render();
      reopen();
}

// 2026-10-27: band picker for a cancelled confirmed train. The real delay
// depends on what was caught instead (e.g. an earlier delayed service, or
// a substitute that started further along), which the app can't see — so
// Wayne picks the band for the delay he actually had. onPick runs from the
// band button's own click, keeping it a trusted user gesture.
function openCancelledBandPicker(dateKey, dirs, onPick){
  const picker = document.createElement('div');
  picker.className = 'modal-overlay';
  picker.style.zIndex = '60'; // above the day-detail sheet (.modal-overlay is 50)
  const chosen = {};
  const bands = [15, 30, 60, 120];
  const dirLabel = (dir) => {
    const key = (confirmedTrains[dateKey] || {})[dir];
    const train = railTrains.find(t => t.key === key);
    return `${train ? train.label : dir} (${dir === 'AM' ? 'morning' : 'evening'})`;
  };
  const rowsHtml = dirs.map(dir => `
    <div style="margin-bottom:14px;">
      <div style="font-weight:600; margin-bottom:6px;">${dirLabel(dir)} — cancelled</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${bands.map(b => `<div class="band-pick-btn" data-dir="${dir}" data-band="${b}"
          style="flex:1 1 calc(50% - 4px); box-sizing:border-box; text-align:center; padding:10px 8px; border-radius:8px; border:1px solid var(--line); background:var(--tile); color:var(--ink); cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">${delayRepayBandLabel(b)}<div style="font-size:11px; color:var(--ink-dim); margin-top:2px;">£${cappedDelayRepayAmount(b, dateKey, dir).toFixed(2)}</div></div>`).join('')}
      </div>
    </div>`).join('');
  picker.innerHTML = `
    <div class="modal">
      <h3>Choose your delay band</h3>
      <div class="sub" style="margin-bottom:14px;">Your train was cancelled — choose the band for the delay you actually experienced, measured from when your planned train should have arrived. Enter the planned train as your intended journey on Avanti's form.</div>
      ${rowsHtml}
      <div class="modal-close" id="band-pick-cancel" style="text-align:center; margin-top:4px;">Cancel</div>
    </div>`;
  document.body.appendChild(picker);
  const close = () => picker.remove();
  picker.querySelector('#band-pick-cancel').addEventListener('click', close);
  picker.addEventListener('click', (e) => { if (e.target === picker) close(); });
  picker.querySelectorAll('.band-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chosen[btn.dataset.dir] = Number(btn.dataset.band);
      picker.querySelectorAll(`.band-pick-btn[data-dir="${btn.dataset.dir}"]`).forEach(b => {
        const on = b === btn;
        b.style.background = on ? 'var(--amber)' : 'var(--tile)';
        b.style.color = on ? '#14161f' : 'var(--ink)';
      });
      // Once every cancelled direction has a band, this tap starts the claim.
      if (dirs.every(d => typeof chosen[d] === 'number')){
        close();
        onPick({ ...chosen });
      }
    });
  });
}

// Lists every day with a delay repay claim on record, most recent first,
// each with a checkbox to mark it as genuinely submitted/confirmed —
// separated out from the day-detail views so those stay simple and this
// stays a proper focused screen for managing claims.
function openDelayClaimsManager(){
  const entries = [];
  for (const dateKey in delayClaims){
    for (const dir in delayClaims[dateKey]){
      const claim = delayClaims[dateKey][dir];
      if (!claim) continue;
      const confirmedKey = (confirmedTrains[dateKey] || {})[dir] || claim.trainKey;
      const train = railTrains.find(t => t.key === confirmedKey);
      entries.push({ dateKey, dir, claim, label: train ? train.label : dir });
    }
  }
  entries.sort((a, b) => b.dateKey < a.dateKey ? -1 : (b.dateKey > a.dateKey ? 1 : 0));

  const rowsHtml = entries.length ? entries.map(e => {
    // 2026-09-30: declined and never-claimed-then-expired entries have no
    // Avanti reference to record, so no input for them.
    const isDeclined = e.claim.status === 'declined';
    const noRefField = isDeclined || !!e.claim.unclaimed;
    return `
    <div class="rail-detail-row" style="align-items:flex-start; padding:10px 0;">
      <div style="flex:1; min-width:0;">
        <div style="font-weight:600;">${dateLabel(parseKey(e.dateKey))}</div>
        <div style="font-size:12px; color:var(--ink-dim); margin-top:2px;">${e.label} (${e.dir}) — ${e.claim.minutesLate === null || e.claim.minutesLate === undefined ? `Cancelled${typeof e.claim.bandMinutes === 'number' ? ` (${delayRepayBandLabel(e.claim.bandMinutes)})` : ''}` : `${e.claim.minutesLate} min late`} — £${(e.claim.amount || 0).toFixed(2)}${e.claim.unclaimed ? ' — never claimed' : ''}</div>
        ${(e.claim.status === 'started' && e.claim.claimRef && e.claim.submittedAt) ? (() => {
          const dueKey = fmtKey(addDays(parseKey(e.claim.submittedAt), DELAY_REPAY_RESPONSE_DAYS));
          const overdue = fmtKey(new Date()) >= dueKey;
          return `<div style="font-size:12px; margin-top:2px; color:${overdue ? 'var(--danger)' : 'var(--amber)'};">Claimed ${dateLabelShort(parseKey(e.claim.submittedAt))} · reply due ${dateLabelShort(parseKey(dueKey))}${overdue ? ' — chase Avanti' : ''}</div>`;
        })() : ''}
        ${noRefField ? '' : `<input type="text" class="claim-ref-input" data-claim-date="${e.dateKey}" data-claim-direction="${e.dir}" value="${escapeHtml(e.claim.claimRef || '')}" placeholder="AWC reference" style="margin-top:6px; width:100%; max-width:220px; font-size:12px; font-family:monospace; padding:6px 8px; background:var(--tile); color:var(--ink); border:1px solid var(--line); border-radius:6px;" />`}
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        ${e.claim.status === 'expired' ? `
        <span style="font-size:12px; color:var(--danger); font-weight:600; white-space:nowrap;">Expired</span>
        ` : isDeclined ? `
        <span style="font-size:12px; color:var(--ink-dim); font-weight:600; white-space:nowrap;">Declined</span>
        <span class="claim-undo-link" data-claim-date="${e.dateKey}" data-claim-direction="${e.dir}" style="font-size:11px; color:var(--ink-dim); text-decoration:underline; cursor:pointer;">Undo</span>
        ` : `
        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:${e.claim.status==='confirmed' ? 'var(--good)' : 'var(--ink-dim)'}; cursor:pointer; white-space:nowrap;">
          <input type="checkbox" class="claim-confirm-checkbox" data-claim-date="${e.dateKey}" data-claim-direction="${e.dir}" ${e.claim.status==='confirmed'?'checked':''} style="width:15px; height:15px;" />
          Confirmed
        </label>
        <span class="claim-undo-link" data-claim-date="${e.dateKey}" data-claim-direction="${e.dir}" style="font-size:11px; color:var(--ink-dim); text-decoration:underline; cursor:pointer;">Undo</span>
        `}
      </div>
    </div>
  `;
  }).join('') : `<div class="sub" style="margin-top:0;">No claims started yet — tap a red delay entry on any day to begin one.</div>`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Delay repay claims</h3>
      <div class="sub">Tick a claim off once you've actually submitted and it's been accepted — not just when you've opened the link.</div>
      ${rowsHtml}
      <div class="modal-close" id="delay-claims-close-btn" style="margin-top:16px;">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.claim-confirm-checkbox').forEach(cb => {
    cb.addEventListener('change', async () => {
      const dateKey = cb.dataset.claimDate;
      const dir = cb.dataset.claimDirection;
      if (!delayClaims[dateKey] || !delayClaims[dateKey][dir]) return;
      delayClaims[dateKey][dir].status = cb.checked ? 'confirmed' : 'started';
      await saveDelayClaims();
      render(); // 2026-09-30: keep the header badge in step
      document.body.removeChild(overlay);
      openDelayClaimsManager();
    });
  });
  overlay.querySelectorAll('.claim-undo-link').forEach(link => {
    link.addEventListener('click', async () => {
      const dateKey = link.dataset.claimDate;
      const dir = link.dataset.claimDirection;
      if (delayClaims[dateKey]){
        delete delayClaims[dateKey][dir];
        if (Object.keys(delayClaims[dateKey]).length === 0) delete delayClaims[dateKey];
      }
      await saveDelayClaims();
      render();
      document.body.removeChild(overlay);
      openDelayClaimsManager();
    });
  });
  // Saved on blur rather than per-keystroke — matches the checkbox/undo
  // handlers' full-remount pattern, and blur already means the person has
  // moved on from the field so there's no cursor position to preserve.
  // 2026-09-30: a reference marks a started claim as submitted, which takes
  // it off the badge countdown — re-render Home underneath so that shows.
  overlay.querySelectorAll('.claim-ref-input').forEach(input => {
    input.addEventListener('blur', async () => {
      const dateKey = input.dataset.claimDate;
      const dir = input.dataset.claimDirection;
      if (!delayClaims[dateKey] || !delayClaims[dateKey][dir]) return;
      const trimmed = input.value.trim();
      const existing = delayClaims[dateKey][dir].claimRef || '';
      if (trimmed === existing) return; // no change — don't re-save/re-render
      delayClaims[dateKey][dir].claimRef = trimmed;
      // 2026-10-01: the day the reference first goes in is the day the claim
      // was made — Avanti's 20-day reply countdown runs from it. Editing an
      // existing reference keeps the original date; clearing it drops it.
      if (!trimmed) delete delayClaims[dateKey][dir].submittedAt;
      else if (!existing && !delayClaims[dateKey][dir].submittedAt) delayClaims[dateKey][dir].submittedAt = fmtKey(new Date());
      await saveDelayClaims();
      render();
    });
  });
  document.getElementById('delay-claims-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}

function openPassPhotoManager(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Smartcard pass</h3>
      <div class="sub">Photo and smartcard number, kept together — everything needed to start a delay repay claim.</div>
      <div id="pass-photo-preview-wrap" style="margin:14px 0; text-align:center;"></div>
      <input type="file" accept="image/*" id="pass-photo-input" style="display:none;" />
      <button class="save-btn" id="pass-photo-choose-btn">Choose photo</button>
      <div id="pass-photo-remove-wrap" style="text-align:center; margin-top:10px; display:none;">
        <span id="pass-photo-remove-link" style="font-size:12px; color:#ff8b7e; text-decoration:underline; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">Remove saved photo</span>
      </div>
      <div class="sub" style="margin-top:20px; margin-bottom:4px;">Smartcard number</div>
      <input type="text" id="smartcard-number-input" value="${escapeHtml(smartcardNumber)}" maxlength="${SMARTCARD_NUMBER_MAX_LENGTH}" placeholder="e.g. 302012345678901234" style="font-family:monospace;" />
      <button class="save-btn" id="smartcard-number-save-btn" style="margin-top:10px;">Save number</button>
      <div class="modal-close" id="pass-photo-close-btn" style="margin-top:16px;">${cameFromSettings ? '← Back to Settings' : 'Close'}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const previewWrap = document.getElementById('pass-photo-preview-wrap');
  const removeWrap = document.getElementById('pass-photo-remove-wrap');

  async function refreshPreview(){
    previewWrap.innerHTML = `<div class="sub" style="margin-top:0;">Loading…</div>`;
    try{
      const record = await getPassPhoto();
      if (!overlay.isConnected) return;
      if (record && record.blob){
        const url = URL.createObjectURL(record.blob);
        const uploadedDate = record.uploadedAt ? new Date(record.uploadedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '';
        previewWrap.innerHTML = `
          <img src="${url}" style="max-width:100%; max-height:220px; border-radius:8px; border:1px solid var(--line);" />
          <div class="sub" style="margin-top:8px;">Saved ${uploadedDate}</div>
        `;
        removeWrap.style.display = 'block';
      } else {
        previewWrap.innerHTML = `<div class="sub" style="margin-top:0;">No photo saved yet.</div>`;
        removeWrap.style.display = 'none';
      }
    }catch(e){
      if (!overlay.isConnected) return;
      previewWrap.innerHTML = `<div class="sub" style="margin-top:0; color:#ff8b7e;">Couldn't load the saved photo (${escapeHtml(e.message)}).</div>`;
    }
  }
  refreshPreview();

  document.getElementById('pass-photo-choose-btn').addEventListener('click', () => {
    document.getElementById('pass-photo-input').click();
  });
  document.getElementById('pass-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    previewWrap.innerHTML = `<div class="sub" style="margin-top:0;">Saving…</div>`;
    try{
      await savePassPhoto(file); // a File is already a Blob — stores directly, no conversion needed
      await refreshPreview();
    }catch(err){
      if (!overlay.isConnected) return;
      previewWrap.innerHTML = `<div class="sub" style="margin-top:0; color:#ff8b7e;">Couldn't save that photo (${escapeHtml(err.message)}).</div>`;
    }
  });
  document.getElementById('pass-photo-remove-link').addEventListener('click', async () => {
    try{ await deletePassPhoto(); }catch(e){ /* nothing meaningful to surface if this fails */ }
    await refreshPreview();
  });
  document.getElementById('smartcard-number-save-btn').addEventListener('click', async () => {
    const val = document.getElementById('smartcard-number-input').value.trim();
    smartcardNumber = val.slice(0, SMARTCARD_NUMBER_MAX_LENGTH);
    await saveSmartcardNumber();
    document.body.removeChild(overlay);
    if (cameFromSettings) openSettingsMenu(); else render();
  });

  document.getElementById('pass-photo-close-btn').addEventListener('click', () => {
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
