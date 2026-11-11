// emergency-routes.js — Emergency route checking and the routes manager.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// Emergency Routes — the "Emergency" Live sub-tab's core check (see
// emergency-routes-spec.md). Walks one route's legs in order, carrying
// forward an "earliest departure time" cursor (starts as "now" for leg
// 1), and returns a fully chained plan or however far it got before a
// leg died.
//
// Per Wayne's steer: a dead leg — no candidate service at all, or the
// only candidate has no determinable arrival time — kills the whole
// route from that point on, whether it's the first leg or a later one.
// Whatever board data *was* returned for the dead leg is kept for
// display rather than discarded, so Wayne can judge for himself whether
// it's a genuine gap or just outside Darwin's lookahead window.
async function checkEmergencyRoute(route){
  let cursor = new Date();
  const legResults = [];
  let status = 'complete';
  // nextDateForTime resolves to "the next occurrence of this clock time
  // at or after cursor" — correct and necessary for a genuine midnight
  // crossing (a 00:12 service really is tomorrow if cursor is 23:50
  // tonight), but with no upper bound it will just as happily resolve a
  // service that simply isn't on the board within any useful lookahead
  // by rolling forward a full 24 hours — e.g. treating "19:40" as
  // tomorrow's 19:40 when cursor is already past today's 19:40. Nothing
  // in the UI shows a date, so that reads as a viable same-evening leg
  // when it's actually a plan spanning two calendar days. Bounding the
  // search to a few hours ahead means a leg that can't be filled within
  // a sane emergency-response window is correctly reported as a dead
  // end instead.
  const MAX_LEG_LOOKAHEAD_MS = 3 * 60 * 60 * 1000;

  for (const leg of route.legs){
    // There's nothing to chain FROM the final leg, so — unlike every
    // earlier leg — a failed arrival-time lookup here doesn't need to
    // kill the route. This matters much more now that a route can be a
    // single leg (the synthetic direct-service check): without this,
    // a real, catchable, on-schedule departure would still show as
    // "Partial" just because GetServiceDetails hiccuped, defeating much
    // of the point of surfacing it.
    const isFinalLeg = leg === route.legs[route.legs.length - 1];
    let board;
    try{
      board = await fetchDebugBoard(leg.from, leg.to);
    }catch(e){
      legResults.push({ from: leg.from, fromName: leg.fromName, to: leg.to, toName: leg.toName, error: e.message, candidate: null, board: [] });
      status = 'partial';
      break;
    }

    // Soonest service departing this station at or after the cursor,
    // within MAX_LEG_LOOKAHEAD_MS, that actually calls at `to`
    // (guaranteed by fetchDebugBoard's own filterCrs) and isn't
    // cancelled — a cancelled service isn't a real candidate no matter
    // how soon it's timetabled.
    let best = null, bestDate = null;
    for (const s of board){
      if (!s.std || s.isCancelled) continue;
      const d = nextDateForTime(s.std, cursor);
      if (!d) continue;
      if (d.getTime() - cursor.getTime() > MAX_LEG_LOOKAHEAD_MS) continue;
      if (!bestDate || d.getTime() < bestDate.getTime()){ bestDate = d; best = s; }
    }
    if (!best){
      legResults.push({ from: leg.from, fromName: leg.fromName, to: leg.to, toName: leg.toName, error: null, candidate: null, board });
      status = 'partial';
      break;
    }

    // GetServiceDetails for the chosen candidate, to read its actual
    // (confirmed/estimated/scheduled) arrival time at `to`. Retried once
    // on a transient failure (network blip, Worker rate-limit — the same
    // "transient" flag fetchServiceDetails already sets elsewhere)
    // before giving up, since losing an otherwise-viable candidate to a
    // single dropped request is a worse outcome than one extra request.
    let arrivalStr = null;
    let detailsFailed = false;
    // best.std is guaranteed present here (the loop above skips any
    // candidate without one), so this is always a departure-board
    // recoveryHint — leg.from is a pure 'dep' board lookup, not 'arr'.
    const recoveryHint = { crs: leg.from, boardType: 'dep', schedTime: best.std };
    for (let attempt = 0; attempt < 2; attempt++){
      try{
        const details = await fetchServiceDetails(best.serviceID, recoveryHint);
        const cp = findCallingPointRaw(details, leg.to);
        arrivalStr = resolveCallingPointClockTime(cp);
        detailsFailed = false;
        break;
      }catch(e){
        detailsFailed = true;
        if (!e.transient) break; // a definitive answer from Darwin — retrying won't change it
      }
    }
    // NOTE: there is deliberately no fallback here to any field on
    // `best` itself (e.g. best.sta/best.eta) — those describe arrival
    // AT `leg.from` (the board station just queried), not at `leg.to`
    // (the leg's destination, further down this service's calling
    // points). An earlier version of this code read best.sta/best.eta
    // as if it were the destination's arrival time, which — for a
    // service also shown as on-time arriving at its OWN board station —
    // could literally be the string "On time" rather than a clock time,
    // silently killing the whole chain from that point on. If
    // GetServiceDetails can't be reached at all, there's genuinely no
    // other place in this response to read the destination's arrival
    // time from.

    let arrivalDate = arrivalStr ? nextDateForTime(arrivalStr, bestDate) : null;
    // Direct sanity check, independent of exactly which field-reading
    // issue might cause it: an arrival can never be before its own
    // departure. This has now been hit via three different underlying
    // causes (a wrong fallback field, Darwin's own "On time" text, and
    // findCallingPointRaw matching an earlier occurrence of the same
    // station code) — rather than trust the next explanation to be the
    // last one, treat an impossible result the same as "couldn't
    // determine arrival" and stop the chain there instead of silently
    // showing a nonsense time.
    if (arrivalDate && arrivalDate.getTime() < bestDate.getTime()) arrivalDate = null;
    legResults.push({
      from: leg.from, fromName: leg.fromName, to: leg.to, toName: leg.toName,
      error: null,
      candidate: {
        serviceId: best.serviceID,
        std: best.std,
        etd: best.etd || null,
        platform: best.platform || null,
        arrivalStr: arrivalDate ? arrivalStr : null,
        // A plain timestamp (not the Date itself) so the result stays
        // simple to reason about — used by the Emergency tab to sort a
        // completed route by how soon it actually gets Wayne home/to
        // work, without needing to re-derive it from arrivalStr later.
        arrivalTimestamp: arrivalDate ? arrivalDate.getTime() : null,
        // Distinguishes "found a real train but couldn't confirm its
        // arrival time" from "found a real train and everything's
        // fine" — both leave arrivalStr null-ish downstream today, but
        // this lets the UI say which actually happened rather than
        // just silently dropping the "due" text either way.
        arrivalLookupFailed: detailsFailed || !arrivalDate,
      },
      board: null,
    });

    if (!arrivalDate && !isFinalLeg){
      // Found a real, running service, but couldn't work out when it
      // arrives at `to` — nothing safe to chain onward from, so this
      // still counts as a dead end for the remaining legs even though
      // this leg itself did resolve to a real train.
      status = 'partial';
      break;
    }
    if (arrivalDate){
      // 5-minute minimum interchange buffer before searching the next
      // leg — was 10, reduced after a real near-miss: a genuinely
      // catchable Liverpool Lime Street connection (9 minutes after the
      // previous leg's arrival) was being excluded by the old, more
      // conservative figure.
      cursor = new Date(arrivalDate.getTime() + 5 * 60 * 1000);
    }
  }

  return { id: route.id, label: route.label, legs: legResults, status };
}

