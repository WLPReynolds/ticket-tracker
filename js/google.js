// google.js — Google sign-in, Worker-held token, Drive backup, backup nudge, Calendar sync.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// 2026-09-19 — Google only calls `callback` on success. If the consent popup is
// blocked, closed or dismissed it calls `error_callback` instead, which used to
// be unset — so the awaiting promise hung forever and (for Drive backup) left
// the in-flight lock stuck. See getGoogleAccessToken().
let googleTokenErrorHandler = null;
function ensureGoogleTokenClient(){
  if (!googleTokenClient && window.google && google.accounts && google.accounts.oauth2){
    const config = {
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file',
      callback: () => {}, // overridden per-request below
      error_callback: (err) => { if (googleTokenErrorHandler) googleTokenErrorHandler(err); }
    };
    if (preferredGoogleEmail) config.login_hint = preferredGoogleEmail;
    googleTokenClient = google.accounts.oauth2.initTokenClient(config);
  }
  return googleTokenClient;
}

const GOOGLE_TOKEN_TIMEOUT_MS = 20 * 1000;
// Gets a valid Google access token, reusing a cached one if it hasn't
// expired yet. Must be called from within a genuine user gesture (a
// click handler) the first time, or the browser may block the consent
// popup — this is why calendar syncing happens via a tappable prompt
// rather than automatically in the background.
// opts.interactive === false: never open Google's popup. Used by the
// automatic (no-tap) Drive backup, where a popup has no user gesture behind
// it and the browser just blocks it.
//
// 2026-10-04 (claude/drive-backup-refresh-token-spec.md): when automatic
// sign-in is connected (the Worker holds a refresh token), a missing or
// expired token is fetched from the Worker first — no popup, no tap. Only
// if that fails does an interactive call fall back to Google's popup. When
// it ISN'T connected, an interactive call goes straight to the popup, with
// nothing awaited first, so the tap still counts as the user gesture.
function getGoogleAccessToken(opts){
  const interactive = !opts || opts.interactive !== false;
  if (cachedAccessToken && Date.now() < cachedTokenExpiry){
    return Promise.resolve(cachedAccessToken);
  }
  if (googleWorkerState() === 'connected' && pwaWriteSecret){
    return fetchGoogleTokenFromWorker().then((tok) => {
      if (tok) return tok;
      return interactive ? requestGoogleTokenViaPopup() : null;
    });
  }
  if (!interactive) return Promise.resolve(null);
  return requestGoogleTokenViaPopup();
}

function requestGoogleTokenViaPopup(){
  return new Promise((resolve) => {
    const client = ensureGoogleTokenClient();
    if (!client){ resolve(null); return; }
    let settled = false;
    let timer = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      googleTokenErrorHandler = null;
      resolve(val);
    };
    timer = setTimeout(() => finish(null), GOOGLE_TOKEN_TIMEOUT_MS);
    googleTokenErrorHandler = () => finish(null);
    client.callback = (resp) => {
      if (resp && resp.access_token){
        // Cache even if we've already timed out — a slow consent that
        // completes late still makes the next attempt instant.
        cachedAccessToken = resp.access_token;
        cachedTokenExpiry = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3000000) - 60000;
        saveGoogleTokenCache();
        finish(cachedAccessToken);
      } else {
        finish(null);
      }
    };
    client.requestAccessToken({ prompt: '' });
  });
}

