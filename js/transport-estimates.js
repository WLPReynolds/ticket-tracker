// transport-estimates.js — The Personal Finance shared estimates file.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// ---- Share estimates with Personal Finance (2026-10-06) ----
// See transport-estimates-spec.md and claude/transport-estimates-tracker-addendum.md.
// Publishes the "Set aside on payday" figures for the current pay period and
// the next 12 as one small file, transport-estimates.json, in the "Ticket
// Tracker Backups" Drive folder. Personal Finance reads it; this file is the
// only contract between the two apps.
//
// - Works with Drive backups off (its own setting, transportShareEnabled).
// - Uploads only when `assumptions` or `periods` change (addendum 2c), so
//   generatedAt/modifiedTime mean "figures last changed".
// - Automatic attempts (app open, return to foreground, leaving the app) are
//   non-interactive: a cached token or one from the Worker, never a popup
//   (addendum 2a). Only the Share now tap / switching the setting on may open
//   Google's popup. A failed attempt leaves the last published content as it
//   was, so the next attempt simply tries again.
//
// localStorage:
//   'transport-estimates-enabled'      the setting — in BACKUP_KEYS
//   'transport-estimates-published'    JSON of { assumptions, periods } last uploaded — device-only
//   'transport-estimates-file-id'      Drive file id — device-only, re-found by name if lost
//   'transport-estimates-last-shared'  epoch ms of the last successful upload — device-only
//   'transport-estimates-last-error'   reason text of the last failed attempt, or absent — device-only
// None of the device-only keys are in BACKUP_KEYS, so publishing never marks
// a Drive backup as needed (spec tracker point 6).
const TRANSPORT_ESTIMATES_FILE_NAME = 'transport-estimates.json';
const TRANSPORT_ESTIMATES_PERIODS = 13; // offset 0 (current) + 12 ahead
const TRANSPORT_ESTIMATES_DEBOUNCE_MS = 3000;
const TRANSPORT_ESTIMATES_INFLIGHT_STALE_MS = 90 * 1000;
let transportShareEnabled = false;
let transportPublishInFlight = false;
let transportPublishStartedAt = 0;
let transportPublishTimer = null;

async function saveTransportShareEnabled(){
  try{ localStorage.setItem('transport-estimates-enabled', JSON.stringify(transportShareEnabled)); }
  catch(e){ /* save failed silently; will retry next change */ }
}

// The same local-midnight "today" render() uses, so the card and the file
// agree about which period is current and whether it's locked (addendum 2e).
function transportEstimatesToday(){
  return new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
}

// { assumptions, periods, tickets } — the part of the file that's compared to decide
// whether to upload. Pence are integers: locked periods convert the stored
// snapshot figures; projected periods multiply the integer price/day cost by
// the count (addendum 2f). totalPence is always the sum of the two parts.
function buildTransportEstimatesBody(today){
  const ticketPricePence = Math.round(lastKnownPrice * 100);
  const parkingDayPence = Math.round(parkingCost * 100);
  const lastEnd = getPayPeriodByOffset(today, TRANSPORT_ESTIMATES_PERIODS - 1).end;
  const states = computeStates(lastEnd);
  const periods = [];
  for (let offset = 0; offset < TRANSPORT_ESTIMATES_PERIODS; offset++){
    const e = estimateForPeriod(today, offset, states);
    const ticketPence = e.locked ? Math.round(e.ticketCost * 100) : ticketPricePence * e.ticketCount;
    const parkingPence = e.locked ? Math.round(e.parkingCost * 100) : parkingDayPence * e.parkingDays;
    const startKey = fmtKey(e.start);
    periods.push({
      paydayMonth: startKey.slice(0, 7),
      start: startKey,
      end: fmtKey(e.end),
      status: e.locked ? 'locked' : 'projected',
      ticketCount: e.ticketCount,
      ticketPence,
      parkingDays: e.parkingDays,
      parkingPence,
      totalPence: ticketPence + parkingPence,
    });
  }
  const tickets = buildTransportTickets(today, lastEnd, states, ticketPricePence);
  return { assumptions: { ticketPricePence, parkingDayPence }, periods, tickets };
}

