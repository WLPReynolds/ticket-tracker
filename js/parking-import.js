// parking-import.js — Parking payments read from Personal Finance.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// ---- Read parking from Personal Finance (2026-11-27) ----
// See claude/parking-transactions-spec.md. Personal Finance (v0.15.25) writes
// every payment Wayne ticks as "Parking" to parking-transactions.json; this
// file reads it and marks those days as parked, so a parking payment is only
// recorded once, in Personal Finance.
//
// Who creates the file: THIS app (spec §2). Our Google access is the drive.file
// scope, so we can only see files our OAuth client created. Personal Finance
// shares the same client and only finds and PATCHes the file; it never creates it.
//
// Rules (spec §6, §7):
// - Only transactions dated on or after the switch-on date (parkingImportSince)
//   are used. That date is set the first time the setting is turned on and kept.
// - A day that already has a parked entry is never overwritten.
// - The ledger remembers, per day, what the file said and whether this app
//   set that day itself (owned). When the file changes, only owned days are
//   updated or removed, and only while parkedDays still holds exactly what
//   this app put there. A day edited by hand stops being owned for good.
// - Several payments on one day are added together.
// - A file this app has just created (source.app 'ticket-tracker') holds
//   nothing from Personal Finance yet, so it's never applied: that stops an
//   empty, re-created file from removing imported days.
// - A file with the wrong format or a version above 1 is left alone and the
//   problem shown in the status line.
// - Automatic reads (app open, return to the foreground) never pop up a
//   Google sign-in. Only the switch and Read now may.
//
// localStorage:
//   'parking-import-enabled'      the setting — in BACKUP_KEYS
//   'parking-import-since'        YYYY-MM-DD switch-on date — in BACKUP_KEYS
//   'parking-import-ledger'       { days: { key: { pence, owned, accounts[] } } } — in BACKUP_KEYS,
//                                 because it must stay in step with 'parked-days'
//   'parking-import-file-id'      Drive file id — device-only, re-found by name if lost
//   'parking-import-seen'         Drive modifiedTime of the last file applied — device-only
//   'parking-import-last-read'    epoch ms of the last successful read — device-only
//   'parking-import-last-summary' short text of what the last change did — device-only
//   'parking-import-last-error'   reason text of the last failed attempt, or absent — device-only
// Wear OS: no change (parked days aren't in the watch config). Workers: no change.
const PARKING_IMPORT_FILE_NAME = 'parking-transactions.json';
const PARKING_IMPORT_DEBOUNCE_MS = 2000;
const PARKING_IMPORT_INFLIGHT_STALE_MS = 90 * 1000;
let parkingImportEnabled = false;
let parkingImportSince = null;
let parkingImportLedger = { days: {} };
let parkingImportInFlight = false;
let parkingImportStartedAt = 0;
let parkingImportTimer = null;

async function saveParkingImportSettings(){
  try{
    localStorage.setItem('parking-import-enabled', JSON.stringify(parkingImportEnabled));
    if (parkingImportSince) localStorage.setItem('parking-import-since', JSON.stringify(parkingImportSince));
  }catch(e){ /* save failed silently; will retry next change */ }
}
async function saveParkingImportLedger(){
  try{ localStorage.setItem('parking-import-ledger', JSON.stringify(parkingImportLedger)); }
  catch(e){ /* save failed silently; will retry next change */ }
}