// ---- Google token persistence (2026-10-02) ----
// The token and its expiry are kept in localStorage ('google-token-cache'),
// so a reload inside the hour still has one. Device-only, never backed up
// (not in BACKUP_KEYS), cleared when the preferred Google account changes.
//
// 2026-10-04: the 2026-10-02 quiet refresh (prompt:'none' on app open) is
// gone. Google's token library always opens a sign-in window, even with
// prompt:'none'; with no tap behind it the installed PWA lost that window
// (popup_closed every time) and the sign-in page flashed on every open.
// Replaced by the Worker-held refresh token below.
function saveGoogleTokenCache(){
  try{
    if (cachedAccessToken && Date.now() < cachedTokenExpiry){
      localStorage.setItem('google-token-cache', JSON.stringify({ token: cachedAccessToken, expiry: cachedTokenExpiry }));
    } else {
      localStorage.removeItem('google-token-cache');
    }
  }catch(e){ /* not critical — the token just won't survive a reload */ }
}
function loadGoogleTokenCache(){
  const c = loadJSON('google-token-cache', null, v => v && typeof v.token === 'string' && typeof v.expiry === 'number');
  if (c && Date.now() < c.expiry){
    cachedAccessToken = c.token;
    cachedTokenExpiry = c.expiry;
  } else {
    try{ localStorage.removeItem('google-token-cache'); }catch(e){}
  }
  try{ localStorage.removeItem('google-silent-refresh-log'); }catch(e){} // 2026-10-04 — the retired quiet refresh's status record
}
function clearGoogleTokenCache(){
  cachedAccessToken = null;
  cachedTokenExpiry = 0;
  try{ localStorage.removeItem('google-token-cache'); }catch(e){}
}

// ---- Automatic sign-in via the Worker (2026-10-04) ----
// See claude/drive-backup-refresh-token-spec.md. A one-time tap ("Connect
// automatic backup" on Backup & restore) runs Google's authorisation-code
// flow; the Worker swaps the code for a long-lived refresh token, keeps it in
// its KV, and from then on hands this app short-lived access tokens on
// request (GET /api/google/token, behind X-PWA-Secret). Backups still upload
// from here exactly as before — only the token comes from the Worker.
//
// 'google-worker-status' (device-only, not in BACKUP_KEYS) remembers what the
// Worker last said: { state: 'connected' | 'needs-reconnect' | 'not-connected', at }.
// Absent means "never asked" — the next app open asks once and finds out.
const GOOGLE_WORKER_REFRESH_MARGIN_MS = 15 * 60 * 1000; // top up when the cached token has less than this left
const GOOGLE_WORKER_MIN_GAP_MS = 60 * 1000;             // don't re-ask on every quick foreground flip
const GOOGLE_WORKER_TIMEOUT_MS = 10 * 1000;
const GOOGLE_CONNECT_TIMEOUT_MS = 3 * 60 * 1000;        // the consent popup can take a while to click through
let googleWorkerFetchPromise = null;
let lastGoogleWorkerFetchAt = 0;

function googleWorkerState(){
  const s = loadJSON('google-worker-status', null, v => v && typeof v.state === 'string');
  return s ? s.state : null;
}
function setGoogleWorkerState(state){
  try{ localStorage.setItem('google-worker-status', JSON.stringify({ state, at: Date.now() })); }catch(e){}
}

