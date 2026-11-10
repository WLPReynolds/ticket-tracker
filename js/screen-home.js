// screen-home.js — render() — the Home tab.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.
const MAX_DAYS_AHEAD = 120;
const DAYS_AHEAD_STEP = 14;

// Small line-style SVG icons for the delay repay badge — kept inline rather
// than pulling in an icon font, since the app otherwise relies on emoji and
// these two need to look crisp at ~17px against a tinted background.
const DELAY_REPAY_ICON_RECEIPT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12a1 1 0 0 1 1 1v18l-2.5-1.5L14 21l-2.5-1.5L9 21l-2.5-1.5L4 21V3a1 1 0 0 1 1-1z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="12" y2="15"/></svg>';
const DELAY_REPAY_ICON_WARNING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="10" x2="12" y2="14.5"/><line x1="12" y1="17" x2="12" y2="17"/></svg>';

function render(){
  const app = document.getElementById('app');
  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const todayKey = fmtKey(today);

  // Delay repay claim expiry — Avanti's 28-day window from date of travel.
  // Stamped here (evaluated on every render) rather than on a timer, since
  // the app has no background process; the next time Wayne opens it after
  // the window lapses is when it flips to 'expired'. Fire-and-forget save —
  // render() isn't async and this is low-stakes enough not to need to be.
  // 2026-09-30: a 'started' claim with an AWC reference was submitted, so it
  // never expires; and an UNCLAIMED delay (no record at all) now expires too,
  // from DELAY_REPAY_UNCLAIMED_EXPIRY_FROM onwards.
  let anyClaimJustExpired = false;
  for (const dKey in delayClaims){
    for (const dir in delayClaims[dKey]){
      const c = delayClaims[dKey][dir];
      // 2026-10-01: submitted claims recorded before submittedAt existed.
      if (c && c.status === 'started' && c.claimRef && !c.submittedAt){
        c.submittedAt = DELAY_REPAY_SUBMITTED_BACKFILL > dKey ? DELAY_REPAY_SUBMITTED_BACKFILL : dKey;
        anyClaimJustExpired = true; // reuses the save below
      }
      if (c && c.status === 'started' && !c.claimRef){
        if (delayRepayDaysSince(dKey, today) >= DELAY_REPAY_WINDOW_DAYS){
          c.status = 'expired';
          if (typeof c.expiredAcknowledged !== 'boolean') c.expiredAcknowledged = false;
          anyClaimJustExpired = true;
        }
      }
    }
  }
  for (const dKey in railPerfCache){
    if (dKey < DELAY_REPAY_UNCLAIMED_EXPIRY_FROM) continue;
    if (delayRepayDaysSince(dKey, today) < DELAY_REPAY_WINDOW_DAYS) continue;
    if (!isEligibleRailDay(parseKey(dKey), todayKey)) continue;
    for (const o of delayRepayOpportunities(dKey)){
      if (o.claim) continue;
      if (!delayClaims[dKey]) delayClaims[dKey] = {};
      delayClaims[dKey][o.dir] = {
        status: 'expired',
        unclaimed: true,
        minutesLate: o.minutesLate,
        amount: computeDelayRepayAmount(o.minutesLate, dKey),
        trainKey: o.trainKey,
        expiredAcknowledged: false,
      };
      anyClaimJustExpired = true;
    }
  }
  if (anyClaimJustExpired) saveDelayClaims();

  // Delay repay badge — see claude/delay-repay-badge-rework-spec.md, which
  // supersedes the badge logic in delay-repay-expiry-badge-spec.md.
  // Priority: Expired → Chase Avanti → Claim available → Started →
  // Awaiting payment → Confirm train (2026-10-01 added the two payment
  // states). Each state is looked at by date: AM + PM on the same date count
  // as one entry.
  let delayRepayBadgeHtml = '';
  {
    const expiredDates = new Set();          // unacknowledged expired claims
    const chaseByDate = new Map();           // dateKey -> { daysOver, dueKey }
    const availableByDate = new Map();       // dateKey -> { daysLeft, amount }
    const startedByDate = new Map();         // dateKey -> daysLeft
    const awaitingByDate = new Map();        // dateKey -> { daysLeft, amount }
    const confirmTrainByDate = new Map();    // dateKey -> daysLeft

    for (const dKey in delayClaims){
      for (const dir in delayClaims[dKey]){
        const c = delayClaims[dKey][dir];
        if (!c) continue;
        if (c.status === 'expired' && !c.expiredAcknowledged){
          expiredDates.add(dKey);
        } else if (c.status === 'started' && !c.claimRef){
          startedByDate.set(dKey, DELAY_REPAY_WINDOW_DAYS - delayRepayDaysSince(dKey, today));
        } else if (c.status === 'started' && c.claimRef){
          // Submitted, not yet paid. If AM and PM were submitted on different
          // days, the date follows whichever is closest to (or furthest past)
          // its 20 days.
          const sub = c.submittedAt || DELAY_REPAY_SUBMITTED_BACKFILL;
          const daysLeft = DELAY_REPAY_RESPONSE_DAYS - delayRepayDaysSince(sub, today);
          const dueKey = fmtKey(addDays(parseKey(sub), DELAY_REPAY_RESPONSE_DAYS));
          if (daysLeft <= 0){
            const prev = chaseByDate.get(dKey);
            if (!prev || -daysLeft > prev.daysOver) chaseByDate.set(dKey, { daysOver: -daysLeft, dueKey });
          } else {
            const prev = awaitingByDate.get(dKey);
            const amount = (prev ? prev.amount : 0) + (c.amount || 0);
            awaitingByDate.set(dKey, { daysLeft: prev ? Math.min(prev.daysLeft, daysLeft) : daysLeft, amount });
          }
        }
      }
    }
    // A date that's overdue on one direction is shown as Chase, not Awaiting.
    for (const k of chaseByDate.keys()) awaitingByDate.delete(k);
    // Claim available / Confirm train: past eligible travel days still
    // inside the 28-day window (yesterday back to day 27).
    for (let back = 1; back < DELAY_REPAY_WINDOW_DAYS; back++){
      const d = addDays(today, -back);
      const dKey = fmtKey(d);
      if (!isEligibleRailDay(d, todayKey)) continue;
      const daysLeft = DELAY_REPAY_WINDOW_DAYS - back;
      const open = delayRepayOpportunities(dKey).filter(o => !o.claim);
      if (open.length){
        // Cancelled directions add nothing here — their band is unknown
        // until picked — but flag the date so the badge doesn't show a
        // misleadingly low (or £0.00) figure.
        const amount = open.reduce((sum, o) => sum + (o.cancelled ? 0 : cappedDelayRepayAmount(o.minutesLate, dKey, o.dir)), 0);
        const hasCancelled = open.some(o => o.cancelled);
        availableByDate.set(dKey, { daysLeft, amount, hasCancelled });
      }
      if (delayRepayUnconfirmedDirections(dKey).length) confirmTrainByDate.set(dKey, daysLeft);
    }

    // "N more claims waiting" — real claims only (Expired, Chase, Claim
    // available, Started, Awaiting payment), never Confirm train.
    const pendingDates = new Set([...expiredDates, ...chaseByDate.keys(), ...availableByDate.keys(), ...startedByDate.keys(), ...awaitingByDate.keys()]);
    const soonest = (m) => Array.from(m.entries()).sort((a, b) => {
      const da = typeof a[1] === 'number' ? a[1] : a[1].daysLeft;
      const db = typeof b[1] === 'number' ? b[1] : b[1].daysLeft;
      return da - db;
    })[0];
    const moreHtml = (shownDate) => {
      const more = pendingDates.size - (pendingDates.has(shownDate) ? 1 : 0);
      return more > 0 ? `<div class="delay-repay-badge-more">${more} more claim${more === 1 ? '' : 's'} waiting</div>` : '';
    };
    const daysLeftText = (n) => `${n} day${n === 1 ? '' : 's'} left`;

    if (expiredDates.size > 0){
      const shown = Array.from(expiredDates).sort()[0]; // oldest first
      delayRepayBadgeHtml = `
        <div class="delay-repay-badge-wrap">
          <div class="delay-repay-badge expired" id="delay-repay-badge" data-mode="expired" data-date-key="${shown}">
            <div class="delay-repay-badge-caption">Delay repay</div>
            <div class="delay-repay-badge-line">${DELAY_REPAY_ICON_WARNING} Expired</div>
          </div>
          ${moreHtml(shown)}
        </div>`;
    } else if (chaseByDate.size > 0){
      // Most overdue first.
      const [shown, info] = Array.from(chaseByDate.entries()).sort((a, b) => b[1].daysOver - a[1].daysOver)[0];
      delayRepayBadgeHtml = `
        <div class="delay-repay-badge-wrap">
          <div class="delay-repay-badge chase" id="delay-repay-badge" data-mode="chase" data-date-key="${shown}">
            <div class="delay-repay-badge-caption">Delay repay</div>
            <div class="delay-repay-badge-line">${DELAY_REPAY_ICON_WARNING} Chase Avanti</div>
            <div class="delay-repay-badge-sub">${info.daysOver === 0 ? 'Reply due today' : `Reply due ${dateLabelShort(parseKey(info.dueKey))}`}</div>
          </div>
          ${moreHtml(shown)}
        </div>`;
    } else if (availableByDate.size > 0){
      const [shown, info] = soonest(availableByDate);
      delayRepayBadgeHtml = `
        <div class="delay-repay-badge-wrap">
          <div class="delay-repay-badge available" id="delay-repay-badge" data-mode="available" data-date-key="${shown}">
            <div class="delay-repay-badge-caption">Claim available</div>
            <div class="delay-repay-badge-line">${DELAY_REPAY_ICON_RECEIPT} ${info.hasCancelled ? (info.amount > 0 ? `£${info.amount.toFixed(2)} + ?` : 'Cancelled') : `£${info.amount.toFixed(2)}`}</div>
            <div class="delay-repay-badge-sub">${daysLeftText(info.daysLeft)}</div>
          </div>
          ${moreHtml(shown)}
        </div>`;
    } else if (startedByDate.size > 0){
      const [shown, daysRemaining] = soonest(startedByDate);
      delayRepayBadgeHtml = `
        <div class="delay-repay-badge-wrap">
          <div class="delay-repay-badge normal" id="delay-repay-badge" data-mode="normal" data-date-key="${shown}">
            <div class="delay-repay-badge-caption">Delay repay</div>
            <div class="delay-repay-badge-line">${DELAY_REPAY_ICON_RECEIPT} ${daysRemaining} Day${daysRemaining === 1 ? '' : 's'}</div>
          </div>
          ${moreHtml(shown)}
        </div>`;
    } else if (awaitingByDate.size > 0){
      const [shown, info] = soonest(awaitingByDate);
      delayRepayBadgeHtml = `
        <div class="delay-repay-badge-wrap">
          <div class="delay-repay-badge awaiting" id="delay-repay-badge" data-mode="awaiting" data-date-key="${shown}">
            <div class="delay-repay-badge-caption">Awaiting payment</div>
            <div class="delay-repay-badge-line">${DELAY_REPAY_ICON_RECEIPT} £${info.amount.toFixed(2)}</div>
            <div class="delay-repay-badge-sub">${daysLeftText(info.daysLeft)}</div>
          </div>
          ${moreHtml(shown)}
        </div>`;
    } else if (confirmTrainByDate.size > 0){
      const [shown, daysLeft] = soonest(confirmTrainByDate);
      delayRepayBadgeHtml = `
        <div class="delay-repay-badge-wrap">
          <div class="delay-repay-badge confirm" id="delay-repay-badge" data-mode="confirm" data-date-key="${shown}">
            <div class="delay-repay-badge-caption">Delay repay</div>
            <div class="delay-repay-badge-line">Confirm train</div>
            <div class="delay-repay-badge-sub">${dateLabelShort(parseKey(shown))} · ${daysLeftText(daysLeft)}</div>
          </div>
        </div>`;
    }
  }
  const rangeEnd = addDays(today, state.daysAhead);
  const states = computeStates(rangeEnd);
  const todayState = states[todayKey];
  const todayComment = (comments[todayKey] || '').trim();
  const todayIsWeekend = isWeekend(today);

  // Purely for fun — gov.uk's bank holiday feed includes a genuine "bunting"
  // flag on celebratory dates (Christmas, Easter Monday, etc. get true;
  // Good Friday, for instance, gets false). No functional purpose, just a
  // small decorative flourish on days it applies.
  let isBuntingDay = false;
  let isChristmasBunting = false;
  try{
    const cachedHolidays = localStorage.getItem('bank-holidays-cache');
    if (cachedHolidays){
      const holidayEvents = JSON.parse(cachedHolidays);
      const todayEvent = holidayEvents.find(ev => ev.date === todayKey);
      isBuntingDay = !!(todayEvent && todayEvent.bunting);
      // Backlog #2 — a Christmas-specific variant of the generic bunting
      // flourish above: matched by title rather than a hardcoded 25/26 Dec,
      // so it still lines up correctly if gov.uk ever shifts the observed
      // date (e.g. Christmas Day falling on a weekend).
      isChristmasBunting = isBuntingDay && !!(todayEvent.title && /christmas|boxing/i.test(todayEvent.title));
    }
  }catch(e){ isBuntingDay = false; isChristmasBunting = false; }
  const beforePeriod = !todayState;

  // Hamburger menu items, built as a weighted list so ordering is
  // controlled by 'weight' rather than by where an item happens to sit in
  // this template — new items default to the main group, and anything
  // given a high weight (like Bulk import comments) always sorts to
  // the bottom, however many other items get added later.
  const menuItems = [
    { id: 'settings-link', label: 'Settings', weight: 0 },
    { id: 'depboard-link', label: 'Station board', weight: 0 },
    { id: 'confirm-train-link', label: 'Confirm train used', weight: 0 },
    { id: 'stats-link', label: 'ROI dashboard', weight: 0 },
    { id: 'perf-history-link', label: 'Performance history', weight: 0 },
    { id: 'delay-claims-link', label: 'Delay repay claims', weight: 0 },
  ];
  if (typeof Notification !== 'undefined' && Notification.permission === 'default'){
    menuItems.push({ id: 'enable-notifications-link', label: 'Enable notifications', weight: 0 });
  }
  menuItems.push({ id: 'backup-restore-link', label: 'Backup & restore', weight: 50 });
  menuItems.push({ id: 'help-link', label: 'Help', weight: 55 });
  menuItems.push({ id: 'backlog-link', label: 'Backlog', weight: 56 });
  menuItems.push({ id: 'import-history-link', label: 'Bulk import comments', weight: 100 });
  menuItems.push({ id: 'claims-import-link', label: 'Import delay repay claims', weight: 100 });
  menuItems.sort((a, b) => a.weight - b.weight);
  const menuItemsHtml = menuItems.map(item => `<div class="settings-link" id="${item.id}">${item.label}</div>`).join('');

  const nextHolidayKey = findNextHoliday(todayKey);
  let holidayHtml = '';
  if (nextHolidayKey){
    const hDate = parseKey(nextHolidayKey);
    // Fresh wall-clock time, not state.today — the hour-of-day check needs
    // to reflect the moment of this render, not when the app was opened.
    const nowClock = new Date();
    const countdown = getHolidayCountdownState(today, nowClock, hDate);

    let bigNumber, bigNumberStyle, labelText, dateLine;
    if (countdown.mode === 'off'){
      bigNumber = '🎉';
      bigNumberStyle = '';
      labelText = 'Enjoy your holiday!';
      dateLine = `Back to work ${dateLabel(countdown.backToWorkDay)}`;
    } else if (countdown.mode === 'hours'){
      bigNumber = `${countdown.hours}h ${countdown.minutes}m`;
      bigNumberStyle = 'font-size:26px;'; // "Xh Ym" is wider than a bare day-count
      labelText = "Until you're off for your holiday";
      dateLine = dateLabel(hDate);
    } else {
      bigNumber = countdown.dayCount;
      bigNumberStyle = '';
      labelText = `Working day${countdown.dayCount===1?'':'s'} until your next holiday`;
      dateLine = dateLabel(hDate);
    }

    holidayHtml = `
      <div class="holiday-card">
        <div class="holiday-count" style="${bigNumberStyle}">${bigNumber}</div>
        <div class="holiday-info">
          <div class="holiday-label">${labelText}</div>
          <div class="holiday-date">${dateLine}</div>
        </div>
      </div>`;
  }

  const currentYear = today.getFullYear();
  const yearToDatePurchases = purchases.filter(p => parseKey(p.date).getFullYear() === currentYear);
  const yearToDateTotal = yearToDatePurchases.reduce((sum, p) => sum + p.cost, 0);

  const realPeriodEnd = beforePeriod ? null : getRealPeriodEnd();
  // Same underlying check as isCurrentlyInTicketGap (shared helper, used
  // by the calendar sync logic too) — kept as a direct computation here
  // rather than calling that helper again, since realPeriodEnd is
  // already available and needed separately just below for isPastPhantom.
  const isPhantomToday = !beforePeriod && fmtKey(today) > fmtKey(realPeriodEnd.endDate);

  let statusHtml = '';
  if (beforePeriod){
    statusHtml = `<div class="status-banner skip">This ticket starts ${dateLabel(parseKey(periodStart))}</div>`;
  } else if (isPhantomToday){
    const singleToday = getSingleTicketForDate(todayKey);
    if (todayState && todayState.buyFlag){
      // Buy day falls inside the post-ticket gap (e.g. a Sunday before a
      // Monday travel day) — prompt to buy, rather than the weekend /
      // "no active ticket" wording, which hid the prompt entirely since
      // the "Next ticket due" line is suppressed when the buy day is today.
      statusHtml = `<div class="status-banner renew" id="renewal-banner-tap" style="cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">🚆 Buy your ticket tonight for tomorrow ›</div>`;
    } else if (todayIsWeekend){
      statusHtml = `<div class="status-banner skip">Weekend — no ticket needed</div>`;
    } else if (singleToday){
      statusHtml = `<div class="status-banner ok">Single ticket used today (£${singleToday.cost.toFixed(2)})</div>`;
    } else if (todayComment !== '' && !travelOverrides[todayKey]){
      statusHtml = `<div class="status-banner skip">Marked "${escapeHtml(todayComment)}" — not counted</div>`;
    } else {
      statusHtml = `<div class="status-banner renew" id="renewal-banner-tap" style="cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">No active season ticket — log a single ticket, or buy your next one ›</div>`;
    }
  } else if (todayState.buyFlag){
    const lostMsg = todayState.lostDays ? ` (${todayState.unusedRemaining} unused day${todayState.unusedRemaining===1?'':'s'} lost)` : '';
    statusHtml = `<div class="status-banner renew" id="renewal-banner-tap" style="cursor:pointer; -webkit-user-select:none; user-select:none; touch-action:manipulation;">🚆 Buy your ticket tonight for tomorrow${lostMsg} ›</div>`;
  } else if (todayState.inGap){
    statusHtml = `<div class="status-banner skip">No ticket needed yet — nothing due until you next travel</div>`;
  } else if (todayIsWeekend){
    statusHtml = `<div class="status-banner skip">Weekend — no ticket needed &middot; day ${todayState.daysElapsed} of 28</div>`;
  } else if (todayComment !== '' && !travelOverrides[todayKey]){
    statusHtml = `<div class="status-banner skip">Marked "${escapeHtml(todayComment)}" — not counted &middot; day ${todayState.daysElapsed} of 28</div>`;
  } else {
    const overrideNote = (todayComment !== '' && travelOverrides[todayKey]) ? ` &middot; marked "${escapeHtml(todayComment)}" but counted` : '';
    statusHtml = `<div class="status-banner ok">${todayState.unusedRemaining} use${todayState.unusedRemaining===1?'':'s'} left &middot; day ${todayState.daysElapsed} of 28${overrideNote}</div>`;
  }

  const todayCountDisplay = (beforePeriod || todayState.inGap) ? '–' : String(todayState.usedCount);
  const punches = [];
  for (let i=1;i<=8;i++){
    punches.push(!beforePeriod && !todayState.inGap && i <= todayState.usedCount);
  }
  const dayProgressPct = (beforePeriod || todayState.inGap) ? 0 : Math.round((todayState.daysElapsed / PERIOD_LENGTH) * 100);

  // Next buy-ticket date, found independently of how far the visible day
  // list currently scrolls — so it's always accurate even before you've
  // tapped "Show more days". Not shown if today itself is the buy day,
  // since the status banner above already covers that case.
  let nextBuyHtml = '';
  let calendarPromptHtml = '';
  if (!beforePeriod){
    const nextBuyKey = findNextBuyDateKey(today, todayKey);
    if (nextBuyKey && nextBuyKey !== todayKey){
      nextBuyHtml = `<div class="next-buy-line">Next ticket due ${dateLabelShort(parseKey(nextBuyKey))}</div>`;
    }
    // If the predicted buy date has changed since we last checked, wait
    // 10 seconds before actually notifying/syncing — if another change
    // comes in before that (e.g. tagging several holiday days in a row),
    // the timer resets rather than firing once per edit.
    if (nextBuyKey && nextBuyKey !== lastNotifiedBuyKey){
      if (nextBuyKey !== scheduledBuyKey){
        scheduledBuyKey = nextBuyKey;
        if (buyDateChangeTimer) clearTimeout(buyDateChangeTimer);
        buyDateChangeTimer = setTimeout(fireBuyDateChangeActions, 10000);
      }
    } else if (buyDateChangeTimer){
      // the change was undone (e.g. tag removed again) before the timer
      // fired — cancel it rather than notifying about a non-change
      clearTimeout(buyDateChangeTimer);
      buyDateChangeTimer = null;
      scheduledBuyKey = null;
    }
    if (gcalEnabled && gcalPendingSync && nextBuyKey){
      const promptLabel = gcalLastSyncFailed ? 'Couldn\'t update Google Calendar — tap to retry' : 'Tap to update Google Calendar';
      calendarPromptHtml = `<div class="next-buy-line" id="calendar-sync-prompt" style="cursor:pointer; text-decoration:underline;">${promptLabel}</div>`;
    }
  }

  const days = getRange(today, railDaysBack, state.daysAhead);

  // Monthly cost estimate — how many tickets and parking days are likely
  // needed within the selected pay period. Offset 0 is the current period
  // (most recent payday up to, but not including, the next one); the
  // card's own nav arrows let you preview future periods without
  // affecting the automatic dismiss/reset behaviour of the current one.
  // 2026-10-06: the calculation (and its payday lock) now lives in
  // estimateForPeriod(), shared with the Personal Finance publisher so the
  // card and the transport-estimates.json file can never disagree.
  const estMonthKey = fmtKey(getPayPeriodByOffset(today, 0).start); // dismiss/reset key always tracks the CURRENT period, regardless of what's being previewed
  const est = estimateForPeriod(today, estimateOffset);
  const estWindowStart = est.start;
  const estWindowEnd = est.end;
  const estTicketCount = est.ticketCount;
  const estParkingDays = est.parkingDays;
  const estTicketCost = est.ticketCost;
  const estParkingCost = est.parkingCost;
  const estTotal = est.total;
  const payWindowLabel = `${dateLabelShort(estWindowStart)} – ${dateLabelShort(estWindowEnd)}`;
  const monthEstimateDismissed = !!dismissedMonths[estMonthKey];
  const showEstimateCard = !monthEstimateDismissed;

  // Always the REAL current period, independent of whatever the
  // estimate card above might be previewing via its own nav arrows —
  // this is about what's actually happened so far, not a projection.
  const realCurrentPeriod = getPayPeriodByOffset(today, 0);
  const currentPeriodBudgetDays = getOrLockParkingBudgetDays(realCurrentPeriod.start, realCurrentPeriod.end, today);
  const parkingSavedThisPeriod = computeParkingSavingsForPeriod(realCurrentPeriod.start, realCurrentPeriod.end, today, currentPeriodBudgetDays, parkedDays, parkingCost);

  // Lock in the immediately preceding period's figure the first time
  // it's seen after ticking over, same reasoning as the payday
  // snapshot — once a period is done, its "saved" total shouldn't keep
  // drifting if a comment or parked-day gets edited afterwards. This
  // only catches the period right before the current one on each
  // render; older, skipped-over periods still get locked in (with their
  // own best-effort budget-day set, reconstructed from whatever comment
  // state exists now) the first time they're actually viewed below.
  const prevParkingPeriod = getPayPeriodByOffset(today, -1);
  const prevParkingPeriodStartKey = fmtKey(prevParkingPeriod.start);
  if (parkingSavingsSnapshots[prevParkingPeriodStartKey] === undefined){
    const prevBudgetDays = getOrLockParkingBudgetDays(prevParkingPeriod.start, prevParkingPeriod.end, today);
    parkingSavingsSnapshots[prevParkingPeriodStartKey] = computeParkingSavingsForPeriod(prevParkingPeriod.start, prevParkingPeriod.end, today, prevBudgetDays, parkedDays, parkingCost);
    saveParkingSavingsSnapshots();
  }

  // The period actually being displayed on the card, per its own nav
  // arrows — offset 0 is always the real current period (live, never
  // snapshotted, since it's still evolving); anything further back
  // reads from the locked-in snapshot, computing and locking its
  // budget-day set and resulting total on the spot if this is the first
  // time it's being viewed.
  const psPeriod = parkingSavingsOffset === 0 ? realCurrentPeriod : getPayPeriodByOffset(today, parkingSavingsOffset);
  const psPeriodStartKey = fmtKey(psPeriod.start);
  let parkingSavingsCardValue;
  if (parkingSavingsOffset === 0){
    parkingSavingsCardValue = parkingSavedThisPeriod;
  } else if (parkingSavingsSnapshots[psPeriodStartKey] !== undefined){
    parkingSavingsCardValue = parkingSavingsSnapshots[psPeriodStartKey];
  } else {
    const psBudgetDays = getOrLockParkingBudgetDays(psPeriod.start, psPeriod.end, today);
    parkingSavingsCardValue = computeParkingSavingsForPeriod(psPeriod.start, psPeriod.end, today, psBudgetDays, parkedDays, parkingCost);
    parkingSavingsSnapshots[psPeriodStartKey] = parkingSavingsCardValue;
    saveParkingSavingsSnapshots();
  }
  const parkingSavingsWindowLabel = `${dateLabelShort(psPeriod.start)} – ${dateLabelShort(psPeriod.end)}`;

  const rows = days.map(d => {
    const key = fmtKey(d);
    let s = states[key];
    const weekend = isWeekend(d);
    const comment = (comments[key] || '').trim();
    const isToday = key === todayKey;
    let isHistorical = false;
    if (!s){
      // Not this ticket's own range — but a real, earlier ticket may
      // still have genuinely covered this day. Recovered here rather
      // than shown as a bare placeholder, so the day keeps its actual
      // detail (badge, confirmed trains, delay claim status) exactly as
      // it looked before a new ticket got bought, not just "Before this
      // ticket" with nothing else.
      s = findHistoricalStateForDate(key);
      isHistorical = !!s;
    }
    if (!s){
      return `
        <div class="day-row" data-key="${key}">
          <div class="count-badge">–</div>
          <div class="info">
            <div class="dname">${dayNameShort(d)} ${dateLabelShort(d)}</div>
            <div class="comment-tag" style="color:var(--ink-dim)">Before this ticket</div>
          </div>
          <div class="arrow">›</div>
        </div>`;
    }
    const isPastPhantom = !weekend && !beforePeriod && key <= todayKey && key > fmtKey(realPeriodEnd.endDate);
    const singleForDay = isPastPhantom ? getSingleTicketForDate(key) : null;

    let badgeClass, badgeText;
    if (isPastPhantom){
      badgeClass = singleForDay ? 'eight' : 'weekend';
      badgeText = singleForDay ? 'S' : '–';
    } else {
      badgeClass = s.buyFlag ? 'eight' : ((weekend || s.inGap) ? 'weekend' : '');
      badgeText = (weekend || s.inGap) ? '–' : s.usedCount;
    }

    let tag = '';
    const overridden = comment !== '' && !!travelOverrides[key];
    if (isPastPhantom){
      if (comment && singleForDay) tag = `${escapeHtml(comment)} &middot; Single ticket (£${singleForDay.cost.toFixed(2)})`;
      else if (singleForDay) tag = `Single ticket (£${singleForDay.cost.toFixed(2)})`;
      else if (comment) tag = escapeHtml(comment) + (overridden ? ' &middot; counted' : '');
      else tag = 'No active ticket';
    }
    else if (comment && s.buyFlag) tag = `${escapeHtml(comment)}${overridden ? ' &middot; counted' : ''} · Buy ticket${s.lostDays ? ` · ${s.unusedRemaining} lost` : ''}`;
    else if (comment) tag = escapeHtml(comment) + (overridden ? ' &middot; counted' : '');
    else if (s.buyFlag) tag = s.lostDays ? `Buy ticket · ${s.unusedRemaining} lost` : 'Buy ticket';
    else if (weekend) tag = 'Weekend';

    let railBlobHtml = '';
    if (isEligibleRailDay(d, todayKey)){
      const status = getDelayStatus(key);
      if (status === 'confirmed'){
        railBlobHtml = `<span class="rail-blob rail-blob-confirmed" data-rail-key="${key}" title="Confirmed delay repay claim"></span>`;
      } else if (status === 'maybe'){
        railBlobHtml = `<span class="rail-blob" data-rail-key="${key}" title="Possible delay repay claim"></span>`;
      } else if (status === 'declined'){
        railBlobHtml = `<span class="rail-blob rail-blob-declined" data-rail-key="${key}" title="Declined delay repay"></span>`;
      }
    }

    return `
      <div class="day-row ${isToday?'is-today':''} ${weekend?'no-click':''}" data-key="${key}" data-weekend="${weekend ? '1' : '0'}">
        <div class="count-badge ${badgeClass}">${badgeText}</div>
        <div class="info">
          <div class="dname">${dayNameShort(d)} ${dateLabelShort(d)} ${isToday?'<span class="sub">Today</span>':''}${railBlobHtml}</div>
          ${tag ? `<div class="comment-tag">${tag}</div>` : ''}
        </div>
        ${weekend ? '' : '<div class="arrow">›</div>'}
      </div>
    `;
  }).join('');

  app.className = '';
  app.innerHTML = `
    <header class="top">
      ${delayRepayBadgeHtml}
      ${isChristmasBunting ? `
      <div class="christmas-header" title="Merry Christmas, per gov.uk's bunting flag">
        <svg class="christmas-lights" viewBox="0 0 268 22" preserveAspectRatio="none">
          <path d="M4 4 Q 34 20 64 4 T 124 4 T 184 4 T 244 4" stroke="#3a3d2a" stroke-width="1.5" fill="none"/>
          <circle cx="4" cy="4" r="4" fill="#e0524a"/>
          <circle cx="34" cy="15" r="4" fill="#3f9e5c"/>
          <circle cx="64" cy="4" r="4" fill="#d4af37"/>
          <circle cx="94" cy="15" r="4" fill="#3f7fd8"/>
          <circle cx="124" cy="4" r="4" fill="#e0524a"/>
          <circle cx="154" cy="15" r="4" fill="#3f9e5c"/>
          <circle cx="184" cy="4" r="4" fill="#d4af37"/>
          <circle cx="214" cy="15" r="4" fill="#3f7fd8"/>
          <circle cx="244" cy="4" r="4" fill="#e0524a"/>
        </svg>
        <div class="christmas-icons">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M5 20c0-5 3-9 7-9s7 4 7 9" stroke="#e0524a" stroke-width="1.8" stroke-linecap="round"/><circle cx="19" cy="10" r="2.4" fill="#f4f2ea"/><path d="M4 20h16" stroke="#f4f2ea" stroke-width="1.8" stroke-linecap="round"/></svg>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M6 20l1-7c0-3 2-6 5-6s5 3 5 6l1 7" stroke="#a9835c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 7l-2-4M15 7l2-4" stroke="#a9835c" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="1.4" fill="#e0524a"/></svg>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><rect x="4" y="9" width="16" height="11" rx="1.5" stroke="#3f9e5c" stroke-width="1.8"/><path d="M4 13h16M12 9v11" stroke="#d4af37" stroke-width="1.8"/><path d="M8 9c0-3 2-4 4-4s4 1 4 4" stroke="#3f9e5c" stroke-width="1.8" stroke-linecap="round"/></svg>
        </div>
      </div>` : isBuntingDay ? `
      <div class="bunting-row" title="Official bunting day, per gov.uk">
        <span class="bunting-flag" style="background:var(--amber);"></span>
        <span class="bunting-flag" style="background:#7fc9e8;"></span>
        <span class="bunting-flag" style="background:var(--good);"></span>
        <span class="bunting-flag" style="background:var(--amber);"></span>
        <span class="bunting-flag" style="background:#7fc9e8;"></span>
        <span class="bunting-flag" style="background:var(--good);"></span>
        <span class="bunting-flag" style="background:var(--amber);"></span>
      </div>` : ''}
      <div class="eyebrow">Season Ticket Tracker</div>
      <h1>8-Day Ticket</h1>
      <div class="today-date">${dateLabel(today)}</div>
      <div style="font-size:10px; color:var(--ink-dim); opacity:0.6; margin-top:2px;">${APP_VERSION}</div>
      ${menuOpen ? `
      <div class="menu-dropdown" id="menu-dropdown">
        ${menuItemsHtml}
      </div>` : ''}
    </header>

    <div class="board-card">
      ${!isPhantomToday ? `
      <div class="ticket-summary-row">
        <div class="punch-row">
          ${punches.map((p,i)=>`<div class="punch ${p?'done':''}">${i+1}</div>`).join('')}
        </div>
        <div class="ticket-count-label">${todayCountDisplay}<span class="of8">/8</span></div>
      </div>
      <div class="day-progress-track"><div class="day-progress-fill" style="width:${dayProgressPct}%"></div></div>
      ` : ''}
      ${statusHtml}
      ${nextBuyHtml}
      ${calendarPromptHtml}
      ${likelyTrainSuggestion ? `
      <div class="holiday-card" style="margin-top:12px;">
        <div class="holiday-info" style="width:100%;">
          <div class="holiday-label">Is this your train?</div>
          <div style="font-size:15px; margin:4px 0 10px;">Looks like you might be on the delayed <strong style="color:var(--amber);">${likelyTrainSuggestion.label}</strong> instead of your usual one.</div>
          <div style="display:flex; gap:10px;">
            <button class="save-btn" id="likely-train-yes-btn" style="flex:1; margin:0;">Yes, that's me</button>
            <button class="save-btn" id="likely-train-no-btn" style="flex:1; margin:0; background:var(--tile); color:var(--ink-dim);">No</button>
          </div>
        </div>
      </div>` : ''}
    </div>

    ${!showEstimateCard ? '' : `
    <div class="holiday-card" id="month-estimate-card">
      <div class="holiday-info" style="width:100%;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div class="holiday-label">Set aside on payday</div>
          <span id="month-estimate-dismiss" style="cursor:pointer; color:var(--ink-dim); font-size:16px; line-height:1; padding:0 4px;">&times;</span>
        </div>
        <div style="display:flex; align-items:center; gap:10px; margin-top:6px;">
          <span class="cal-nav-btn" id="estimate-prev" style="width:24px; height:24px; font-size:13px;">&#8249;</span>
          <div class="holiday-label" style="margin:0; font-weight:600; color:var(--ink);">${payWindowLabel}</div>
          <span class="cal-nav-btn" id="estimate-next" style="width:24px; height:24px; font-size:13px;">&#8250;</span>
        </div>
        <div class="holiday-date" style="font-size:22px; font-weight:600; color:var(--amber); margin-top:8px;">£${estTotal.toFixed(2)}</div>
        <div class="holiday-label" style="margin-top:2px;">${estTicketCount} ticket${estTicketCount===1?'':'s'} (£${estTicketCost.toFixed(2)}) + ${estParkingDays} parking day${estParkingDays===1?'':'s'} (£${estParkingCost.toFixed(2)})</div>
      </div>
    </div>`}

    ${(!beforePeriod && !dismissedParkingSavingsPeriods[fmtKey(realCurrentPeriod.start)]) ? `
    <div class="holiday-card" id="parking-savings-card">
      <div class="holiday-info" style="width:100%;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div class="holiday-label">Parking savings${parkingSavingsOffset === 0 ? ' this period' : ''}</div>
          <span id="parking-savings-dismiss" style="cursor:pointer; color:var(--ink-dim); font-size:16px; line-height:1; padding:0 4px;">&times;</span>
        </div>
        <div style="display:flex; align-items:center; gap:10px; margin-top:6px;">
          <span class="cal-nav-btn" id="parking-savings-prev" style="width:24px; height:24px; font-size:13px;">&#8249;</span>
          <div class="holiday-label" style="margin:0; font-weight:600; color:var(--ink);">${parkingSavingsWindowLabel}</div>
          <span class="cal-nav-btn ${parkingSavingsOffset === 0 ? 'disabled' : ''}" id="parking-savings-next" style="width:24px; height:24px; font-size:13px; ${parkingSavingsOffset === 0 ? 'opacity:0.35; pointer-events:none;' : ''}">&#8250;</span>
        </div>
        <div class="holiday-date" style="font-size:22px; font-weight:600; color:${parkingSavingsCardValue >= 0 ? 'var(--good)' : '#ff8b7e'}; margin-top:8px;">${parkingSavingsCardValue >= 0 ? '£' + parkingSavingsCardValue.toFixed(2) + ' saved' : '£' + Math.abs(parkingSavingsCardValue).toFixed(2) + ' over budget'}</div>
      </div>
    </div>` : ''}


    ${!ticketsSpentCardDismissed ? `
    <div class="holiday-card" id="spending-card" style="cursor:pointer;">
      <div class="holiday-info" style="width:100%;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div class="holiday-label">Spent on tickets this year</div>
          <span id="spending-card-dismiss" style="cursor:pointer; color:var(--ink-dim); font-size:16px; line-height:1; padding:0 4px;">&times;</span>
        </div>
        <div class="holiday-date" style="font-size:22px; font-weight:600; color:var(--amber);">£${yearToDateTotal.toFixed(2)}</div>
        <div class="holiday-label" style="margin-top:2px;">${yearToDatePurchases.length} ticket${yearToDatePurchases.length===1?'':'s'} logged this year · tap to manage</div>
      </div>
    </div>` : ''}

    ${holidayHtml}

    ${todayIsWeekend ? '' : `
    <div class="section-label">Today's comment</div>
    <div class="comment-card" id="today-comment-card">
      <div class="chip-row" id="chip-row"></div>
      <input type="text" id="custom-comment" placeholder="Or type your own" value="${escapeHtml(todayComment && !PRESET_TAGS.includes(todayComment.toUpperCase()) ? todayComment : '')}" />
      <label style="display:flex; align-items:center; gap:8px; margin:10px 0 4px; font-size:14px; color:var(--ink-dim); cursor:pointer;">
        <input type="checkbox" id="today-override-checkbox" ${travelOverrides[todayKey] ? 'checked' : ''} style="width:16px; height:16px;" />
        I still used the ticket today
      </label>
      <button class="save-btn" id="save-today-btn">Save</button>
    </div>`}

    <div class="section-label">Upcoming &amp; recent days</div>
    ${railDaysBack < RAIL_MAX_DAYS_BACK ? `<div class="day-nav-btn" id="show-earlier-link"><span class="arrow-icon">&#8593;</span> Show earlier days</div>` : ''}
    <div class="day-list">${rows}</div>
    ${state.daysAhead < MAX_DAYS_AHEAD ? `<div class="day-nav-btn" id="show-more-link">Show more days <span class="arrow-icon">&#8595;</span></div>` : ''}

    <nav class="bottom-nav">
      <div class="bottom-nav-item ${state.activeTab==='today'?'active':''}" id="bottom-nav-today">${NAV_ICONS.today}<span class="bn-label">Home</span></div>
      <div class="bottom-nav-item ${state.activeTab==='live'?'active':''}" id="bottom-nav-live">${NAV_ICONS.live}<span class="bn-label">Live</span></div>
      <div class="bottom-nav-item ${state.activeTab==='buy'?'active':''}" id="bottom-nav-buy">${NAV_ICONS.buy}<span class="bn-label">Buy</span></div>
      <div class="bottom-nav-item ${state.activeTab==='calendar'?'active':''}" id="bottom-nav-calendar">${NAV_ICONS.calendar}<span class="bn-label">Calendar</span></div>
      <div class="bottom-nav-item ${menuOpen?'active':''}" id="bottom-nav-more">${NAV_ICONS.more}<span class="bn-label">More</span></div>
    </nav>
  `;

  // wire up chip row for today (only exists on non-weekend days)
  const chipRow = document.getElementById('chip-row');
  if (chipRow){
    let selectedPreset = PRESET_TAGS.includes(todayComment.toUpperCase()) ? todayComment.toUpperCase() : null;
    chipRow.innerHTML = PRESET_TAGS.map(tag => `<div class="chip ${selectedPreset===tag?'active':''}" data-tag="${tag}">${tag}</div>`).join('') +
      `<div class="chip ${!selectedPreset && !todayComment ? '' : (!selectedPreset && todayComment ? '' : '')}" data-tag="__clear">Clear</div>`;

    chipRow.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const tag = chip.dataset.tag;
        const cb = document.getElementById('today-override-checkbox');
        if (tag === '__clear'){
          comments[todayKey] = '';
          delete travelOverrides[todayKey];
        } else {
          comments[todayKey] = tag;
          document.getElementById('custom-comment').value = '';
          if (cb && cb.checked) travelOverrides[todayKey] = true; else delete travelOverrides[todayKey];
        }
        await saveComments();
        await saveTravelOverrides();
        render();
      });
    });

    document.getElementById('save-today-btn').addEventListener('click', async () => {
      const val = document.getElementById('custom-comment').value.trim();
      const cb = document.getElementById('today-override-checkbox');
      if (val !== ''){
        comments[todayKey] = val;
        if (cb && cb.checked) travelOverrides[todayKey] = true; else delete travelOverrides[todayKey];
        await saveComments();
        await saveTravelOverrides();
        render();
      }
    });

    const todayOverrideCb = document.getElementById('today-override-checkbox');
    if (todayOverrideCb){
      todayOverrideCb.addEventListener('change', async () => {
        if (todayOverrideCb.checked) travelOverrides[todayKey] = true; else delete travelOverrides[todayKey];
        await saveTravelOverrides();
        render();
        if (todayOverrideCb.checked) railSyncMissingDates();
      });
    }
  }

  document.querySelectorAll('.day-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('rail-blob')){
        e.stopPropagation();
        openRailDetail(e.target.dataset.railKey);
      } else if (row.dataset.weekend === '1'){
        // weekends have nothing to tag — no editor to open
      } else {
        openDayEditor(row.dataset.key);
      }
    });
  });

  const delayRepayBadgeEl = document.getElementById('delay-repay-badge');
  if (delayRepayBadgeEl){
    delayRepayBadgeEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mode = delayRepayBadgeEl.dataset.mode;
      const dateKey = delayRepayBadgeEl.dataset.dateKey;
      if (!mode) return; // preview badges have no mode/dateKey — nothing to do
      if (mode === 'expired'){
        for (const dir in (delayClaims[dateKey] || {})){
          const c = delayClaims[dateKey][dir];
          if (c && c.status === 'expired') c.expiredAcknowledged = true;
        }
        await saveDelayClaims();
        render();
      } else if (mode === 'available'){
        openRailDetail(dateKey); // the claim pill + Not claiming buttons live here
      } else if (mode === 'confirm'){
        openConfirmTrain(dateKey); // once saved, a real claim becomes Claim available
      } else {
        openDelayClaimsManager(); // Started / Awaiting payment / Chase — the reference and the Confirmed (paid) tick live here
      }
    });
  }

  document.getElementById('bottom-nav-more').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllModals();
    menuOpen = !menuOpen;
    render();
  });
  if (menuOpen){
    // close the dropdown if the person taps anywhere outside it
    setTimeout(() => {
      document.addEventListener('click', function closeMenu(e){
        const dropdown = document.getElementById('menu-dropdown');
        const btn = document.getElementById('bottom-nav-more');
        if (!dropdown || (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target))){
          document.removeEventListener('click', closeMenu);
          if (menuOpen){ menuOpen = false; render(); }
        }
      });
    }, 0);
  }

  document.getElementById('bottom-nav-today').addEventListener('click', () => {
    closeAllModals();
    menuOpen = false;
    state.activeTab = 'today';
    render();
    const todayRow = document.querySelector('.day-row.is-today');
    if (todayRow) todayRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  const renewalBannerTap = document.getElementById('renewal-banner-tap');
  if (renewalBannerTap) renewalBannerTap.addEventListener('click', () => { openBuyScreen('season'); });

  document.getElementById('bottom-nav-live').addEventListener('click', () => {
    closeAllModals();
    menuOpen = false;
    state.activeTab = 'live';
    render();
    openLiveScreen();
  });
  document.getElementById('bottom-nav-buy').addEventListener('click', () => {
    closeAllModals();
    menuOpen = false;
    state.activeTab = 'buy';
    render();
    openBuyScreen();
  });
  document.getElementById('bottom-nav-calendar').addEventListener('click', () => {
    closeAllModals();
    menuOpen = false;
    state.activeTab = 'calendar';
    render();
    openCalendarView();
  });

  const importHistoryLink = document.getElementById('import-history-link');
  if (importHistoryLink) importHistoryLink.addEventListener('click', () => { menuOpen = false; render(); openImportHistory(); });

  const claimsImportLink = document.getElementById('claims-import-link');
  if (claimsImportLink) claimsImportLink.addEventListener('click', () => { menuOpen = false; render(); openDelayClaimsImport(); });

  const helpLink = document.getElementById('help-link');
  if (helpLink) helpLink.addEventListener('click', () => { menuOpen = false; render(); openHelpGuide(); });

  const backlogLink = document.getElementById('backlog-link');
  if (backlogLink) backlogLink.addEventListener('click', () => { menuOpen = false; render(); openBacklogView(); });

  const settingsLink = document.getElementById('settings-link');
  if (settingsLink) settingsLink.addEventListener('click', () => { menuOpen = false; render(); openSettingsMenu(); });

  const debugModeLink = document.getElementById('debug-mode-link');
  if (debugModeLink) debugModeLink.addEventListener('click', async () => {
    debugModeEnabled = !debugModeEnabled;
    await saveDebugMode();
    menuOpen = false;
    render();
  });
  const weatherToggleLink = document.getElementById('weather-toggle-link');
  if (weatherToggleLink) weatherToggleLink.addEventListener('click', async () => {
    weatherEnabled = !weatherEnabled;
    await saveWeatherEnabled();
    menuOpen = false;
    render();
  });
  const pollingSettingsLink = document.getElementById('polling-settings-link');
  if (pollingSettingsLink) pollingSettingsLink.addEventListener('click', () => { menuOpen = false; render(); openPollingSettingsEditor(); });

  const depboardLink = document.getElementById('depboard-link');
  if (depboardLink) depboardLink.addEventListener('click', () => { menuOpen = false; render(); openDepartureBoardView(); });

  const preferredGoogleLink = document.getElementById('preferred-google-link');
  if (preferredGoogleLink) preferredGoogleLink.addEventListener('click', () => { menuOpen = false; render(); openPreferredGoogleEditor(); });

  const backupRestoreLink = document.getElementById('backup-restore-link');
  if (backupRestoreLink) backupRestoreLink.addEventListener('click', () => { menuOpen = false; render(); openBackupRestore(); });

  const railConfigLink = document.getElementById('rail-config-link');
  if (railConfigLink) railConfigLink.addEventListener('click', () => { menuOpen = false; render(); openRailConfig(); });

  const confirmTrainLink = document.getElementById('confirm-train-link');
  if (confirmTrainLink) confirmTrainLink.addEventListener('click', () => { menuOpen = false; render(); openConfirmTrain(); });

  const statsLink = document.getElementById('stats-link');
  if (statsLink) statsLink.addEventListener('click', () => { menuOpen = false; render(); openROIDashboardView(); });

  const perfHistoryLink = document.getElementById('perf-history-link');
  if (perfHistoryLink) perfHistoryLink.addEventListener('click', () => { menuOpen = false; render(); openPerformanceHistoryView(); });

  const delayClaimsLink = document.getElementById('delay-claims-link');
  if (delayClaimsLink) delayClaimsLink.addEventListener('click', () => { menuOpen = false; render(); openDelayClaimsManager(); });

  const passPhotoLink = document.getElementById('pass-photo-link');
  if (passPhotoLink) passPhotoLink.addEventListener('click', () => { menuOpen = false; render(); openPassPhotoManager(); });

  const enableNotificationsLink = document.getElementById('enable-notifications-link');
  if (enableNotificationsLink){
    enableNotificationsLink.addEventListener('click', () => {
      menuOpen = false;
      Notification.requestPermission().then(() => render());
    });
  }

  const connectGcalLink = document.getElementById('connect-gcal-link');
  if (connectGcalLink){
    connectGcalLink.addEventListener('click', async () => {
      menuOpen = false; render();
      if (GOOGLE_CLIENT_ID.includes('YOUR_CLIENT_ID')){
        alert('Google Calendar isn\'t set up yet. See the setup notes for what\'s needed.');
        return;
      }
      const token = await getGoogleAccessToken();
      if (token){
        gcalEnabled = true;
        await saveGcalEnabled();
        const nb = findNextBuyDateKey(today, todayKey);
        if (nb){ gcalPendingSync = true; await syncGoogleCalendarEvent(nb); }
        render();
      }
    });
  }
  const disconnectGcalLink = document.getElementById('disconnect-gcal-link');
  if (disconnectGcalLink){
    disconnectGcalLink.addEventListener('click', async () => {
      menuOpen = false;
      gcalEnabled = false;
      await saveGcalEnabled();
      await deleteGoogleCalendarEvent(); // otherwise the tracked reminder just sits on the real calendar forever, untouched by anything from this point on
      render();
    });
  }
  const calendarSyncPrompt = document.getElementById('calendar-sync-prompt');

  const likelyTrainYesBtn = document.getElementById('likely-train-yes-btn');
  if (likelyTrainYesBtn){
    likelyTrainYesBtn.addEventListener('click', async () => {
      const s = likelyTrainSuggestion;
      // 2026-09-27: Copy for WhatsApp rides along with this tap — must be
      // the first thing that happens, before any await below.
      if (s) maybeCopyJourneyText(s.dateKey, s.direction, s.trainKey, s.label, 'prompt');
      if (s){
        if (!confirmedTrains[s.dateKey]) confirmedTrains[s.dateKey] = {};
        confirmedTrains[s.dateKey][s.direction] = s.trainKey;
        await saveConfirmedTrains();
        // 2026-09-14: the two silent-confirm paths (checkLikelyTrain,
        // checkLikelyArrival) already push to the Worker so a watch
        // ping around the same moment doesn't independently resolve
        // the same thing — this interactive path was missing the same
        // call, which let a departure-side watch mis-match pre-empt a
        // correct interactive confirm (see departure-match-drift-spec).
        pushConfirmedTrain(s.dateKey, s.direction, s.trainKey, s.label);
      }
      likelyTrainSuggestion = null;
      noteJourneyTextTarget();
      render();
    });
  }
  const likelyTrainNoBtn = document.getElementById('likely-train-no-btn');
  if (likelyTrainNoBtn){
    likelyTrainNoBtn.addEventListener('click', () => {
      if (likelyTrainSuggestion) dismissedLikelyTrainKeys.add(`${likelyTrainSuggestion.dateKey}-${likelyTrainSuggestion.direction}-${likelyTrainSuggestion.trainKey}`);
      likelyTrainSuggestion = null;
      noteJourneyTextTarget();
      render();
    });
  }

  if (calendarSyncPrompt){
    calendarSyncPrompt.addEventListener('click', async () => {
      let result;
      if (isCurrentlyInTicketGap(today, todayKey)){
        // Same reasoning as the automatic path — no active ticket right
        // now, so remove the tracked reminder rather than patch it
        // forward to a date nothing's actually confirmed yet.
        result = await deleteGoogleCalendarEvent();
      } else {
        const nb = findNextBuyDateKey(today, todayKey);
        result = nb ? await syncGoogleCalendarEvent(nb) : { ok: false, reason: 'no-buy-date-found' };
      }
      gcalLastSyncFailed = !result.ok;
      if (result.ok){
        alert(result.method === 'deleted' ? 'Calendar reminder removed — no active ticket to remind about.' : `Calendar ${result.method} for ${result.dateKey}\nEvent ID: ${result.eventId}`);
      } else {
        alert(`Calendar update failed: ${result.reason}${result.eventId ? `\nEvent ID used: ${result.eventId}` : ''}`);
      }
      render();
    });
  }

  const dismissBtn = document.getElementById('month-estimate-dismiss');
  if (dismissBtn){
    dismissBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      dismissedMonths[estMonthKey] = true;
      await saveDismissedMonths();
      render();
    });
  }
  const estimatePrevBtn = document.getElementById('estimate-prev');
  if (estimatePrevBtn){
    estimatePrevBtn.addEventListener('click', () => {
      estimateOffset = Math.max(0, estimateOffset - 1);
      render();
    });
  }
  const estimateNextBtn = document.getElementById('estimate-next');
  if (estimateNextBtn){
    estimateNextBtn.addEventListener('click', () => {
      estimateOffset = Math.min(24, estimateOffset + 1);
      render();
    });
  }
  const spendingCard = document.getElementById('spending-card');
  if (spendingCard){
    spendingCard.addEventListener('click', openManagePurchases);
  }
  const spendingCardDismiss = document.getElementById('spending-card-dismiss');
  if (spendingCardDismiss){
    spendingCardDismiss.addEventListener('click', async (e) => {
      e.stopPropagation(); // otherwise this bubbles up to the whole card's own click handler and opens Manage Purchases too
      ticketsSpentCardDismissed = true;
      await saveTicketsSpentCardDismissed();
      render();
    });
  }
  const parkingSavingsDismiss = document.getElementById('parking-savings-dismiss');
  if (parkingSavingsDismiss){
    parkingSavingsDismiss.addEventListener('click', async (e) => {
      e.stopPropagation();
      dismissedParkingSavingsPeriods[fmtKey(realCurrentPeriod.start)] = true;
      await saveDismissedParkingSavingsPeriods();
      render();
    });
  }
  const parkingSavingsPrevBtn = document.getElementById('parking-savings-prev');
  if (parkingSavingsPrevBtn){
    parkingSavingsPrevBtn.addEventListener('click', () => {
      parkingSavingsOffset -= 1;
      render();
    });
  }
  const parkingSavingsNextBtn = document.getElementById('parking-savings-next');
  if (parkingSavingsNextBtn){
    parkingSavingsNextBtn.addEventListener('click', () => {
      parkingSavingsOffset = Math.min(0, parkingSavingsOffset + 1); // never past the current period
      render();
    });
  }

  const showMoreBtn = document.getElementById('show-more-link');
  if (showMoreBtn){
    showMoreBtn.addEventListener('click', () => {
      state.daysAhead = Math.min(state.daysAhead + DAYS_AHEAD_STEP, MAX_DAYS_AHEAD);
      render();
    });
  }
  const showEarlierBtn = document.getElementById('show-earlier-link');
  if (showEarlierBtn){
    showEarlierBtn.addEventListener('click', () => {
      railDaysBack = Math.min(railDaysBack + RAIL_DAYS_BACK_STEP, RAIL_MAX_DAYS_BACK);
      render();
      railSyncMissingDates();
    });
  }
}
