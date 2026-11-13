// roi.js — ROI dashboard and What-if.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// Stats registry — each entry is self-contained: an id, a section it
// belongs to, and a compute() function returning a display string. New
// features should add their own entry here rather than the stats screen
// itself needing to change shape as the app grows.
const STAT_DEFINITIONS = [
  {
    id: 'lifetime-spent', section: 'Tickets', label: 'Total spent (all time)',
    compute: () => `£${purchases.reduce((sum, p) => sum + p.cost, 0).toFixed(2)}`
  },
  {
    id: 'tickets-bought', section: 'Tickets', label: 'Tickets bought',
    compute: () => String(purchases.length)
  },
  {
    id: 'avg-ticket-cost', section: 'Tickets', label: 'Average ticket cost',
    compute: () => purchases.length ? `£${(purchases.reduce((s,p)=>s+p.cost,0)/purchases.length).toFixed(2)}` : '—'
  },
  {
    id: 'ticket-wastage', section: 'Tickets', label: 'Average unused journeys per ticket',
    compute: () => {
      if (purchases.length < 2) return 'Not enough history yet';
      const sorted = purchases.filter(p => (p.type || undefined) !== 'single').sort((a,b) => a.date < b.date ? -1 : 1);
      const todayKeyLocal = fmtKey(new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate()));
      let totalUnused = 0, periodsCounted = 0;
      for (let i = 0; i < sorted.length - 1; i++){
        const start = sorted[i].date;
        const nextStart = sorted[i+1].date;
        const gapDays = Math.round((parseKey(nextStart) - parseKey(start)) / 86400000);
        const windowLen = Math.min(28, gapDays);
        if (nextStart > todayKeyLocal) continue; // period not fully elapsed yet
        const used = Math.min(8, estimateTravelDaysInWindow(start, windowLen));
        totalUnused += Math.max(0, 8 - used);
        periodsCounted++;
      }
      if (periodsCounted === 0) return 'Not enough history yet';
      return (totalUnused / periodsCounted).toFixed(1);
    }
  },
  {
    id: 'wfh-days', section: 'Working patterns', label: 'WFH days logged (all time)',
    compute: () => String(Object.values(comments).filter(c => (c||'').trim().toUpperCase() === 'WFH').length)
  },
  {
    id: 'holiday-days', section: 'Working patterns', label: 'Holiday days logged (all time)',
    compute: () => String(Object.values(comments).filter(c => (c||'').trim().toUpperCase() === 'HOLIDAY').length)
  },
  {
    id: 'bank-holidays', section: 'Working patterns', label: 'Bank holidays auto-tagged',
    compute: () => String(Object.values(comments).filter(c => (c||'').trim().toUpperCase() === 'BANK HOLIDAY').length)
  },
  {
    id: 'delay-days', section: 'Delay repay', label: 'Possible claim days found',
    compute: () => {
      let count = 0;
      for (const date in railPerfCache){
        const dayPerf = railPerfCache[date];
        if (railTrains.some(t => dayPerf[t.key] && dayPerf[t.key].delayMinutes >= DELAY_REPAY_THRESHOLD_MINUTES)) count++;
      }
      return String(count);
    }
  },
  {
    id: 'worst-delay', section: 'Delay repay', label: 'Worst single delay recorded',
    compute: () => {
      let worst = 0;
      for (const date in railPerfCache){
        for (const trainKey in railPerfCache[date]){
          const dm = railPerfCache[date][trainKey].delayMinutes;
          if (dm > worst) worst = dm;
        }
      }
      return worst > 0 ? `${worst} minutes` : 'None recorded yet';
    }
  },
];