async function checkAllEmergencyRoutes(routes){
  const results = [];
  // Sequential, not parallel — each route's own legs are already
  // inherently sequential (leg N+1 depends on leg N's resolved
  // cursor), and running multiple routes' worth of Darwin calls
  // concurrently adds nothing but risk of hitting the Worker's
  // subrequest budget for no real speed benefit on an on-demand,
  // manually-triggered check.
  for (const route of routes){
    // checkEmergencyRoute already catches every failure mode it
    // anticipates (board fetch, service details, no candidate) and
    // returns a partial result instead of throwing — but if something
    // truly unexpected slipped through anyway, letting it escape here
    // would abort this whole for-loop, silently dropping every route
    // not yet checked (this loop's own routes AND, seen from the
    // caller, wiping emergencyResults back to [] entirely via the
    // outer catch). One route unexpectedly failing should mean one
    // route missing, never all of them.
    try{
      results.push(await checkEmergencyRoute(route));
    }catch(e){
      results.push({ id: route.id, label: route.label, legs: [{ from: route.legs[0] && route.legs[0].from, fromName: route.legs[0] && route.legs[0].fromName, to: route.legs[0] && route.legs[0].to, toName: route.legs[0] && route.legs[0].toName, error: e.message || 'unexpected error', candidate: null, board: [] }], status: 'partial' });
    }
  }
  return results;
}