function fetchWithTimeout(url, options, ms){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function acceptWorkerGoogleToken(data){
  if (!data || typeof data.accessToken !== 'string' || typeof data.expiresAt !== 'number') return null;
  cachedAccessToken = data.accessToken;
  cachedTokenExpiry = data.expiresAt - 60000;
  saveGoogleTokenCache();
  return cachedAccessToken;
}

// Never opens anything and never throws. Resolves to a token or null, and
// records what the Worker said. Concurrent callers share one request.
function fetchGoogleTokenFromWorker(){
  if (!pwaWriteSecret) return Promise.resolve(null);
  if (googleWorkerFetchPromise) return googleWorkerFetchPromise;
  lastGoogleWorkerFetchAt = Date.now();
  googleWorkerFetchPromise = (async () => {
    try{
      const resp = await fetchWithTimeout(`${DARWIN_WORKER_URL}/api/google/token`, { headers: { 'X-PWA-Secret': pwaWriteSecret } }, GOOGLE_WORKER_TIMEOUT_MS);
      if (resp.status === 404){ setGoogleWorkerState('not-connected'); return null; }
      if (resp.status === 409){
        setGoogleWorkerState('needs-reconnect');
        try{ renderBackupNudge(); }catch(e){}
        return null;
      }
      if (!resp.ok) return null; // 401 (write secret), 5xx, rate limit — state left as it was
      const tok = acceptWorkerGoogleToken(await resp.json().catch(() => null));
      if (tok) setGoogleWorkerState('connected');
      return tok;
    }catch(e){
      return null; // offline or timed out
    }finally{
      googleWorkerFetchPromise = null;
    }
  })();
  return googleWorkerFetchPromise;
}

// On app open / return to the foreground: make sure a token is already
// cached before the app is next backgrounded, so the backup on leaving
// doesn't depend on a network round trip while the page is being frozen.
function maybeRefreshGoogleTokenFromWorker(){
  // 2026-10-06: also when sharing with Personal Finance, which works with Drive backups off (addendum 2b).
  if (!driveBackupEnabled && !gcalEnabled && !transportShareEnabled) return;
  if (!pwaWriteSecret) return;
  const state = googleWorkerState();
  if (state === 'not-connected' || state === 'needs-reconnect') return; // only a tap (Connect / Reconnect) changes these
  if (cachedAccessToken && (cachedTokenExpiry - Date.now()) > GOOGLE_WORKER_REFRESH_MARGIN_MS) return;
  if (Date.now() - lastGoogleWorkerFetchAt < GOOGLE_WORKER_MIN_GAP_MS) return;
  fetchGoogleTokenFromWorker();
}

// Must be called straight from a tap handler, with nothing awaited first —
// requestCode() opens Google's popup, which needs the tap behind it.
// Resolves { ok: true } or { ok: false, message }.
function connectGoogleViaWorker(){
  return new Promise((resolve) => {
    if (!pwaWriteSecret){
      resolve({ ok: false, message: 'Set the write secret in Settings (key icon) first — the Worker needs it to keep your sign-in.' });
      return;
    }
    if (!(window.google && google.accounts && google.accounts.oauth2 && google.accounts.oauth2.initCodeClient)){
      resolve({ ok: false, message: "Google's sign-in hasn't loaded yet — try again in a moment." });
      return;
    }
    let settled = false;
    const finish = (r) => { if (!settled){ settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, message: "Google sign-in didn't complete." }), GOOGLE_CONNECT_TIMEOUT_MS);
    const config = {
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file',
      ux_mode: 'popup',
      callback: async (resp) => {
        if (!resp || !resp.code){
          finish({ ok: false, message: `Google sign-in didn't complete${resp && resp.error ? ` (${resp.error})` : ''}.` });
          return;
        }
        try{
          const r = await fetchWithTimeout(`${DARWIN_WORKER_URL}/api/google/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-PWA-Secret': pwaWriteSecret },
            body: JSON.stringify({ code: resp.code })
          }, GOOGLE_WORKER_TIMEOUT_MS * 2);
          const data = await r.json().catch(() => null);
          if (r.status === 401){ finish({ ok: false, message: 'The Worker refused the write secret — check it in Settings (key icon).' }); return; }
          if (!r.ok){
            const reason = data && data.reason;
            if (reason === 'no-refresh-token'){
              finish({ ok: false, message: 'Google didn\'t hand over a long-lived sign-in. Remove "Ticket Tracker" at myaccount.google.com/permissions, then tap Connect again.' });
            } else if (reason === 'no-client-secret'){
              finish({ ok: false, message: 'The Worker is missing GOOGLE_CLIENT_SECRET — add it in the Cloudflare dashboard.' });
            } else {
              finish({ ok: false, message: `Couldn't connect (${reason || `HTTP ${r.status}`}).` });
            }
            return;
          }
          acceptWorkerGoogleToken(data);
          setGoogleWorkerState('connected');
          const granted = String((data && data.scope) || '');
          if (granted && !granted.includes('drive.file')){
            finish({ ok: true, message: 'Connected, but Drive access wasn\'t ticked — backups won\'t work until you Reconnect and allow it.' });
            return;
          }
          finish({ ok: true });
        }catch(e){
          finish({ ok: false, message: "Couldn't reach the Worker — check your connection and try again." });
        }
      },
      error_callback: (err) => finish({ ok: false, message: `Google sign-in didn't complete${err && err.type ? ` (${err.type})` : ''}.` })
    };
    if (preferredGoogleEmail) config.login_hint = preferredGoogleEmail;
    try{
      google.accounts.oauth2.initCodeClient(config).requestCode();
    }catch(e){
      finish({ ok: false, message: `Google sign-in couldn't start (${e && e.message}).` });
    }
  });
}

