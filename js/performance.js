// performance.js — Performance history and statistics.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

function openRailDetail(key){
  const d = parseKey(key);
  const dayPerf = railPerfCache[key] || {};
  const amTrains = railTrains.filter(t => t.direction === 'AM').sort((a, b) => a.time.localeCompare(b.time));
  const pmTrains = railTrains.filter(t => t.direction === 'PM').sort((a, b) => a.time.localeCompare(b.time));

  // Stage 7 (2026-11-13): a bottom sheet. reopen() closes it and opens a
  // fresh one, so a claim tap is reflected straight away.
  const none = '<div class="rail-detail-row"><span class="ui-dim">None configured</span></div>';
  const sheet = uiOpenSheet(dateLabel(d), `
      <div class="ui-sheet-sub">Performance for your configured trains this day.</div>
      <div class="claims-cols">
        <div><div class="rail-col-header">Morning</div>${amTrains.length ? railDetailRowsForClaim(amTrains, dayPerf, key, 'AM') : none}</div>
        <div><div class="rail-col-header">Evening</div>${pmTrains.length ? railDetailRowsForClaim(pmTrains, dayPerf, key, 'PM') : none}</div>
      </div>`, { id: 'rail-detail-sheet' });
  wireClaimHandlers(sheet.overlay, () => { sheet.close(); openRailDetail(key); });
}

// Full performance history — every day railPerfCache has ever recorded
// (it's kept permanently, not just the rolling window the day list
// shows), against every currently configured usual train, as a table:
// trains across the top (sticky), dates down the side (sticky), both
// axes scrollable since a few months of data with several trains
// configured won't fit either dimension on a phone screen. Tapping a
// delayed cell with a recorded reason code shows what it was.
// Renders (or re-renders, if called again on an already-open overlay)
// the Performance history modal's contents from whatever's currently in
// railPerfCache — kept as its own function, rather than inline in
// openPerformanceHistoryView, so it can be called a second time once
// railSyncFullHistory's background fetch resolves, to reflect the freshly
// backfilled data without closing and reopening the modal.
// A small trending-line glyph — same stroke-icon style used throughout
// (viewBox 24x24, currentColor stroke) — signalling "more statistics
// live behind this button" from the Performance history header.
const PERF_STATS_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l4-5 3 3 5-7"/><circle cx="7" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="11" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="14" cy="13" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="6" r="1.2" fill="currentColor" stroke="none"/></svg>';

