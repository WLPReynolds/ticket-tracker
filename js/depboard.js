// depboard.js — Split-flap station board.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// Builds one row's worth of display data from a raw Darwin board entry,
// for the retro departure-board view. Shared between the departures and
// arrivals panels — isArrivals picks which time/place fields matter.
function depBoardRowData(s, isArrivals){
  const time = isArrivals ? (s.sta || '?') : (s.std || '?');
  // On a departures row, "via" (present on destination[0] whenever a
  // service's route needs disambiguating — confirmed against real
  // responses, e.g. "Cardiff Central via Shrewsbury") is exactly what a
  // real board shows alongside the destination. There's no equivalent
  // field for an arrival's origin side, so this only ever applies going
  // one way.
  let place;
  if (isArrivals){
    place = (s.origin && s.origin[0] && s.origin[0].locationName) || '?';
  } else {
    const dest = s.destination && s.destination[0];
    place = dest ? `${dest.locationName || '?'}${dest.via ? ` ${dest.via}` : ''}` : '?';
  }
  const platform = s.platform || '';
  let expected;
  if (s.isCancelled){
    expected = 'Cancelled';
  } else {
    const liveField = isArrivals ? s.eta : s.etd;
    expected = (!liveField || liveField === 'On time') ? 'On time' : liveField;
  }
  // The closest real equivalent to a classic board's occasional note row
  // (e.g. "Calls at Didcot Parkway") — Darwin doesn't give a curated list
  // of "principal" calling points to reproduce that specific convention
  // faithfully, but a genuine delay/cancellation reason is real data and
  // serves the same "extra line under this service" purpose.
  const note = s.isCancelled ? (s.cancelReason || '') : (s.delayReason || '');
  return { time, place, platform, expected, note, isCancelled: !!s.isCancelled };
}