async function disconnectGoogleViaWorker(){
  try{
    const r = await fetchWithTimeout(`${DARWIN_WORKER_URL}/api/google/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PWA-Secret': pwaWriteSecret || '' },
      body: '{}'
    }, GOOGLE_WORKER_TIMEOUT_MS);
    if (!r.ok) return { ok: false, message: r.status === 401 ? 'The Worker refused the write secret.' : `Couldn't disconnect (HTTP ${r.status}).` };
  }catch(e){
    return { ok: false, message: "Couldn't reach the Worker." };
  }
  setGoogleWorkerState('not-connected');
  clearGoogleTokenCache(); // revoked at Google, so the cached copy is dead too
  return { ok: true };
}

function googleWorkerStatusText(){
  const state = googleWorkerState();
  if (state === 'connected') return 'Automatic sign-in: connected';
  if (state === 'needs-reconnect') return 'Automatic sign-in: needs reconnecting';
  if (!pwaWriteSecret) return 'Automatic sign-in: not connected (set the write secret in Settings first)';
  return 'Automatic sign-in: not connected';
}

// Creates or updates the single "Buy train ticket" calendar event for the
// given date, at 8pm with an immediate popup reminder. Reuses the same
// event (updating its date) rather than creating a new one each time, so
// old reminders don't pile up. If the stored event was deleted manually,
// falls back to creating a fresh one rather than failing silently forever.
// Finds the app's backup folder in Drive, creating it if it doesn't exist
// yet. Caches the folder ID so this search only needs to happen once —
// but recovers gracefully if the folder was deleted manually since then.
async function ensureDriveBackupFolder(token){
  const headers = { 'Authorization': `Bearer ${token}` };

  if (driveBackupFolderId){
    // verify it still exists rather than trusting the cache blindly
    try{
      const check = await fetch(`https://www.googleapis.com/drive/v3/files/${driveBackupFolderId}?fields=id,trashed`, { headers });
      if (check.ok){
        const data = await check.json();
        if (!data.trashed) return driveBackupFolderId;
      }
    }catch(e){ /* fall through to search/create */ }
  }

  const query = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${DRIVE_BACKUP_FOLDER_NAME}' and trashed=false`);
  const searchResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, { headers });
  if (searchResp.ok){
    const searchData = await searchResp.json();
    if (searchData.files && searchData.files.length > 0){
      driveBackupFolderId = searchData.files[0].id;
      await saveDriveBackupFolderId();
      return driveBackupFolderId;
    }
  }

  const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!createResp.ok) throw new Error('Could not create Drive backup folder');
  const createData = await createResp.json();
  driveBackupFolderId = createData.id;
  await saveDriveBackupFolderId();
  return driveBackupFolderId;
}

function buildBackupPayload(){
  const backup = { exportedAt: new Date().toISOString(), version: 1, data: {} };
  BACKUP_KEYS.forEach(k => {
    const v = localStorage.getItem(k);
    if (v !== null) backup.data[k] = v;
  });
  return JSON.stringify(backup, null, 2);
}

async function uploadBackupToDrive(token, folderId){
  const filename = `ticket-tracker-backup-${fmtKey(new Date())}-${Date.now()}.json`;
  const metadata = { name: filename, parents: [folderId] };
  const boundary = 'ticketpwa-backup-boundary';
  const payload = buildBackupPayload();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n` +
    `--${boundary}--`;

  const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!resp.ok) throw new Error(`Drive upload failed: ${resp.status}`);
  return resp.json();
}

// Keeps only the most recent DRIVE_BACKUP_KEEP_COUNT files in the backup
// folder, deleting anything older right after a new backup succeeds.
async function pruneOldDriveBackups(token, folderId){
  const headers = { 'Authorization': `Bearer ${token}` };
  const query = encodeURIComponent(`'${folderId}' in parents and trashed=false and name contains 'ticket-tracker-backup-'`);
  const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=createdTime desc&fields=files(id,name,createdTime)`, { headers });
  if (!listResp.ok) return;
  const listData = await listResp.json();
  const files = listData.files || [];
  const toDelete = files.slice(DRIVE_BACKUP_KEEP_COUNT);
  for (const f of toDelete){
    try{ await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE', headers }); }
    catch(e){ /* not critical — will be cleaned up next successful backup */ }
  }
}