function renderPerfHistoryInto(overlay, syncing){
  const amTrains = railTrains.filter(t => t.direction === 'AM').sort((a, b) => a.time.localeCompare(b.time));
  const pmTrains = railTrains.filter(t => t.direction === 'PM').sort((a, b) => a.time.localeCompare(b.time));
  const orderedTrains = [...amTrains, ...pmTrains];

  const dateKeys = Object.keys(railPerfCache).sort((a, b) => (a < b ? 1 : (a > b ? -1 : 0))); // most recent first

  // A train that ran early counts as 0 delay here rather than pulling
  // the average below zero — both averages below are meant to answer
  // "how late does my train usually run", not track signed deviation
  // from schedule. Cancelled entries (delayMinutes: null) are excluded
  // from both rather than counted as some assumed delay value, since
  // there's no single "right" number to stand in for a cancellation.
  function averageFor(trains){
    let total = 0, count = 0;
    for (const dateKey of dateKeys){
      const dayPerf = railPerfCache[dateKey];
      for (const t of trains){
        const perf = dayPerf[t.key];
        if (!perf || typeof perf.delayMinutes !== 'number') continue;
        total += Math.max(0, perf.delayMinutes);
        count++;
      }
    }
    return count > 0 ? total / count : null;
  }
  const amAvg = amTrains.length ? averageFor(amTrains) : null;
  const pmAvg = pmTrains.length ? averageFor(pmTrains) : null;
  const avgItemHtml = (label, avg) => `
    <div class="perf-history-avg-item">
      <div class="avg-label">${label} avg delay</div>
      <div class="avg-value">${avg === null ? '—' : `${avg.toFixed(1)} min`}</div>
    </div>`;

  // Per-train averages — same "clamp early trains to 0, exclude
  // cancellations" treatment as the AM/PM figures above, just computed
  // per train instead of per direction.
  const perTrainAvg = t => averageFor([t]);
  const trainChipHtml = t => `
    <div class="perf-history-train-chip">
      <div class="chip-label">${escapeHtml(t.label)} <span style="opacity:0.6;">${escapeHtml(t.direction)}</span></div>
      <div class="chip-value">${(() => { const a = perTrainAvg(t); return a === null ? '—' : `${a.toFixed(1)}m`; })()}</div>
    </div>`;

  function cellHtml(dateKey, train){
    const perf = (railPerfCache[dateKey] || {})[train.key];
    if (!perf){
      return `<td style="color:var(--ink-dim);">–</td>`;
    }
    if (perf.cancelled){
      const attrs = perf.reason ? ` data-perf-date="${dateKey}" data-perf-train="${escapeHtml(train.key)}"` : '';
      return `<td class="perf-history-cell delay-cancelled"${attrs}>Cancelled</td>`;
    }
    if (typeof perf.delayMinutes !== 'number'){
      return `<td style="color:var(--ink-dim);">–</td>`;
    }
    const mins = perf.delayMinutes;
    let cls = '';
    if (mins >= DELAY_REPAY_THRESHOLD_MINUTES) cls = 'delay-red';
    else if (mins > 0) cls = 'delay-amber';
    const text = mins <= 0 ? 'On time' : `${mins} min`;
    // Only wired up as tappable if there's actually a reason recorded
    // for it — an on-time row or one with no reason code just isn't
    // interactive, rather than showing an empty toast on tap.
    const tappable = mins > 0 && perf.reason;
    const attrs = tappable ? ` data-perf-date="${dateKey}" data-perf-train="${escapeHtml(train.key)}"` : '';
    return `<td class="perf-history-cell${cls ? ` ${cls}` : ''}"${attrs}>${text}</td>`;
  }

  const headerCellsHtml = orderedTrains.map(t =>
    `<th>${escapeHtml(t.label)}<br><span style="font-weight:400; opacity:0.7;">${escapeHtml(t.direction)}</span></th>`
  ).join('');
  const rowsHtml = dateKeys.map(dateKey => `
    <tr>
      <td>${escapeHtml(dateLabelShort(parseKey(dateKey)))}</td>
      ${orderedTrains.map(t => cellHtml(dateKey, t)).join('')}
    </tr>
  `).join('');

  const tableHtml = (orderedTrains.length === 0)
    ? `<div class="sub" style="padding:0 18px;">No usual trains configured yet — set them up under More → Settings first.</div>`
    : (dateKeys.length === 0
      ? `<div class="sub" style="padding:0 18px;">${syncing ? 'Fetching performance history…' : 'No performance data recorded yet.'}</div>`
      : `<div class="perf-history-scroll">
          <table class="perf-history-table">
            <thead><tr><th>Date</th>${headerCellsHtml}</tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`);

  const trainChipsHtml = orderedTrains.length > 1
    ? `<div class="perf-history-train-chips">${orderedTrains.map(trainChipHtml).join('')}</div>`
    : '';

  const canLoadMore = railHistoryDaysBack < RAIL_HISTORY_MAX_DAYS_BACK;

  overlay.querySelector('.modal').innerHTML = `
    <div style="padding:20px 18px 10px; flex-shrink:0; display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
      <div>
        <h3>Performance history</h3>
        <div class="sub" style="margin-bottom:0;">
          Tap a delayed or cancelled entry to see details
          ${syncing ? ' — backfilling more history in the background…' : ''}
        </div>
      </div>
      <div id="perf-history-stats-btn" class="perf-history-icon-btn" title="Statistics">${PERF_STATS_ICON}</div>
    </div>
    ${trainChipsHtml}
    ${tableHtml}
    <div class="perf-history-avg-bar">
      ${avgItemHtml('Morning', amAvg)}
      ${avgItemHtml('Evening', pmAvg)}
    </div>
    <div style="display:flex; gap:10px; margin:10px 18px; flex-shrink:0;">
      ${canLoadMore ? `<div class="day-nav-btn" id="perf-history-load-more" style="flex:1; margin:0;">Load more history</div>` : ''}
      <div class="modal-close" id="perf-history-close-btn" style="flex:1; margin:0; background:var(--board-2); border:1px solid var(--line); border-radius:10px; padding:10px; display:flex; align-items:center; justify-content:center;">Close</div>
    </div>
  `;

  const statsBtn = overlay.querySelector('#perf-history-stats-btn');
  if (statsBtn) statsBtn.addEventListener('click', () => openPerformanceStatsView());

  overlay.querySelectorAll('.perf-history-cell[data-perf-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      const dateKey = cell.dataset.perfDate;
      const trainKey = cell.dataset.perfTrain;
      const perf = (railPerfCache[dateKey] || {})[trainKey];
      if (!perf) return;
      const text = describeReasonCode(perf.reason, !!perf.cancelled);
      if (text) showToast(text);
    });
  });

  const loadMoreBtn = overlay.querySelector('#perf-history-load-more');
  if (loadMoreBtn){
    loadMoreBtn.addEventListener('click', async () => {
      railHistoryDaysBack = Math.min(railHistoryDaysBack + RAIL_HISTORY_STEP_DAYS, RAIL_HISTORY_MAX_DAYS_BACK);
      await saveRailHistoryDaysBack();
      renderPerfHistoryInto(overlay, true);
      await railSyncFullHistory();
      if (document.body.contains(overlay)) renderPerfHistoryInto(overlay, false);
    });
  }

  const closeBtn = overlay.querySelector('#perf-history-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => { document.body.removeChild(overlay); });
}