// Author pre-defined fallback routes for the "Emergency" Live sub-tab
// (see emergency-routes-spec.md). Edits a private draft — Save/Cancel
// work the same way as openRailConfig above, so nothing here touches
// the live alternativeRoutes list until Save is actually pressed.
// Both from/to code AND name are captured at authoring time via
// createStationPicker, so display never depends on stationIndexCache
// being loaded later.
function openAlternativeRoutesManager(cameFromSettings){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  let draftRoutes = alternativeRoutes.map(r => ({ ...r, legs: r.legs.map(l => ({ ...l })) }));
  // Station pickers are live components with their own internal state,
  // not plain inputs — re-created on every render() call, so their
  // onChange handlers always close over the current draftRoutes/render
  // rather than a stale copy from an earlier render.
  function renderRoute(route, ri){
    const legRows = route.legs.map((leg, li) => `
      <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px;">
        <span style="color:var(--ink-dim); font-size:12px; width:14px;">${li + 1}</span>
        <div id="ar-${ri}-${li}-from" style="flex:1;"></div>
        <span style="color:var(--ink-dim);">→</span>
        <div id="ar-${ri}-${li}-to" style="flex:1;"></div>
        <span class="modal-close" data-remove-leg data-ri="${ri}" data-li="${li}" style="margin:0; font-size:12px;">✕</span>
      </div>`).join('');
    return `
      <div class="rail-detail-row" style="display:block; padding:12px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
          <input type="text" class="ar-label-input" data-ri="${ri}" value="${escapeHtml(route.label || '')}" placeholder="Route label (e.g. Via Liverpool)"
            style="flex:1; padding:8px; border-radius:8px; border:1px solid var(--line); background:var(--tile); color:var(--ink); box-sizing:border-box;" />
          <span class="modal-close" data-remove-route data-ri="${ri}" style="margin:0; font-size:13px;">Remove route</span>
        </div>
        ${route.legs.length ? legRows : '<div class="sub" style="margin-bottom:8px;">No legs yet — add at least one.</div>'}
        <div class="settings-link" data-add-leg data-ri="${ri}" style="margin-top:2px;">+ Add leg</div>
      </div>`;
  }

  function stationStatusHtml(){
    // renderMatches (inside createStationPicker) reads stationIndexCache
    // live on every keystroke, not just at picker construction — so this
    // status line is informational rather than gating anything, but
    // without ever calling loadStationIndex() at all, the cache would
    // simply never populate and typed station names would never resolve
    // to anything (only an exact 3-letter code, committed on blur, would
    // work at all).
    if (stationIndexCache){
      const date = stationIndexCache.fetchedAt ? new Date(stationIndexCache.fetchedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'unknown date';
      return `${stationIndexCache.list.length.toLocaleString()} stations · updated ${date} — <span id="ar-station-refresh-link" style="text-decoration:underline; cursor:pointer;">Refresh</span>`;
    }
    return `Loading station list… codes still work meanwhile (e.g. CRE, WGN).`;
  }

  function render(){
    overlay.innerHTML = `
      ${uiPageBar('Emergency routes', { backId: 'ar-close', backLabel: cameFromSettings ? 'Back to Settings' : 'Back', saveId: 'ar-save' })}
      <div class="ui-page-body">
        <div class="sub">Pre-define fallback journeys now, when calm, so the Emergency tab can check them live when disruption actually hits.</div>
        <div class="sub" id="ar-station-status" style="font-size:11.5px; margin-bottom:12px;">${stationStatusHtml()}</div>
        <div id="ar-list">${draftRoutes.map((r, ri) => renderRoute(r, ri)).join('') || '<div class="sub">No routes yet.</div>'}</div>
        <div class="settings-link" id="ar-add-route" style="margin-top:6px; margin-bottom:16px;">+ Add route</div>
      </div>
    `;

    const refreshLink = document.getElementById('ar-station-refresh-link');
    if (refreshLink) refreshLink.addEventListener('click', () => {
      loadStationIndex(true).then(() => { if (overlay.isConnected){ syncLabelsFromInputs(); render(); } }).catch(() => { if (overlay.isConnected){ syncLabelsFromInputs(); render(); } });
    });

    // Wire a station picker into every leg's from/to placeholder.
    draftRoutes.forEach((route, ri) => {
      route.legs.forEach((leg, li) => {
        const fromPicker = createStationPicker({
          placeholder: 'From',
          initialCode: leg.from,
          initialName: leg.fromName,
          onChange: (code, name) => { leg.from = code; leg.fromName = name; }
        });
        const toPicker = createStationPicker({
          placeholder: 'To',
          initialCode: leg.to,
          initialName: leg.toName,
          onChange: (code, name) => { leg.to = code; leg.toName = name; }
        });
        document.getElementById(`ar-${ri}-${li}-from`).appendChild(fromPicker.el);
        document.getElementById(`ar-${ri}-${li}-to`).appendChild(toPicker.el);
      });
    });

    overlay.querySelectorAll('[data-add-leg]').forEach(el => {
      el.addEventListener('click', () => {
        syncLabelsFromInputs();
        const ri = Number(el.dataset.ri);
        draftRoutes[ri].legs.push({ from: null, fromName: null, to: null, toName: null });
        render();
      });
    });
    overlay.querySelectorAll('[data-remove-leg]').forEach(el => {
      el.addEventListener('click', () => {
        syncLabelsFromInputs();
        const ri = Number(el.dataset.ri), li = Number(el.dataset.li);
        draftRoutes[ri].legs.splice(li, 1);
        render();
      });
    });
    overlay.querySelectorAll('[data-remove-route]').forEach(el => {
      el.addEventListener('click', () => {
        // Read every label field back into the draft before the row
        // that's about to disappear takes its sibling inputs' DOM state
        // with it — otherwise unrelated in-flight label edits made just
        // before tapping Remove would be lost on the next render.
        syncLabelsFromInputs();
        const ri = Number(el.dataset.ri);
        draftRoutes.splice(ri, 1);
        render();
      });
    });
    document.getElementById('ar-add-route').addEventListener('click', () => {
      syncLabelsFromInputs();
      draftRoutes.push({ id: `route-${Date.now()}`, label: '', legs: [] });
      render();
    });

    document.getElementById('ar-save').addEventListener('click', async () => {
      syncLabelsFromInputs();
      // A route with no legs, or a leg missing a from/to, can't ever be
      // checked — drop those rather than saving something the Emergency
      // tab would just fail to make sense of later.
      alternativeRoutes = draftRoutes
        .map(r => ({ ...r, legs: r.legs.filter(l => l.from && l.to) }))
        .filter(r => r.legs.length > 0);
      await saveAlternativeRoutes();
      overlay.remove();
      if (cameFromSettings) openSettingsMenu();
    });
    document.getElementById('ar-close').addEventListener('click', () => {
      overlay.remove();
      if (cameFromSettings) openSettingsMenu();
    });
  }

  function syncLabelsFromInputs(){
    overlay.querySelectorAll('.ar-label-input').forEach(input => {
      const route = draftRoutes[Number(input.dataset.ri)];
      if (route) route.label = input.value;
    });
  }

  document.body.appendChild(overlay);
  render();
  // Kick off the load once, in the background — render() above already
  // showed a usable screen (bare codes work immediately), and this
  // re-renders on completion so name matching starts working without
  // needing to close and reopen the screen.
  if (!stationIndexCache){
    loadStationIndex(false).then(() => { if (overlay.isConnected){ syncLabelsFromInputs(); render(); } }).catch(() => { if (overlay.isConnected){ syncLabelsFromInputs(); render(); } });
  }
}