// The main entry point: called whenever the app is backgrounded. Only
// actually uploads if something's changed since the last successful
// backup AND the throttle window has passed — otherwise does nothing.
let driveBackupInFlight = false; // guards against overlapping triggers — e.g. Google's own OAuth popup opening/closing can itself cause a visibility change, which could otherwise race with an explicit manual backup
let driveBackupStartedAt = 0;
let driveBackupRunId = 0;
// 2026-09-19 — a lock that's been held this long is assumed stuck (a hung
// request that never settled) and is ignored, so one bad attempt can no
// longer block every later one until the app is reloaded.
const DRIVE_BACKUP_INFLIGHT_STALE_MS = 90 * 1000;

async function attemptDriveBackup(force){
  if (driveBackupInFlight && Date.now() - driveBackupStartedAt < DRIVE_BACKUP_INFLIGHT_STALE_MS) return { ok: false, reason: 'already-in-progress' };
  if (!driveBackupEnabled) return { ok: false, reason: 'not-enabled' };
  if (!force){
    if (!driveBackupDirty) return { ok: false, reason: 'nothing-changed' };
    if (Date.now() - lastDriveBackupTime < DRIVE_BACKUP_THROTTLE_MS) return { ok: false, reason: 'throttled' };
  }
  driveBackupInFlight = true;
  driveBackupStartedAt = Date.now();
  const myRunId = ++driveBackupRunId;

  try{
    // Automatic (non-forced) runs have no tap behind them, so they may only
    // use an already-cached token; a manual tap may open Google's popup.
    const token = await getGoogleAccessToken({ interactive: !!force });
    if (!token) return { ok: false, reason: 'needs-reconnect' };
    const folderId = await ensureDriveBackupFolder(token);
    await uploadBackupToDrive(token, folderId);
    await pruneOldDriveBackups(token, folderId);
    driveBackupDirty = false;
    lastDriveBackupTime = Date.now();
    localStorage.setItem('drive-backup-dirty', JSON.stringify(false));
    localStorage.setItem('drive-backup-last-time', JSON.stringify(lastDriveBackupTime));
    return { ok: true };
  }catch(e){
    return { ok: false, reason: e.message }; // dirty flag stays set — will retry next opportunity
  }finally{
    if (myRunId === driveBackupRunId) driveBackupInFlight = false;
    try{ renderBackupNudge(); }catch(e){ /* banner not mounted yet — not critical */ }
  }
}

function driveBackupReasonText(reason){
  if (reason === 'needs-reconnect') return "Google sign-in didn't complete";
  if (reason === 'already-in-progress') return 'A backup is already running';
  return reason;
}

// ---- Stale Drive backup nudge ----
// Red banner (same fixed-top style as the silent-confirm banner) shown when
// automatic Drive backup is on, something has changed since the last backup,
// and that backup is 2+ days old. Automatic backups can't refresh Google's
// ~1-hour sign-in without a tap, so this is the prompt to give it one.
// Tapping the text is a genuine user gesture, so consent can go through.
const DRIVE_BACKUP_STALE_MS = 24 * 60 * 60 * 1000; // 2026-10-04: was 2 days — tightened now that automatic sign-in should keep backups running
const BACKUP_NUDGE_SNOOZE_MS = 4 * 60 * 60 * 1000;
let backupNudgeSnoozedUntil = 0; // in-memory only — an accidental dismiss can't hide it for long
let backupNudgeBusy = false;
let backupNudgeError = null;

function backupNudgeShouldShow(){
  if (backupNudgeBusy) return true;
  if (!driveBackupEnabled || !driveBackupDirty) return false;
  if (Date.now() < backupNudgeSnoozedUntil) return false;
  return (Date.now() - lastDriveBackupTime) >= DRIVE_BACKUP_STALE_MS;
}