// Full performance history — every weekday within railHistoryDaysBack
// (backfilled regardless of whether it was a day you actually
// travelled — see railSyncFullHistory), against every currently
// configured usual train, as a table: trains across the top (sticky),
// dates down the side (sticky), both axes scrollable since a few months
// of data with several trains configured won't fit either dimension on
// a phone screen. Tapping a delayed or cancelled cell with a recorded
// reason code shows what it was. Opens immediately with whatever's
// already cached (fast), then backfills any gap in the background and
// re-renders in place once that resolves — a fresh device or a newly
// widened window can otherwise mean a genuinely long wait before there's
// anything to show at all.
function openPerformanceHistoryView(){
  // Best-effort refresh — a stale/missing table just means reason taps
  // fall back to "description not loaded yet" until this resolves.
  ensureReasonCodes();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay-full';
  overlay.style.alignItems = 'stretch';
  overlay.innerHTML = `<div class="modal" style="display:flex; flex-direction:column; padding:0 0 calc(72px + env(safe-area-inset-bottom)) 0; border-radius:0; overflow:hidden;"></div>`;
  document.body.appendChild(overlay);

  renderPerfHistoryInto(overlay, true);
  railSyncFullHistory().then(() => {
    if (document.body.contains(overlay)) renderPerfHistoryInto(overlay, false);
  });
}