// Called from loadData (state.js).
function loadParkingImportState(){
  parkingImportEnabled = loadJSON('parking-import-enabled', false);
  parkingImportSince = loadJSON('parking-import-since', null, v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
  parkingImportLedger = loadJSON('parking-import-ledger', { days: {} }, v => v && typeof v === 'object' && v.days && typeof v.days === 'object');
}

function parkingPenceOf(pounds){ return Math.round(Number(pounds) * 100); }

// The empty file this app creates (spec §4).
function buildEmptyParkingFile(){
  return {
    format: 'parking-transactions',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { app: 'ticket-tracker', appVersion: APP_VERSION },
    transactions: [],
  };
}

// Checks the file's header. Returns null if it's usable, otherwise the reason.
function parkingFileProblem(file){
  if (!file || typeof file !== 'object') return 'the file isn\'t valid JSON';
  if (file.format !== 'parking-transactions') return `unexpected format "${String(file.format)}"`;
  if (typeof file.version !== 'number' || file.version > 1) return `file version ${String(file.version)} is newer than this app understands`;
  if (!Array.isArray(file.transactions)) return 'the file has no transactions list';
  return null;
}

// { key: { pence, accounts[] } } — total per day, from valid transactions dated
// on or after `sinceKey`. Bad entries are skipped rather than failing the file.
function parkingTotalsByDay(transactions, sinceKey){
  const totals = {};
  transactions.forEach(t => {
    if (!t || typeof t.id !== 'string' || !t.id) return;
    if (typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return;
    if (!Number.isInteger(t.amountPence) || t.amountPence <= 0) return;
    if (sinceKey && t.date < sinceKey) return;
    const day = totals[t.date] || (totals[t.date] = { pence: 0, accounts: [] });
    day.pence += t.amountPence;
    const acct = typeof t.account === 'string' ? t.account.trim() : '';
    if (acct && !day.accounts.includes(acct)) day.accounts.push(acct);
  });
  return totals;
}

// Applies the file's per-day totals to parkedDays and the ledger. Pure apart
// from mutating the two objects passed in, so it can be tested on its own.
// Returns { added, updated, removed, released } — counts of days.
function applyParkingTotals(totals, parked, ledger){
  const result = { added: 0, updated: 0, removed: 0, released: 0 };
  const days = ledger.days;
  Object.keys(totals).forEach(key => {
    const want = totals[key];
    const entry = days[key];
    if (!entry){
      if (parked[key] !== undefined){
        days[key] = { pence: want.pence, owned: false, accounts: want.accounts }; // marked by hand — never touched
      } else {
        parked[key] = want.pence / 100;
        days[key] = { pence: want.pence, owned: true, accounts: want.accounts };
        result.added++;
      }
      return;
    }
    if (entry.owned){
      const stillOurs = parked[key] !== undefined && parkingPenceOf(parked[key]) === entry.pence;
      if (!stillOurs){
        entry.owned = false; // edited or unticked by hand since — leave it alone from now on
        result.released++;
      } else if (entry.pence !== want.pence){
        parked[key] = want.pence / 100;
        result.updated++;
      }
    }
    entry.pence = want.pence;
    entry.accounts = want.accounts;
  });
  Object.keys(days).forEach(key => {
    if (totals[key]) return;
    const entry = days[key];
    if (entry.owned && parked[key] !== undefined && parkingPenceOf(parked[key]) === entry.pence){
      delete parked[key];
      result.removed++;
    }
    delete days[key];
  });
  return result;
}

function parkingImportSummaryText(r){
  const parts = [];
  const n = (c, word) => `${c} day${c === 1 ? '' : 's'} ${word}`;
  if (r.added) parts.push(n(r.added, 'added'));
  if (r.updated) parts.push(n(r.updated, 'updated'));
  if (r.removed) parts.push(n(r.removed, 'removed'));
  return parts.length ? parts.join(', ') : 'no changes';
}

async function findParkingImportFileId(token){
  const headers = { 'Authorization': `Bearer ${token}` };
  const cached = loadJSON('parking-import-file-id', null, v => typeof v === 'string' && v.length > 0);
  if (cached){
    try{
      const check = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cached)}?fields=id,trashed`, { headers });
      if (check.ok){
        const data = await check.json();
        if (!data.trashed) return cached;
      }
    }catch(e){ /* fall through to search */ }
  }
  const query = encodeURIComponent(`name='${PARKING_IMPORT_FILE_NAME}' and trashed=false`);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=createdTime&fields=files(id,createdTime)`, { headers });
  if (!resp.ok) throw new Error(`Drive search failed: ${resp.status}`);
  const data = await resp.json();
  const files = (data.files || []).slice().sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
  const id = files.length ? files[0].id : null;
  try{
    if (id) localStorage.setItem('parking-import-file-id', JSON.stringify(id));
    else localStorage.removeItem('parking-import-file-id');
  }catch(e){}
  return id;
}

// Creates the empty file in the backup folder (spec §2). Only ever called
// from a tap (the switch or Read now), never from an automatic read.
async function createParkingImportFile(token){
  const headers = { 'Authorization': `Bearer ${token}` };
  const folderId = await ensureDriveBackupFolder(token);
  const boundary = 'ticketpwa-parking-boundary';
  const metadata = { name: PARKING_IMPORT_FILE_NAME, parents: [folderId], mimeType: 'application/json' };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(buildEmptyParkingFile(), null, 2)}\r\n` +
    `--${boundary}--`;
  const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!resp.ok) throw new Error(`Drive create failed: ${resp.status}`);
  const data = await resp.json();
  try{ localStorage.setItem('parking-import-file-id', JSON.stringify(data.id)); }catch(e){}
  return data.id;
}

// opts.interactive — a tap is behind this call: Google's popup may open, and
//   the file is created if there isn't one. Must be called straight from the
//   tap handler with nothing awaited first.
// opts.force — download and apply even if the file hasn't changed (Read now).
// Resolves { ok, unchanged?, changed?, reason? }. Never throws.
async function attemptParkingImport(opts){
  const interactive = !!(opts && opts.interactive);
  const force = !!(opts && opts.force);
  if (!parkingImportEnabled) return { ok: false, reason: 'not-enabled' };
  if (parkingImportInFlight && Date.now() - parkingImportStartedAt < PARKING_IMPORT_INFLIGHT_STALE_MS){
    return { ok: false, reason: 'already-in-progress' };
  }
  parkingImportInFlight = true;
  parkingImportStartedAt = Date.now();
  const fail = (reason) => {
    try{ localStorage.setItem('parking-import-last-error', JSON.stringify(reason)); }catch(e){}
    return { ok: false, reason };
  };
  try{
    const token = await getGoogleAccessToken({ interactive });
    if (!token) return fail("Google sign-in didn't complete");
    const headers = { 'Authorization': `Bearer ${token}` };
    let fileId = await findParkingImportFileId(token);
    if (!fileId){
      if (!interactive) return fail('the parking file is missing from Drive — tap Read now to create it again');
      fileId = await createParkingImportFile(token);
    }
    const metaResp = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,modifiedTime`, { headers });
    if (!metaResp.ok) return fail(`Drive check failed: ${metaResp.status}`);
    const meta = await metaResp.json();
    const markRead = (summary) => {
      try{
        localStorage.setItem('parking-import-last-read', JSON.stringify(Date.now()));
        localStorage.removeItem('parking-import-last-error');
        if (summary) localStorage.setItem('parking-import-last-summary', JSON.stringify(summary));
      }catch(e){}
    };
    if (!force && meta.modifiedTime && meta.modifiedTime === loadJSON('parking-import-seen', null)){
      markRead(null);
      return { ok: true, unchanged: true };
    }
    const fileResp = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
    if (!fileResp.ok) return fail(`Drive download failed: ${fileResp.status}`);
    let file;
    try{ file = JSON.parse(await fileResp.text()); }catch(e){ file = null; }
    const problem = parkingFileProblem(file);
    if (problem) return fail(problem);
    if (!file.source || file.source.app !== 'personal-finance'){
      // Still the empty file this app created — nothing from Personal Finance yet.
      try{ localStorage.setItem('parking-import-seen', JSON.stringify(meta.modifiedTime || null)); }catch(e){}
      markRead('waiting for Personal Finance');
      return { ok: true, unchanged: true };
    }
    const totals = parkingTotalsByDay(file.transactions, parkingImportSince);
    const r = applyParkingTotals(totals, parkedDays, parkingImportLedger);
    const changed = r.added + r.updated + r.removed > 0;
    await saveParkingImportLedger();
    if (changed) await saveParkedDays();
    try{ localStorage.setItem('parking-import-seen', JSON.stringify(meta.modifiedTime || null)); }catch(e){}
    markRead(parkingImportSummaryText(r));
    if (changed) render();
    return { ok: true, changed };
  }catch(e){
    return fail((e && e.message) || 'unknown error');
  }finally{
    parkingImportInFlight = false;
  }
}