function mountBackupNudge(){
  if (document.getElementById('backup-nudge-banner')) return;
  const el = document.createElement('div');
  el.id = 'backup-nudge-banner';
  el.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:201; display:none; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; padding-top:calc(10px + env(safe-area-inset-top)); background:rgba(214,64,64,0.96); color:#fff; font-size:13.5px; font-weight:700; box-shadow:0 2px 8px rgba(0,0,0,0.35);';
  el.innerHTML = `
    <span id="backup-nudge-text" style="flex:1; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;"></span>
    <span id="backup-nudge-dismiss" style="cursor:pointer; font-weight:800; font-size:16px; line-height:1; padding:6px 8px; margin:-6px -6px -6px 0; -webkit-user-select:none; user-select:none; touch-action:manipulation;">×</span>
  `;
  document.body.appendChild(el);
  document.getElementById('backup-nudge-text').addEventListener('click', runBackupNudge);
  document.getElementById('backup-nudge-dismiss').addEventListener('click', () => {
    backupNudgeSnoozedUntil = Date.now() + BACKUP_NUDGE_SNOOZE_MS;
    backupNudgeError = null;
    renderBackupNudge();
  });
  renderBackupNudge();
}

// attemptDriveBackup(true) is called synchronously from the tap handler
// (nothing awaited first) so Google's popup still counts as user-initiated.
async function runBackupNudge(){
  if (backupNudgeBusy) return;
  // 2026-10-04: the Worker has lost its refresh token (revoked or expired) —
  // reconnect first. connectGoogleViaWorker() opens its popup synchronously,
  // so it must be the first thing this tap does.
  if (googleWorkerState() === 'needs-reconnect'){
    const connectPromise = connectGoogleViaWorker();
    backupNudgeBusy = true;
    backupNudgeError = null;
    renderBackupNudge();
    const c = await connectPromise;
    if (!c.ok){
      backupNudgeBusy = false;
      backupNudgeError = c.message.replace(/\.$/, '');
      renderBackupNudge();
      return;
    }
  } else {
    backupNudgeBusy = true;
    backupNudgeError = null;
    renderBackupNudge();
  }
  const result = await attemptDriveBackup(true);
  backupNudgeBusy = false;
  backupNudgeError = result.ok ? null : driveBackupReasonText(result.reason);
  renderBackupNudge();
  if (result.ok) showToast('Backed up to Drive');
}

function renderBackupNudge(){
  const el = document.getElementById('backup-nudge-banner');
  const textEl = document.getElementById('backup-nudge-text');
  if (!el || !textEl) return;
  if (!backupNudgeShouldShow()){
    el.style.display = 'none';
    backupNudgeError = null; // resolved (backup succeeded elsewhere) or dismissed — don't resurrect a stale error later
    return;
  }
  if (backupNudgeBusy){
    textEl.textContent = 'Backing up to Drive…';
  } else if (backupNudgeError){
    textEl.textContent = `${backupNudgeError} — tap to retry`;
  } else if (googleWorkerState() === 'needs-reconnect'){
    textEl.textContent = 'Automatic backup needs reconnecting to Google — tap to reconnect';
  } else if (lastDriveBackupTime){
    const days = Math.floor((Date.now() - lastDriveBackupTime) / 86400000);
    textEl.textContent = `Drive backup is ${days} day${days === 1 ? '' : 's'} out of date — tap to back up now`;
  } else {
    textEl.textContent = 'No Drive backup yet — tap to back up now';
  }
  el.style.display = 'flex';
  // Sit below whichever of the green silent-confirm banner and the blue
  // catch-up banner are currently showing, rather than over them.
  const green = document.getElementById('silent-confirm-banner');
  const catchup = document.getElementById('catchup-banner');
  let stackTop = 0;
  if (green && green.style.display !== 'none' && green.offsetHeight > 0) stackTop += green.offsetHeight;
  if (catchup && catchup.style.display !== 'none' && catchup.offsetHeight > 0) stackTop += catchup.offsetHeight;
  if (stackTop > 0){
    el.style.top = stackTop + 'px';
    el.style.paddingTop = '10px';
  } else {
    el.style.top = '0';
    el.style.paddingTop = 'calc(10px + env(safe-area-inset-top))';
  }
}