// 2026-10-06 (ticket-purchases-spec.md + claude/ticket-purchases-tracker-addendum.md)
// The last day a season ticket starting on `startKey` covers: 28 calendar
// days or the 8th use, whichever comes first — the same walk as
// getRealPeriodEnd(), from any start date. Informational in the file.
function seasonTicketEndKey(startKey){
  let cursor = parseKey(startKey);
  let usedCount = 0;
  for (let daysElapsed = 1; daysElapsed <= PERIOD_LENGTH; daysElapsed++){
    const key = fmtKey(cursor);
    const comment = (comments[key] || '').trim();
    if (!isWeekend(cursor) && (comment === '' || travelOverrides[key])) usedCount++;
    if (usedCount >= USES_PER_PERIOD || daysElapsed >= PERIOD_LENGTH) return key;
    cursor = addDays(cursor, 1);
  }
  return fmtKey(addDays(parseKey(startKey), PERIOD_LENGTH - 1)); // not reached
}

// The `tickets` list: season tickets only (singles are entered by hand in
// Personal Finance — addendum 1c), oldest purchase first.
//   bought    — season purchases with purchasedOn in the last 90 days.
//               id 'p-' + start date (addendum 1a), real date and price.
//   projected — the buy flags in `states` (the same map the periods count),
//               id 'f-' + start date, purchaseDate = the flag date (the same
//               rule the calendar reminder uses), today's price. A flag whose
//               date has passed without a purchase stays listed (addendum 1c).
const TRANSPORT_TICKETS_BOUGHT_DAYS = 90;
function buildTransportTickets(today, lastEnd, states, ticketPricePence){
  const sinceKey = fmtKey(addDays(today, -TRANSPORT_TICKETS_BOUGHT_DAYS));
  const lastEndKey = fmtKey(lastEnd);
  const tickets = [];
  const boughtStarts = new Set();
  purchases.forEach(p => {
    if (!p || p.type === 'single') return;
    boughtStarts.add(p.date);
    const purchasedOn = p.purchasedOn || fmtKey(addDays(parseKey(p.date), -1));
    if (purchasedOn < sinceKey) return;
    tickets.push({
      id: p.id || `p-${p.date}`,
      validFrom: p.date,
      validTo: seasonTicketEndKey(p.date),
      purchaseDate: purchasedOn,
      pricePence: Math.round(p.cost * 100),
      status: 'bought',
    });
  });
  Object.keys(states).filter(k => states[k] && states[k].buyFlag && k <= lastEndKey).sort().forEach(flagKey => {
    const validFrom = fmtKey(addDays(parseKey(flagKey), 1));
    if (boughtStarts.has(validFrom)) return; // already logged (e.g. a backfilled future purchase)
    tickets.push({
      id: `f-${validFrom}`,
      validFrom,
      validTo: seasonTicketEndKey(validFrom),
      purchaseDate: flagKey,
      pricePence: ticketPricePence,
      status: 'projected',
    });
  });
  tickets.sort((a, b) => (a.purchaseDate + a.validFrom).localeCompare(b.purchaseDate + b.validFrom));
  return tickets;
}

function buildTransportEstimatesFile(body){
  return {
    format: 'transport-estimates',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { app: 'ticket-tracker', appVersion: APP_VERSION },
    assumptions: body.assumptions,
    periods: body.periods,
    tickets: body.tickets,
  };
}

// Finds the file to update: the cached id if it still exists, otherwise the
// oldest file with this name (the same rule Personal Finance uses), otherwise
// null. Searched by name across Drive, not just the folder, so both apps
// always settle on the same file.
async function findTransportEstimatesFileId(token){
  const headers = { 'Authorization': `Bearer ${token}` };
  const cached = loadJSON('transport-estimates-file-id', null, v => typeof v === 'string' && v.length > 0);
  if (cached){
    try{
      const check = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cached)}?fields=id,trashed`, { headers });
      if (check.ok){
        const data = await check.json();
        if (!data.trashed) return cached;
      }
    }catch(e){ /* fall through to search */ }
  }
  const query = encodeURIComponent(`name='${TRANSPORT_ESTIMATES_FILE_NAME}' and trashed=false`);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=createdTime&fields=files(id,createdTime)`, { headers });
  if (!resp.ok) throw new Error(`Drive search failed: ${resp.status}`);
  const data = await resp.json();
  const files = (data.files || []).slice().sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
  const id = files.length ? files[0].id : null;
  try{
    if (id) localStorage.setItem('transport-estimates-file-id', JSON.stringify(id));
    else localStorage.removeItem('transport-estimates-file-id');
  }catch(e){}
  return id;
}