// Debounced automatic read — app open and return to the foreground.
function scheduleParkingImport(){
  if (!parkingImportEnabled) return;
  if (parkingImportTimer) clearTimeout(parkingImportTimer);
  parkingImportTimer = setTimeout(() => { parkingImportTimer = null; attemptParkingImport(); }, PARKING_IMPORT_DEBOUNCE_MS);
}

// For the day editor: the ledger entry if this app set the day from
// Personal Finance and it still holds that amount, otherwise null.
function parkingImportedEntryFor(key){
  const entry = parkingImportLedger.days[key];
  if (!entry || !entry.owned || parkedDays[key] === undefined) return null;
  return parkingPenceOf(parkedDays[key]) === entry.pence ? entry : null;
}

function parkingImportStatusText(){
  if (!parkingImportEnabled) return 'Not reading.';
  const last = loadJSON('parking-import-last-read', 0);
  const err = loadJSON('parking-import-last-error', null, v => typeof v === 'string');
  const summary = loadJSON('parking-import-last-summary', null, v => typeof v === 'string');
  const sinceText = parkingImportSince ? `Payments from ${dateLabelShort(parseKey(parkingImportSince))}` : '';
  const lastText = last
    ? `Last read: ${new Date(last).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${summary ? ` (last change: ${summary})` : ''}`
    : 'Not read yet';
  const parts = [lastText];
  if (sinceText) parts.push(sinceText);
  if (err) parts.push(`last attempt failed: ${err}`);
  return parts.join(' · ');
}