async function syncGoogleCalendarEvent(dateKey){
  const token = await getGoogleAccessToken();
  if (!token) return { ok: false, reason: 'no-token' };

  const eventBody = {
    summary: 'Buy train ticket',
    start: { dateTime: `${dateKey}T20:00:00`, timeZone: 'Europe/London' },
    end: { dateTime: `${dateKey}T20:15:00`, timeZone: 'Europe/London' },
    colorId: '10', // Google Calendar's "Basil" — appears as green, matching the user's usual task color
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }
  };
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  try{
    let method = null;
    const usedEventId = gcalEventId;
    if (gcalEventId){
      const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${gcalEventId}`, {
        method: 'PATCH', headers, body: JSON.stringify(eventBody)
      });
      if (resp.status === 404){
        gcalEventId = null; // stale — someone deleted it manually; fall through to create fresh
      } else if (!resp.ok){
        return { ok: false, reason: `patch-failed-${resp.status}`, eventId: usedEventId, dateKey };
      } else {
        method = 'updated';
      }
    }
    if (!gcalEventId){
      const resp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST', headers, body: JSON.stringify(eventBody)
      });
      if (!resp.ok) return { ok: false, reason: `create-failed-${resp.status}`, dateKey };
      const data = await resp.json();
      gcalEventId = data.id;
      await saveGcalEventId();
      method = 'created';
    }
    gcalPendingSync = false;
    gcalLastSyncFailed = false;
    await saveGcalPendingSync();
    return { ok: true, method, eventId: gcalEventId, dateKey };
  }catch(e){
    return { ok: false, reason: `exception: ${e.message}`, dateKey }; // left pending — will retry next time the prompt is tapped
  }
}

// Removes the tracked reminder entirely, rather than patching it
// forward to a hypothetical next buy date — used when there's currently
// no active ticket at all (a genuine gap). Patching forward in that
// state was the actual bug: the "next buy date" is still a reasonable
// projection to display, but automatically rolling a calendar reminder
// onto it while nothing's actually been bought yet doesn't reflect
// anything concrete. Once a new ticket is logged, normal syncing
// resumes and a fresh reminder gets created for whatever that ticket's
// own next buy date turns out to be.
async function deleteGoogleCalendarEvent(){
  if (!gcalEventId) return { ok: true, method: 'none' }; // nothing tracked — nothing to do
  const token = await getGoogleAccessToken();
  if (!token) return { ok: false, reason: 'no-token' };
  try{
    const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${gcalEventId}`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
    });
    // 404/410 means it's already gone (e.g. deleted manually elsewhere)
    // — a successful outcome from here regardless, not a failure.
    if (!resp.ok && resp.status !== 404 && resp.status !== 410){
      return { ok: false, reason: `delete-failed-${resp.status}` };
    }
    const deletedId = gcalEventId;
    gcalEventId = null;
    await saveGcalEventId();
    gcalPendingSync = false;
    gcalLastSyncFailed = false;
    await saveGcalPendingSync();
    return { ok: true, method: 'deleted', eventId: deletedId };
  }catch(e){
    return { ok: false, reason: `exception: ${e.message}` };
  }
}

// Fires 10 seconds after the buy date last changed, not 10 seconds after
// it was first noticed — each further change resets the clock (see the
// scheduling logic in render()). Re-derives the buy date fresh at fire
// time rather than trusting the value from whenever it was scheduled,
// in case something shifted again in the meantime.
async function fireBuyDateChangeActions(){
  const freshToday = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const freshTodayKey = fmtKey(freshToday);
  const freshNext = findNextBuyDateKey(freshToday, freshTodayKey);
  if (freshNext && freshNext !== lastNotifiedBuyKey){
    if (lastNotifiedBuyKey !== null){ // don't notify on the very first-ever load
      showLocalNotification('Ticket buy date updated', `Now due ${dateLabelShort(parseKey(freshNext))}`);
    }
    if (gcalEnabled){
      gcalPendingSync = true; saveGcalPendingSync();
      // No active ticket right now — delete the tracked reminder rather
      // than patch it forward to this hypothetical date. See
      // deleteGoogleCalendarEvent's own comment for the full reasoning;
      // this is the actual trigger point the original bug came from.
      if (isCurrentlyInTicketGap(freshToday, freshTodayKey)){
        deleteGoogleCalendarEvent().then((result) => { if (result.ok) render(); });
      } else {
        syncGoogleCalendarEvent(freshNext).then((result) => { if (result.ok) render(); });
      }
    }
    lastNotifiedBuyKey = freshNext;
    saveLastNotifiedBuyKey();
    render();
  }
  scheduledBuyKey = null;
  buyDateChangeTimer = null;
}