// Overwrites the file in place, or creates it in the backup folder if there
// isn't one yet. One file, never a new one per publish.
async function uploadTransportEstimates(token, fileJson){
  const headers = { 'Authorization': `Bearer ${token}` };
  const content = JSON.stringify(fileJson, null, 2);
  const existingId = await findTransportEstimatesFileId(token);
  if (existingId){
    const resp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=media&fields=id`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json; charset=UTF-8' },
      body: content
    });
    if (resp.ok) return;
    if (resp.status !== 404) throw new Error(`Drive update failed: ${resp.status}`);
    try{ localStorage.removeItem('transport-estimates-file-id'); }catch(e){} // gone since we checked — create below
  }
  const folderId = await ensureDriveBackupFolder(token);
  const boundary = 'ticketpwa-estimates-boundary';
  const metadata = { name: TRANSPORT_ESTIMATES_FILE_NAME, parents: [folderId], mimeType: 'application/json' };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!resp.ok) throw new Error(`Drive create failed: ${resp.status}`);
  const data = await resp.json();
  try{ localStorage.setItem('transport-estimates-file-id', JSON.stringify(data.id)); }catch(e){}
}

// opts.interactive — a tap is behind this call, so Google's popup may open.
//   Must then be called straight from the tap handler with nothing awaited
//   first; everything before getGoogleAccessToken below is synchronous.
// opts.force — upload even if nothing has changed (Share now).
// Resolves { ok, unchanged?, reason? }. Never throws.
async function attemptTransportPublish(opts){
  const interactive = !!(opts && opts.interactive);
  const force = !!(opts && opts.force);
  if (!transportShareEnabled) return { ok: false, reason: 'not-enabled' };
  if (transportPublishInFlight && Date.now() - transportPublishStartedAt < TRANSPORT_ESTIMATES_INFLIGHT_STALE_MS){
    return { ok: false, reason: 'already-in-progress' };
  }
  let body, compareText;
  try{
    body = buildTransportEstimatesBody(transportEstimatesToday());
    compareText = JSON.stringify(body);
  }catch(e){
    return { ok: false, reason: `couldn't work out the figures (${e.message})` };
  }
  if (!force && compareText === localStorage.getItem('transport-estimates-published')){
    // What's on Drive is already current — any earlier failure no longer matters.
    try{ localStorage.removeItem('transport-estimates-last-error'); }catch(e){}
    return { ok: true, unchanged: true };
  }
  transportPublishInFlight = true;
  transportPublishStartedAt = Date.now();
  try{
    const token = await getGoogleAccessToken({ interactive });
    if (!token) throw new Error("Google sign-in didn't complete");
    await uploadTransportEstimates(token, buildTransportEstimatesFile(body));
    try{
      localStorage.setItem('transport-estimates-published', compareText);
      localStorage.setItem('transport-estimates-last-shared', JSON.stringify(Date.now()));
      localStorage.removeItem('transport-estimates-last-error');
    }catch(e){}
    return { ok: true };
  }catch(e){
    const reason = (e && e.message) || 'unknown error';
    try{ localStorage.setItem('transport-estimates-last-error', JSON.stringify(reason)); }catch(err){}
    return { ok: false, reason };
  }finally{
    transportPublishInFlight = false;
  }
}

// Debounced automatic attempt — app open (after the bank-holiday sync) and
// return to the foreground. Cheap when nothing has changed: no network call.
function scheduleTransportPublish(){
  if (!transportShareEnabled) return;
  if (transportPublishTimer) clearTimeout(transportPublishTimer);
  transportPublishTimer = setTimeout(() => { transportPublishTimer = null; attemptTransportPublish(); }, TRANSPORT_ESTIMATES_DEBOUNCE_MS);
}
// Leaving the app: a pending debounce may never fire once the page is frozen.
function flushTransportPublish(){
  if (transportPublishTimer){ clearTimeout(transportPublishTimer); transportPublishTimer = null; }
  attemptTransportPublish();
}

function transportShareStatusText(){
  if (!transportShareEnabled) return 'Not sharing.';
  const last = loadJSON('transport-estimates-last-shared', 0);
  const err = loadJSON('transport-estimates-last-error', null, v => typeof v === 'string');
  const lastText = last
    ? `Last shared: ${new Date(last).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : 'Not shared yet';
  return err ? `${lastText} · last attempt failed: ${err}` : lastText;
}