function openDepartureBoardView(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay-full';
  overlay.style.alignItems = 'stretch';
  overlay.innerHTML = `
    <div class="modal" style="display:flex; flex-direction:column; padding:0 0 calc(72px + env(safe-area-inset-bottom)) 0; border-radius:0; overflow:hidden;">
      <!-- Height comes from .modal-overlay-full .modal's own 100dvh rule
           now, not a bespoke calc here — that's the same rule Train
           Progress already relies on with no reported bleed-through, so
           matching it directly rather than maintaining a second,
           separately-tuned height formula that turned out to leave a
           gap at the bottom where the backdrop (and the page underneath
           it) showed through. Bottom padding explicitly matches that
           same class's own nav-bar-safe reservation — zeroing all
           padding here (as the previous version did) would have quietly
           thrown that away too, trapping Close underneath the nav bar
           instead of leaving a visible gap, a related but different
           problem this needs to avoid re-introducing. -->
      <div id="depboard-picker-step" style="flex:1; display:flex; flex-direction:column; padding:20px 18px; overflow-y:auto;">
        <h3>Station board</h3>
        <div class="sub">A retro-style live departures and arrivals board for any station — refreshes every 30 seconds for 3 minutes, then waits for you to ask for more.</div>
        <div id="depboard-picker-row" style="margin:14px 0;"></div>
        <button class="save-btn" id="depboard-show-btn">Show board</button>
        <div class="modal-close" id="depboard-picker-close-btn" style="margin-top:16px;">Close</div>
      </div>
      <div id="depboard-display-step" style="display:none; flex-direction:column; flex:1; min-height:0;">
        <div id="depboard-dep-panel" class="depboard-panel" style="flex:1;"></div>
        <div id="depboard-arr-panel" class="depboard-panel" style="flex:1; border-top:2px solid #333;"></div>
        <div id="depboard-refresh-wrap" style="text-align:center; padding:10px 14px 0; background:var(--board-2);"></div>
        <div class="modal-close" id="depboard-close-btn" style="margin-top:8px; margin-bottom:8px; background:var(--board-2);">Close</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const picker = createStationPicker({ placeholder: 'Station name or code' });
  document.getElementById('depboard-picker-row').appendChild(picker.el);
  // Warms the shared station-name cache — without this, typing a name
  // (rather than a bare code) has nothing to match against yet, since
  // this is a fresh screen that's never triggered the load the way the
  // Tracked tab's own search does.
  loadStationIndex(false);
  document.getElementById('depboard-picker-close-btn').addEventListener('click', () => {
    teardown();
    if (overlay.isConnected) document.body.removeChild(overlay);
  });

  const ROWS_PER_PAGE = 5;
  const SESSION_LENGTH_MS = 3 * 60 * 1000;
  const REFRESH_INTERVAL_MS = 30 * 1000;
  const PAGE_CYCLE_MS = 6 * 1000;

  let active = true;
  let depRows = [], arrRows = [];
  let depPage = 0, arrPage = 0;
  let dataTimer = null;
  let sessionTimeout = null;
  let pageCycleTimer = null;
  let clockTimer = null;
  let stationCrs = null, stationName = '';
  let depFetchError = null, arrFetchError = null;

  function stopPolling(){
    if (dataTimer){ clearInterval(dataTimer); dataTimer = null; }
    if (sessionTimeout){ clearTimeout(sessionTimeout); sessionTimeout = null; }
    if (pageCycleTimer){ clearInterval(pageCycleTimer); pageCycleTimer = null; }
    if (clockTimer){ clearInterval(clockTimer); clockTimer = null; }
  }
  function teardown(){
    active = false;
    stopPolling();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  // Leaving the screen — closing it outright, or just switching away
  // from the tab/app — stops polling immediately, same discipline as
  // the train-progress screen. A board left open in the background has
  // no reason to keep refreshing twice a minute.
  function onVisibilityChange(){
    if (document.visibilityState === 'hidden') stopPolling();
    else if (active && overlay.isConnected && !dataTimer && !sessionTimeout) startSession();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.getElementById('depboard-close-btn').addEventListener('click', () => {
    teardown();
    if (overlay.isConnected) document.body.removeChild(overlay);
  });

  function renderPanel(panelId, title, rows, page, isArrivals, fetchError){
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
    const safePage = page % totalPages;
    const pageRows = rows.slice(safePage * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE + ROWS_PER_PAGE);
    const clock = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Europe/London' });
    // A failed fetch is shown outright rather than quietly presented as
    // an empty board — this is the actual content of the screen, not a
    // decorative extra, so silently hiding *why* it's empty just hides
    // a real problem behind what looks like a legitimately quiet board.
    const rowsHtml = fetchError
      ? `<div style="padding:10px 0; color:#ff6a5a; font-size:12px;">Couldn't load: ${escapeHtml(fetchError)}</div>`
      : (pageRows.length ? pageRows.map(s => {
      const d = depBoardRowData(s, isArrivals);
      const noteHtml = d.note ? `<div class="depboard-note-row">${escapeHtml(d.note)}</div>` : '';
      return `<div class="depboard-row${d.isCancelled ? ' cancelled' : ''}">
        <span>${escapeHtml(d.time)}</span>
        <span>${escapeHtml(d.place)}</span>
        <span>${escapeHtml(d.platform)}</span>
        <span>${escapeHtml(d.expected)}</span>
      </div>${noteHtml}`;
    }).join('') : `<div style="padding:10px 0; opacity:0.7;">No services currently shown</div>`);
    panel.innerHTML = `
      <div class="depboard-title">${escapeHtml(stationName)} — ${title}</div>
      <div class="depboard-header-row">
        <span>Time</span><span>${isArrivals ? 'From' : 'Destination'}</span><span>Plat</span><span>Expected</span>
      </div>
      <div class="depboard-rows-wrap">${rowsHtml}</div>
      <div class="depboard-footer">
        <span>Page ${safePage + 1} of ${totalPages}</span>
        <span>${clock}</span>
      </div>
    `;
  }
  function renderBoth(){
    if (!active) return;
    renderPanel('depboard-dep-panel', 'Departures', depRows, depPage, false, depFetchError);
    renderPanel('depboard-arr-panel', 'Arrivals', arrRows, arrPage, true, arrFetchError);
  }

  async function fetchData(){
    if (!stationCrs) return;
    // Fetched independently (not a single combined try/catch) so one
    // board failing doesn't hide data the other genuinely got back —
    // and each panel gets its own specific error rather than one vague
    // failure blamed on both.
    const [depResult, arrResult] = await Promise.allSettled([
      fetchPureBoard(stationCrs, 'dep', 30),
      fetchPureBoard(stationCrs, 'arr', 30)
    ]);
    if (!active) return;
    if (depResult.status === 'fulfilled'){ depRows = depResult.value; depFetchError = null; }
    else { depFetchError = depResult.reason.message; }
    if (arrResult.status === 'fulfilled'){ arrRows = arrResult.value; arrFetchError = null; }
    else { arrFetchError = arrResult.reason.message; }
    // Only reset a page if the new row count actually makes the current
    // one invalid — not unconditionally on every 30-second poll. The
    // old version zeroed both every single fetch, fighting the separate
    // page-cycle timer so hard that a page only ever reached its true
    // maximum after the whole session had already ended.
    const depTotalPages = Math.max(1, Math.ceil(depRows.length / ROWS_PER_PAGE));
    const arrTotalPages = Math.max(1, Math.ceil(arrRows.length / ROWS_PER_PAGE));
    if (depPage >= depTotalPages) depPage = 0;
    if (arrPage >= arrTotalPages) arrPage = 0;
    renderBoth();
  }

  function showRefreshButton(){
    const wrap = document.getElementById('depboard-refresh-wrap');
    if (!wrap) return;
    // Same icon-based style already established for the Tracked list's
    // own refresh action, rather than the plain "↻ Refresh" text this
    // used before — one consistent look for "refresh this" across the
    // app instead of two different ones.
    wrap.innerHTML = `<span id="depboard-refresh-btn" style="display:inline-flex; align-items:center; gap:6px; color:var(--good); font-size:14px; font-weight:700; cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">${REFRESH_ICON} Refresh</span>`;
    const btn = document.getElementById('depboard-refresh-btn');
    if (btn) btn.addEventListener('click', () => { if (active) startSession(); });
  }

  function startSession(){
    const wrap = document.getElementById('depboard-refresh-wrap');
    if (wrap) wrap.innerHTML = ''; // dropped while a session is live — reappears once it ends
    if (dataTimer){ clearInterval(dataTimer); dataTimer = null; }
    if (sessionTimeout){ clearTimeout(sessionTimeout); sessionTimeout = null; }
    fetchData();
    dataTimer = setInterval(fetchData, REFRESH_INTERVAL_MS);
    sessionTimeout = setTimeout(() => {
      if (dataTimer){ clearInterval(dataTimer); dataTimer = null; }
      sessionTimeout = null;
      showRefreshButton();
    }, SESSION_LENGTH_MS);
  }

  document.getElementById('depboard-show-btn').addEventListener('click', () => {
    stationCrs = picker.getCode();
    stationName = picker.getName() || stationCrs;
    if (!stationCrs) return;
    document.getElementById('depboard-picker-step').style.display = 'none';
    const displayStep = document.getElementById('depboard-display-step');
    displayStep.style.display = 'flex';
    // Ticks the visible clock every second, and separately advances
    // which page each panel is showing every few seconds if there's
    // more than one — independent of the 30-second data refresh, same
    // as a real board's clock keeps moving between actual data changes.
    clockTimer = setInterval(renderBoth, 1000);
    pageCycleTimer = setInterval(() => {
      const depTotalPages = Math.max(1, Math.ceil(depRows.length / ROWS_PER_PAGE));
      const arrTotalPages = Math.max(1, Math.ceil(arrRows.length / ROWS_PER_PAGE));
      depPage = (depPage + 1) % depTotalPages;
      arrPage = (arrPage + 1) % arrTotalPages;
    }, PAGE_CYCLE_MS);
    startSession();
  });
}