// ROI Dashboard — replaces the old generic Stats screen. Pulls together
// three real data sources that already exist (delayClaims, purchases,
// parkedDays) into an actual return-on-investment picture rather than a
// flat list of numbers. See roi-dashboard-spec.md for the full scoping
// discussion — in particular why "claimed" means confirmed-only (real
// money in hand, not an optimistic estimate) and why parking stays a
// separate section rather than folding into the ticket-spend ROI figure.
function openROIDashboardView(){
  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());

  // Section 1: Delay Repay breakdown — confirmed / pending / expired,
  // summed across every claim ever recorded.
  // 2026-09-30: pending is 'started' only — 'declined' (Not claiming) is
  // deliberately in none of these totals.
  let claimedConfirmed = 0, claimedPending = 0, claimedExpired = 0;
  for (const dateKey in delayClaims){
    for (const dir in delayClaims[dateKey]){
      const c = delayClaims[dateKey][dir];
      const amt = c.amount || 0;
      if (c.status === 'confirmed') claimedConfirmed += amt;
      else if (c.status === 'expired') claimedExpired += amt;
      else if (c.status === 'started') claimedPending += amt;
    }
  }

  // Every section shares the same rolling-12-months window: the first of
  // the month, 11 months back, through today — e.g. run in August 2026,
  // that's September 2025 through August 2026 inclusive. Not a fixed
  // calendar year; genuinely rolls forward with "today". Parking was
  // originally scoped as all-time, but that produced a figure wildly out
  // of proportion with everything else on the page (it accumulates one
  // "would-have-cost-to-drive" estimate per workday for the app's entire
  // tracked history, most of which was never actually a parking
  // decision) — moved onto the same window as the rest of the dashboard
  // for consistency and a sane number.
  const windowStart = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  const windowStartKey = fmtKey(windowStart);
  const todayKey = fmtKey(today);

  // Section: Parking — spent and saved, rolling 12 months.
  const parkingSpentTotal = Object.keys(parkedDays)
    .filter(k => k >= windowStartKey && k <= todayKey)
    .reduce((sum, k) => sum + (parkedDays[k] || 0), 0);
  const parkingSavedTotal = computeExpenseSavingsForPeriod(windowStart, today, today, parkedDays, parkingCost);

  const ticketSpendInWindow = purchases
    .filter(p => p.date >= windowStartKey && p.date <= todayKey)
    .reduce((sum, p) => sum + p.cost, 0);

  let claimedConfirmedInWindow = 0, claimedPendingInWindow = 0;
  // Also build the 12 monthly buckets (confirmed only — "claimed" keeps
  // the same honest, money-in-hand meaning here as in section 3) for
  // the trend section.
  const monthBuckets = [];
  for (let i = 0; i < 12; i++){
    const d = new Date(windowStart.getFullYear(), windowStart.getMonth() + i, 1);
    monthBuckets.push({ key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), total: 0 });
  }
  const bucketByKey = {};
  monthBuckets.forEach(b => bucketByKey[b.key] = b);

  for (const dateKey in delayClaims){
    if (dateKey < windowStartKey || dateKey > todayKey) continue;
    for (const dir in delayClaims[dateKey]){
      const c = delayClaims[dateKey][dir];
      const amt = c.amount || 0;
      if (c.status === 'confirmed'){
        claimedConfirmedInWindow += amt;
        const mKey = dateKey.slice(0, 7);
        if (bucketByKey[mKey]) bucketByKey[mKey].total += amt;
      } else if (c.status === 'started'){ // 2026-09-30: was "not expired", which would have counted declined as pending
        claimedPendingInWindow += amt;
      }
    }
  }
  const recoveredPct = ticketSpendInWindow > 0 ? ((claimedConfirmedInWindow / ticketSpendInWindow) * 100).toFixed(1) : '—';

  const money = n => `£${n.toFixed(2)}`;

  // Stage 8 (2026-11-13): a full-screen page of cards. Same figures.
  const row = (label, value, dim) => `<div class="ui-data-row"><span class="ui-data-row-main">${label}</span><span class="ui-data-row-value ${dim ? 'ui-dim' : 'ui-amber'}">${value}</span></div>`;
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `
    ${uiPageBar('ROI dashboard', { backId: 'roi-dashboard-close-btn', backLabel: 'Back' })}
    <div class="ui-page-body">
      <div class="sub">What the commute has actually cost and clawed back.</div>

      <div class="ui-subhead">Delay repay</div>
      <div class="ui-card ui-card-flush">
        ${row('Confirmed and paid', money(claimedConfirmed))}
        ${row('Pending', money(claimedPending))}
        ${row('Expired / lost', money(claimedExpired))}
      </div>

      <div class="ui-subhead">ROI vs ticket spend (rolling 12 months)</div>
      <div class="ui-card ui-card-flush">
        ${row('Claimed against spent', `${money(claimedConfirmedInWindow)} / ${money(ticketSpendInWindow)}`)}
        ${row('Recovered', recoveredPct === '—' ? '—' : recoveredPct + '%')}
        ${row('Still pending', money(claimedPendingInWindow), true)}
      </div>

      <div class="ui-subhead">Delay repay claimed by month</div>
      <div class="ui-card ui-card-flush">
        ${monthBuckets.map(b => row(b.label, money(b.total))).join('')}
      </div>

      <div class="ui-subhead">Parking (rolling 12 months)</div>
      <div class="ui-card ui-card-flush">
        ${row('Total spent', money(parkingSpentTotal))}
        ${row('Total saved', money(parkingSavedTotal))}
      </div>

      <div class="ui-subhead">What if — office days (next 12 months)</div>
      <div class="sub">Tap the days you're in the office. Holidays, bank holidays and planned WFH days you've already marked still apply.</div>
      <div class="ui-card" id="roi-whatif"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  renderROIWhatIf(today);
  document.getElementById('roi-dashboard-close-btn').addEventListener('click', () => overlay.remove());
}

// "What if" office-days section. Selections live in memory only for the
// session (reopening the dashboard keeps them; a reload resets to the
// defaults) — it's an exploration tool, so nothing is persisted, synced
// to the Worker/watch, or included in the Drive backup.
const ROI_WHATIF_DAY_LABELS = [[1,'Mon'],[2,'Tue'],[3,'Wed'],[4,'Thu'],[5,'Fri']];
let roiWhatIfNow = new Set([1,2,3,4]);
let roiWhatIfAlt = new Set([1,2,3]);

function renderROIWhatIf(today){
  const host = document.getElementById('roi-whatif');
  if (!host) return;
  const HORIZON = 365;
  const price = lastKnownPrice || 0;
  const money = n => `£${n.toFixed(2)}`;
  const nowR = projectOfficePattern(roiWhatIfNow, today, HORIZON);
  const altR = projectOfficePattern(roiWhatIfAlt, today, HORIZON);
  const nowCost = nowR.tickets * price;
  const altCost = altR.tickets * price;
  const diff = nowCost - altCost;
  const chips = (set, row) => `<div class="ui-chips">${ROI_WHATIF_DAY_LABELS.map(([n, lbl]) =>
    `<button type="button" class="ui-chip${set.has(n) ? ' is-selected' : ''}" data-whatif-row="${row}" data-whatif-day="${n}">${lbl}</button>`).join('')}</div>`;
  const summary = r => `${r.tickets} ticket${r.tickets === 1 ? '' : 's'} · ${r.travelDays} day${r.travelDays === 1 ? '' : 's'}`;
  const diffLabel = diff > 0.005 ? 'Saving' : (diff < -0.005 ? 'Extra cost' : 'Difference');
  host.innerHTML = `
    <div class="ui-field-label">Now</div>
    <div class="ui-gap-top-sm">${chips(roiWhatIfNow, 'now')}</div>
    <div class="ui-data-row"><span class="ui-data-row-main ui-dim">${summary(nowR)}</span><span class="ui-data-row-value ui-amber">${money(nowCost)}</span></div>
    <div class="ui-field-label ui-gap-top">What if</div>
    <div class="ui-gap-top-sm">${chips(roiWhatIfAlt, 'alt')}</div>
    <div class="ui-data-row"><span class="ui-data-row-main ui-dim">${summary(altR)}</span><span class="ui-data-row-value ui-amber">${money(altCost)}</span></div>
    <div class="ui-data-row roi-diff"><span class="ui-data-row-main">${diffLabel}</span><span class="ui-data-row-value ui-amber">${money(Math.abs(diff))} / yr · ${money(Math.abs(diff) / 12)} / mo</span></div>
    ${(nowR.unusedDays || altR.unusedDays) ? `<div class="ui-field-help">Days lost to expiry: ${nowR.unusedDays} now, ${altR.unusedDays} what-if.</div>` : ''}
    <div class="ui-field-help ui-gap-top-sm">At £${price.toFixed(2)} per Flexi 8. Ticket cost only — parking isn't counted, since it's only spent on days you actually drive.</div>
  `;
  host.querySelectorAll('[data-whatif-day]').forEach(el => {
    el.addEventListener('click', () => {
      const set = el.dataset.whatifRow === 'now' ? roiWhatIfNow : roiWhatIfAlt;
      const day = Number(el.dataset.whatifDay);
      if (set.has(day)) set.delete(day); else set.add(day);
      renderROIWhatIf(today);
    });
  });
}

// 2026-09-22 — "What if" office-days projection for the ROI dashboard.
// Projects the next [horizonDays] from [startDate] under a given weekly
// office pattern ([officeWeekdays]: a Set of JS getDay() numbers, 1=Mon
// .. 5=Fri) and counts how many Flexi tickets that would need. A day is
// a travel day when it's an office weekday in the pattern AND has no
// comment (holiday, bank holiday, ad-hoc WFH etc. all still apply), or
// when it carries a travel override — an explicitly planned trip counts
// regardless of pattern. Existing WFH comments on days outside the
// pattern are simply irrelevant. Ticket segmentation mirrors
// computeStates(): a ticket starts on the next travel day, and ends at
// USES_PER_PERIOD uses or PERIOD_LENGTH calendar days, whichever first.
// Deliberately starts from a fresh ticket for BOTH scenarios rather than
// the real current ticket's part-used state — this is a comparison, and
// that offset affects both sides equally.
function projectOfficePattern(officeWeekdays, startDate, horizonDays){
  const endKey = fmtKey(addDays(startDate, horizonDays - 1));
  const isTravelDay = d => {
    if (isWeekend(d)) return false;
    const key = fmtKey(d);
    if (travelOverrides[key]) return true;
    if (!officeWeekdays.has(d.getDay())) return false;
    return (comments[key] || '').trim() === '';
  };
  let tickets = 0, travelDays = 0, unusedDays = 0;
  let cursor = new Date(startDate);
  while (fmtKey(cursor) <= endKey){
    if (!isTravelDay(cursor)){ cursor = addDays(cursor, 1); continue; }
    // new ticket starts here
    tickets += 1;
    let used = 0, elapsed = 0;
    while (fmtKey(cursor) <= endKey && used < USES_PER_PERIOD && elapsed < PERIOD_LENGTH){
      if (isTravelDay(cursor)){ used += 1; travelDays += 1; }
      elapsed += 1;
      cursor = addDays(cursor, 1);
    }
    // Only a ticket that genuinely ran out of calendar days counts as
    // wasted — one cut short by the end of the projection window isn't.
    if (elapsed >= PERIOD_LENGTH && used < USES_PER_PERIOD) unusedDays += USES_PER_PERIOD - used;
  }
  return { tickets, travelDays, unusedDays };
}

function estimateTravelDaysInWindow(startDateStr, windowLength){
  const start = parseKey(startDateStr);
  let count = 0;
  for (let i = 0; i < windowLength; i++){
    const d = addDays(start, i);
    if (isWeekend(d)) continue;
    const key = fmtKey(d);
    const comment = (comments[key] || '').trim();
    if (comment === '' || travelOverrides[key]) count++;
  }
  return count;
}