// Statistics behind the Performance history table — most common delay
// and cancellation reasons, and which weekday tends to run latest in the
// morning vs the evening. Scoped to whatever's currently backfilled
// (same railPerfCache dateKeys the table itself uses), not re-fetched or
// widened independently of it. Opens as its own overlay stacked on top
// of the history view, so Close just reveals that underneath again.
function openPerformanceStatsView(){
  const dateKeys = Object.keys(railPerfCache);
  const amTrains = railTrains.filter(t => t.direction === 'AM');
  const pmTrains = railTrains.filter(t => t.direction === 'PM');

  // Reason tallies — delays and cancellations kept separate since the
  // same code carries different text (and a different meaning) for
  // each. Only entries that actually got a reason from HSP count; a lot
  // of delays never do, so this is "most common reason, of the ones
  // that gave one" rather than a claim to cover every delay.
  const delayReasonCounts = {};
  const cancelReasonCounts = {};
  for (const dateKey of dateKeys){
    const dayPerf = railPerfCache[dateKey];
    for (const trainKey in dayPerf){
      const perf = dayPerf[trainKey];
      if (!perf || !perf.reason) continue;
      if (perf.cancelled){
        cancelReasonCounts[perf.reason] = (cancelReasonCounts[perf.reason] || 0) + 1;
      } else if (typeof perf.delayMinutes === 'number' && perf.delayMinutes > 0){
        delayReasonCounts[perf.reason] = (delayReasonCounts[perf.reason] || 0) + 1;
      }
    }
  }
  function topReasons(counts, cancelled){
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, count]) => ({ text: describeReasonCode(code, cancelled), count }));
  }
  const topDelayReasons = topReasons(delayReasonCounts, false);
  const topCancelReasons = topReasons(cancelReasonCounts, true);
  const reasonRowHtml = r => `
    <div class="perf-stats-reason-row">
      <div class="perf-stats-reason-text">${escapeHtml(r.text)}</div>
      <div class="perf-stats-reason-count">${r.count}×</div>
    </div>`;

  // Weekday rankings — average delay (same "clamp early trains to 0,
  // exclude cancellations" treatment used throughout this page) per
  // weekday, for AM and PM trains separately. Only Mon–Fri, since the
  // backfill itself is weekdays-only. Each row also carries wd (the
  // numeric weekday) and trains (the direction's own train list), so the
  // per-train breakdown can be computed lazily when a row's expanded
  // rather than for every weekday up front.
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function weekdayAverages(trains){
    const totals = {}, counts = {};
    for (const dateKey of dateKeys){
      const wd = parseKey(dateKey).getDay();
      if (wd === 0 || wd === 6) continue;
      const dayPerf = railPerfCache[dateKey];
      for (const t of trains){
        const perf = dayPerf[t.key];
        if (!perf || typeof perf.delayMinutes !== 'number') continue;
        totals[wd] = (totals[wd] || 0) + Math.max(0, perf.delayMinutes);
        counts[wd] = (counts[wd] || 0) + 1;
      }
    }
    return [1, 2, 3, 4, 5]
      .filter(wd => counts[wd] > 0)
      .map(wd => ({ wd, day: WEEKDAY_NAMES[wd], avg: totals[wd] / counts[wd], trains }))
      .sort((a, b) => b.avg - a.avg);
  }
  // Same clamp/exclude treatment, narrowed to one specific train and
  // weekday — what a row's detail expands into.
  function trainAverageForWeekday(train, wd){
    let total = 0, count = 0;
    for (const dateKey of dateKeys){
      if (parseKey(dateKey).getDay() !== wd) continue;
      const perf = (railPerfCache[dateKey] || {})[train.key];
      if (!perf || typeof perf.delayMinutes !== 'number') continue;
      total += Math.max(0, perf.delayMinutes);
      count++;
    }
    return count > 0 ? total / count : null;
  }
  const amByWeekday = amTrains.length ? weekdayAverages(amTrains) : [];
  const pmByWeekday = pmTrains.length ? weekdayAverages(pmTrains) : [];
  // Overall ranking combines both directions' trains into one set before
  // averaging per weekday — same weekdayAverages function, just fed a
  // wider train list, so a weekday's "overall" figure blends its morning
  // and evening performance rather than picking whichever direction ran
  // worse.
  const allTrains = amTrains.concat(pmTrains);
  const overallByWeekday = allTrains.length ? weekdayAverages(allTrains) : [];
  function weekdayRowsHtml(rows){
    if (rows.length === 0) return `<div class="sub" style="margin:0;">Not enough data yet.</div>`;
    const maxAvg = Math.max(...rows.map(r => r.avg), 0.1); // guard against div-by-zero when every average is 0
    return rows.map(r => {
      // Worst-first within the expanded detail — same ordering as the
      // parent weekday rows. No-data trains (null average) sort to the
      // bottom rather than breaking the comparator.
      const detailRows = r.trains
        .map(t => ({ t, a: trainAverageForWeekday(t, r.wd) }))
        .sort((x, y) => (y.a === null ? -Infinity : y.a) - (x.a === null ? -Infinity : x.a))
        .map(({ t, a }) => `<div class="perf-stats-weekday-detail-row"><span class="train-label">${escapeHtml(t.label)}</span><span>${a === null ? '—' : `${a.toFixed(1)}m`}</span></div>`)
        .join('');
      return `
        <div class="perf-stats-weekday-row">
          <div class="perf-stats-weekday-name">${r.day}</div>
          <div class="perf-stats-weekday-bar-track"><div class="perf-stats-weekday-bar-fill" style="width:${Math.max(4, (r.avg / maxAvg) * 100)}%;"></div></div>
          <div class="perf-stats-weekday-value">${r.avg.toFixed(1)}m</div>
          <div class="perf-stats-weekday-chevron">&#8250;</div>
        </div>
        <div class="perf-stats-weekday-detail" hidden>${detailRows}</div>`;
    }).join('');
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay-full';
  overlay.style.alignItems = 'stretch';
  overlay.innerHTML = `
    <div class="modal" style="display:flex; flex-direction:column; padding:0 0 calc(72px + env(safe-area-inset-bottom)) 0; border-radius:0; overflow:hidden;">
      <div style="padding:20px 18px 10px; flex-shrink:0;">
        <h3>Performance statistics</h3>
        <div class="sub" style="margin-bottom:0;">Based on the history currently backfilled below.</div>
      </div>
      <div style="flex:1; min-height:0; overflow:auto; -webkit-overflow-scrolling:touch;">
        <div class="perf-stats-section">
          <h4>Worst days — morning</h4>
          ${weekdayRowsHtml(amByWeekday)}
        </div>
        <div class="perf-stats-section">
          <h4>Worst days — evening</h4>
          ${weekdayRowsHtml(pmByWeekday)}
        </div>
        <div class="perf-stats-section">
          <h4>Worst days — overall</h4>
          ${weekdayRowsHtml(overallByWeekday)}
        </div>
        <div class="perf-stats-section">
          <h4>Most common delay reasons</h4>
          ${topDelayReasons.length ? topDelayReasons.map(reasonRowHtml).join('') : `<div class="sub" style="margin:0;">No delay reasons recorded yet.</div>`}
        </div>
        ${topCancelReasons.length ? `
        <div class="perf-stats-section">
          <h4>Most common cancellation reasons</h4>
          ${topCancelReasons.map(reasonRowHtml).join('')}
        </div>` : ''}
      </div>
      <div class="modal-close" id="perf-stats-close-btn" style="margin:10px 18px; background:var(--board-2); border:1px solid var(--line); border-radius:10px; padding:10px; flex-shrink:0;">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Each weekday row toggles the detail block immediately following it
  // (its next sibling in the DOM — see weekdayRowsHtml, which always
  // emits them as a pair) — no per-row click handler wiring needed
  // beyond a single delegated-by-class loop, and no ids to keep in sync
  // between the two.
  overlay.querySelectorAll('.perf-stats-weekday-row').forEach(row => {
    row.addEventListener('click', () => {
      const detail = row.nextElementSibling;
      if (!detail || !detail.classList.contains('perf-stats-weekday-detail')) return;
      const isHidden = detail.hasAttribute('hidden');
      if (isHidden) detail.removeAttribute('hidden'); else detail.setAttribute('hidden', '');
      row.classList.toggle('expanded', isHidden);
    });
  });

  overlay.querySelector('#perf-stats-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
}
