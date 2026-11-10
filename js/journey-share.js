// journey-share.js — Copy for WhatsApp, silent-confirm and catch-up banners.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// ---- Silent-confirm banner ----
// Lives entirely outside the normal render() cycle, as its own
// fixed-position element appended once at startup — render() rebuilds
// #app wholesale on every call, and this needs to stay visible and
// stable across that (including while a full-screen modal like train
// progress is open), not get wiped out and rebuilt with it. Mounted
// once in init(); after that, only mountSilentConfirmBanner()'s own
// dismiss handler and renderSilentConfirmBanner() (called whenever
// silentConfirmBanner changes) ever touch it again.
function mountSilentConfirmBanner(){
  const el = document.createElement('div');
  el.id = 'silent-confirm-banner';
  el.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:200; display:none; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; padding-top:calc(10px + env(safe-area-inset-top)); background:rgba(111,191,138,0.92); color:#0f2a1a; font-size:13.5px; font-weight:600; box-shadow:0 2px 8px rgba(0,0,0,0.25);';
  el.innerHTML = `
    <span id="silent-confirm-banner-text"></span>
    <span style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
      <button id="silent-confirm-banner-copy" type="button" style="display:none; background:#0f2a1a; color:#e3f4e9; border:none; border-radius:6px; padding:6px 10px; font:inherit; font-size:12.5px; font-weight:700; white-space:nowrap; cursor:pointer; touch-action:manipulation;">Copy for WhatsApp</button>
      <span id="silent-confirm-banner-dismiss" style="cursor:pointer; font-weight:800; font-size:16px; line-height:1; padding:6px 8px; margin:-6px -6px -6px 0; -webkit-user-select:none; user-select:none; touch-action:manipulation;">×</span>
    </span>
  `;
  document.body.appendChild(el);
  // 2026-09-27: Copy for WhatsApp. Synchronous up to the clipboard write —
  // the text was built beforehand by refreshJourneyText.
  document.getElementById('silent-confirm-banner-copy').addEventListener('click', () => {
    const b = silentConfirmBanner, p = pendingJourneyText;
    if (!b || !p || p.dateKey !== b.dateKey || p.trainKey !== b.trainKey) return;
    copyJourneyText(p.text, p.dateKey, p.trainKey, b.label, 'banner');
  });
  document.getElementById('silent-confirm-banner-dismiss').addEventListener('click', () => {
    silentConfirmBanner = null;
    saveSilentConfirmBanner();
    renderSilentConfirmBanner();
  });
  renderSilentConfirmBanner(); // reflect whatever was loaded from storage
}
function renderSilentConfirmBanner(){
  const el = document.getElementById('silent-confirm-banner');
  const textEl = document.getElementById('silent-confirm-banner-text');
  if (!el || !textEl) return;
  if (silentConfirmBanner){
    // source suffix is a temporary visibility aid while the watch
    // detection path is being tested in the field — easy single-line
    // removal (see silentConfirmBanner's own doc comment) once it's
    // proven reliable and this stops being interesting to see.
    const sourceSuffix = silentConfirmBanner.source === 'watch' ? ' (via watch)'
      : silentConfirmBanner.source === 'phone' ? ' (via phone)' : '';
    textEl.textContent = `Confirmed: your usual ${silentConfirmBanner.label}${sourceSuffix}`;
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
  // 2026-09-27: Copy for WhatsApp button — only while there's fresh text
  // for exactly this banner's train and it hasn't been copied/abandoned.
  noteJourneyTextTarget();
  const copyBtn = document.getElementById('silent-confirm-banner-copy');
  if (copyBtn){
    const t = bannerJourneyTarget();
    const ready = !!(t && pendingJourneyText && pendingJourneyText.dateKey === t.dateKey && pendingJourneyText.trainKey === t.trainKey);
    copyBtn.style.display = ready ? 'inline-block' : 'none';
  }
  renderCatchupBanner(); // restacks itself below this banner, and cascades into renderBackupNudge below that
}

// ---- Copy for WhatsApp (2026-09-27, whatsapp-share-design.md) ----
// Evening journeys only. Puts a ready-made message on the clipboard for
// pasting into the family WhatsApp group — from the green banner's button,
// the "Is this your train?" Yes tap, or a Confirm-train Save. No live data
// means no copy at all; Wayne types it himself then.
//
// Live data comes from the destination's arrivals board (Crewe, for the
// usual evening trains), matched on the service's scheduled departure from
// the origin calling point — the same schedule-based identity check
// checkLikelyArrival uses. Deliberately NOT the origin's departure board:
// a service drops off that within a minute or two of leaving Wigan, which
// is exactly when this is most likely to be used. On the arrivals board it
// stays listed right up until it reaches Crewe, and then drops off — which
// is also what retires the button once you've arrived.

function journeyTodayKey(){ return londonDateKey(new Date()); }

function getJourneyCopyState(){
  try{
    const raw = localStorage.getItem(JOURNEY_TEXT_COPIED_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return (v && typeof v === 'object' && v.dateKey === journeyTodayKey()) ? v : null; // a previous day's value is ignored
  }catch(e){ return null; }
}
function getJourneyCopyStatus(dateKey, trainKey){
  const v = getJourneyCopyState();
  return (v && v.dateKey === dateKey && v.trainKey === trainKey) ? (v.status || null) : null;
}
function setJourneyCopyStatus(dateKey, trainKey, status){
  try{ localStorage.setItem(JOURNEY_TEXT_COPIED_KEY, JSON.stringify({ dateKey, trainKey, status })); }
  catch(e){ /* UI state only — worst case the button reappears */ }
}
function isJourneyCopyDone(dateKey, trainKey){
  const st = getJourneyCopyStatus(dateKey, trainKey);
  return st === 'copied' || st === 'abandoned';
}

function journeyIsClockTime(t){ return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t); }
function journeyClockMinutes(t){ return parseInt(t.slice(0,2),10) * 60 + parseInt(t.slice(3,5),10); }
function journeyMinutesToClock(m){
  const mm = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2,'0')}:${String(mm % 60).padStart(2,'0')}`;
}

// The one service on the arrivals board that left the train's origin at
// its scheduled time. Two matches is treated as no data, as elsewhere.
function findJourneyArrivalService(arrivals, train){
  const wanted = `${train.time.slice(0,2)}:${train.time.slice(2,4)}`;
  const matches = (arrivals || []).filter(s => {
    const prev = (s.previousCallingPoints && s.previousCallingPoints[0] && s.previousCallingPoints[0].callingPoint) || [];
    return prev.some(cp => cp.crs === train.fromLoc && cp.st === wanted);
  });
  return matches.length === 1 ? matches[0] : null;
}

// Current running delay carried forward from the train's most recent
// calling point before the destination: the last one with an actual time,
// else the first one with a live estimate. Null when nothing usable.
// Darwin's "On time" counts as 0; "Delayed"/"No report"/"Cancelled" skip.
function journeyPointDelay(stTime, liveTime){
  if (!journeyIsClockTime(stTime)) return null;
  if (liveTime === 'On time') return 0;
  if (!journeyIsClockTime(liveTime)) return null;
  let d = journeyClockMinutes(liveTime) - journeyClockMinutes(stTime);
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}
function journeyCarriedDelay(prevPoints){
  let lastActual = null;
  for (const cp of prevPoints){
    const d = journeyPointDelay(cp.st, cp.at);
    if (d !== null) lastActual = d;
  }
  if (lastActual !== null) return lastActual;
  for (const cp of prevPoints){
    const d = journeyPointDelay(cp.st, cp.et);
    if (d !== null) return d;
  }
  return null;
}

// The single place the wording lives. Returns null whenever nothing should
// be offered: no match, cancelled, already arrived, or no usable estimate.
//
// 2026-09-28 (first field test): the ETA is deliberately PESSIMISTIC —
// the later of Darwin's own destination estimate and the train's current
// delay carried through to the destination's schedule. Darwin often
// predicts the train recovering time before Crewe (on 28 Sep it showed
// Crewe "on time" while the train was 4–5 min late at Wigan, then moved
// to 3 late minutes later), which made the message say "on time" about a
// visibly late train. Better the family wait than Wayne does.
function buildJourneyShareText(train, service){
  if (!train || !service) return null;
  if (service.ata) return null; // already at the destination
  if (service.isCancelled || service.eta === 'Cancelled') return null;
  const prev = (service.previousCallingPoints && service.previousCallingPoints[0] && service.previousCallingPoints[0].callingPoint) || [];
  const origin = prev.find(cp => cp.crs === train.fromLoc);
  if (origin && (origin.isCancelled || origin.et === 'Cancelled')) return null; // not calling at Wigan after all
  const sta = service.sta;
  if (!journeyIsClockTime(sta)) return null;

  const head = `🚆 On the ${train.time.slice(0,2)}:${train.time.slice(2,4)}`;
  const eta = service.eta;
  if (eta === 'Delayed') return `${head} (delayed, no new time yet).`;

  const destDelay = journeyPointDelay(sta, eta); // Darwin's own view of the destination
  if (destDelay === null) return null; // "No report" or anything unrecognised — no reliable live picture
  const carried = journeyCarriedDelay(prev);
  const delay = Math.max(destDelay, carried !== null ? carried : 0, 0);

  const estimateMin = journeyClockMinutes(sta) + delay;
  const status = delay > 0 ? `running ~${delay} min late` : 'on time';
  const roundedUp = journeyMinutesToClock(Math.ceil(estimateMin / 5) * 5);
  // The arrivals board only names its station once, at board level — not
  // per service — so the name comes from the app's own station data.
  const destName = (STATION_COORDS[train.toLoc] && STATION_COORDS[train.toLoc].name) || stationNameForCrs(train.toLoc) || train.toLoc;
  return `${head} (${status}). Should be into ${destName} around ${roundedUp}.`;
}

async function fetchJourneyArrivals(crs){
  return fetchPureBoard(crs, 'arr', 50);
}

// Text for every evening train at once — for the Confirm-train modal,
// where the chosen train isn't known until Save. One board fetch per
// destination (in practice just Crewe).
async function buildJourneyTextsForAllPm(){
  const pmTrains = railTrains.filter(t => t.direction === 'PM');
  const texts = {};
  const byDest = {};
  pmTrains.forEach(t => { (byDest[t.toLoc] = byDest[t.toLoc] || []).push(t); });
  for (const crs of Object.keys(byDest)){
    let arrivals;
    try{ arrivals = await fetchJourneyArrivals(crs); }catch(e){ continue; }
    byDest[crs].forEach(t => {
      const text = buildJourneyShareText(t, findJourneyArrivalService(arrivals, t));
      if (text) texts[t.key] = text;
    });
  }
  return texts;
}

// Which train the pending text should be kept fresh for. The banner wins
// over the prompt; both need today, evening, and not already copied or
// abandoned. The banner also has to match today's confirmed evening train,
// so a banner left over from a train since corrected via Confirm train
// used never offers the old train's text.
function bannerJourneyTarget(){
  const today = journeyTodayKey();
  const b = silentConfirmBanner;
  if (!b || b.dateKey !== today || b.direction !== 'PM') return null;
  const confirmedPm = confirmedTrains[today] && confirmedTrains[today].PM;
  if (confirmedPm !== b.trainKey) return null;
  if (isJourneyCopyDone(today, b.trainKey)) return null;
  return { dateKey: today, trainKey: b.trainKey };
}
function suggestionJourneyTarget(){
  const today = journeyTodayKey();
  const s = likelyTrainSuggestion;
  if (!s || s.dateKey !== today || s.direction !== 'PM') return null;
  if (isJourneyCopyDone(today, s.trainKey)) return null;
  return { dateKey: today, trainKey: s.trainKey };
}
function currentJourneyTextTarget(){ return bannerJourneyTarget() || suggestionJourneyTarget(); }

function stopJourneyTextRefresh(){
  if (journeyTextRefreshTimer){ clearTimeout(journeyTextRefreshTimer); journeyTextRefreshTimer = null; }
}

// Called whenever the banner or prompt changes. Starts a fresh build (and
// the 2-minute refresh loop) when the target train changes; stops the loop
// when there's nothing left to keep fresh. Cheap no-op otherwise.
function noteJourneyTextTarget(){
  const t = currentJourneyTextTarget();
  const key = t ? `${t.dateKey}|${t.trainKey}` : null;
  if (key === journeyTextTargetKey) return;
  journeyTextTargetKey = key;
  if (!t){ stopJourneyTextRefresh(); return; }
  if (!pendingJourneyText || pendingJourneyText.dateKey !== t.dateKey || pendingJourneyText.trainKey !== t.trainKey){
    pendingJourneyText = null;
  }
  refreshJourneyText();
}

async function refreshJourneyText(){
  stopJourneyTextRefresh();
  const target = currentJourneyTextTarget();
  if (!target || journeyTextRefreshInFlight) return;
  journeyTextRefreshInFlight = true;
  try{
    const train = railTrains.find(t => t.key === target.trainKey && t.direction === 'PM');
    let outcome = 'none', text = null;
    if (train){
      try{
        const arrivals = await fetchJourneyArrivals(train.toLoc);
        text = buildJourneyShareText(train, findJourneyArrivalService(arrivals, train));
        outcome = text ? 'ok' : 'none';
      }catch(e){ outcome = 'error'; }
    }
    const still = currentJourneyTextTarget();
    if (still && still.dateKey === target.dateKey && still.trainKey === target.trainKey){
      if (outcome === 'ok') pendingJourneyText = { dateKey: target.dateKey, trainKey: target.trainKey, text, builtAt: Date.now() };
      else if (outcome === 'none') pendingJourneyText = null; // arrived, cancelled, or not on the board — nothing to offer
      // 'error' (network/Worker hiccup): keep the last good text; the next refresh replaces it
    }
  } finally {
    journeyTextRefreshInFlight = false;
  }
  renderSilentConfirmBanner();
  const next = currentJourneyTextTarget();
  if (!next) return;
  if (next.dateKey !== target.dateKey || next.trainKey !== target.trainKey){
    refreshJourneyText(); // target changed while this fetch was in flight — build for the new train straight away
  } else if (document.visibilityState !== 'hidden'){
    journeyTextRefreshTimer = setTimeout(refreshJourneyText, JOURNEY_TEXT_REFRESH_MS);
  }
}

// Prompt path: copy only if the text for exactly this train is ready.
function maybeCopyJourneyText(dateKey, direction, trainKey, label, path){
  if (direction !== 'PM' || dateKey !== journeyTodayKey()) return;
  if (isJourneyCopyDone(dateKey, trainKey)) return;
  const p = pendingJourneyText;
  if (!p || p.dateKey !== dateKey || p.trainKey !== trainKey) return;
  copyJourneyText(p.text, dateKey, trainKey, label, path);
}

// Must be reached synchronously from a tap handler: writeText is the very
// first thing it does. One retry, then give up (spec §6). path is
// 'banner' | 'prompt' | 'manual' — the prompt and manual paths have no
// button of their own, so a first failure there puts up the green banner
// for that train to carry the retry button.
function copyJourneyText(text, dateKey, trainKey, label, path){
  let attempt;
  try{
    attempt = (navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('Clipboard unavailable'));
  }catch(e){
    attempt = Promise.reject(e);
  }
  return attempt.then(() => {
    setJourneyCopyStatus(dateKey, trainKey, 'copied');
    showToast('Copied for WhatsApp');
    renderSilentConfirmBanner();
  }, () => {
    if (getJourneyCopyStatus(dateKey, trainKey) === 'failed-once'){
      setJourneyCopyStatus(dateKey, trainKey, 'abandoned');
      showToast("Couldn't copy — type it manually");
    } else {
      setJourneyCopyStatus(dateKey, trainKey, 'failed-once');
      pendingJourneyText = { dateKey, trainKey, text, builtAt: Date.now() };
      if (path !== 'banner'){
        silentConfirmBanner = { dateKey, direction: 'PM', trainKey, label, source: path };
        saveSilentConfirmBanner();
      }
      showToast("Couldn't copy — tap Copy to try again");
    }
    renderSilentConfirmBanner();
  });
}

// ---- Catch-up summary banner ----
// Same fixed-position pattern as the green silent-confirm banner above,
// mounted once and left alone by render(). Sits directly below it (or
// at the top if the green banner isn't showing) — see the restacking
// logic at the end of this function and in renderBackupNudge.
// Deliberately a different colour (blue, not green) so a catch-up
// notice about a PAST day is never mistaken for today's own immediate
// confirmation.
function mountCatchupBanner(){
  const el = document.createElement('div');
  el.id = 'catchup-banner';
  el.style.cssText = 'position:fixed; left:0; right:0; z-index:199; display:none; flex-direction:column; gap:6px; padding:10px 14px; background:rgba(90,140,205,0.94); color:#0d1f33; font-size:13.5px; font-weight:600; box-shadow:0 2px 8px rgba(0,0,0,0.25);';
  document.body.appendChild(el);
  renderCatchupBanner(); // reflect whatever's already set (none, on a fresh load — this state is never persisted)
}
function renderCatchupBanner(){
  const el = document.getElementById('catchup-banner');
  if (!el) return;
  if (!catchupBanner || !catchupBanner.entries.length){
    el.style.display = 'none';
    renderBackupNudge();
    return;
  }
  const entries = catchupBanner.entries;
  const summaryLine = entries.length === 1
    ? `Watch confirmed ${escapeHtml(entries[0].label)} on ${dayNameShort(parseKey(entries[0].dateKey))} ${escapeHtml(dateLabelShort(parseKey(entries[0].dateKey)))}`
    : `Watch confirmed ${entries.length} journeys while you were away`;
  const detailHtml = entries.length > 1 && catchupBanner.expanded
    ? `<div style="font-weight:500; font-size:12.5px; opacity:0.9;">${entries.map(e =>
        `${dayNameShort(parseKey(e.dateKey))} ${e.direction} ${escapeHtml(e.label)}`
      ).join(' · ')}</div>`
    : '';
  el.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
      <span id="catchup-banner-text" style="cursor:${entries.length > 1 ? 'pointer' : 'default'};">${summaryLine}</span>
      <span id="catchup-banner-dismiss" style="cursor:pointer; font-weight:800; font-size:16px; line-height:1; padding:6px 8px; margin:-6px -6px -6px 0; -webkit-user-select:none; user-select:none; touch-action:manipulation;">×</span>
    </div>
    ${detailHtml}
  `;
  if (entries.length > 1){
    document.getElementById('catchup-banner-text').addEventListener('click', () => {
      catchupBanner.expanded = !catchupBanner.expanded;
      renderCatchupBanner();
    });
  }
  document.getElementById('catchup-banner-dismiss').addEventListener('click', () => {
    catchupBanner = null;
    renderCatchupBanner();
  });
  el.style.display = 'flex';
  // Sit below the green silent-confirm banner if that's showing, rather than over it.
  const green = document.getElementById('silent-confirm-banner');
  if (green && green.style.display !== 'none' && green.offsetHeight > 0){
    el.style.top = green.offsetHeight + 'px';
    el.style.paddingTop = '10px';
  } else {
    el.style.top = '0';
    el.style.paddingTop = 'calc(10px + env(safe-area-inset-top))';
  }
  renderBackupNudge(); // restack the red backup nudge below this one too
}
