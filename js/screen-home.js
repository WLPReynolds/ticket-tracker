// screen-home.js — render() — the Home tab. The sections it assembles live in home-sections.js.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.
const MAX_DAYS_AHEAD = 120; // used by tickets.js (findNextBuyDateKey look-ahead)

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
  // Seven-day strip, day panel, ticket pair, trains and money all share one view of "today".
  const weekSunday = addDays(homeWeekMonday(today), 6);
  const ctx = homeDayCtx(weekSunday);
  const states = ctx.states;
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
  const beforePeriod = ctx.beforePeriod;


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

  // ---------- Ticket pair: tickets left and next buy date, equal weight ----------
  const realPeriodEnd = ctx.realPeriodEnd;
  const isPhantomToday = !beforePeriod && todayKey > fmtKey(realPeriodEnd.endDate);
  const singleToday = isPhantomToday ? getSingleTicketForDate(todayKey) : null;
  const buyToday = !beforePeriod && !!todayState.buyFlag;

  // Next buy-ticket date, found independently of any list length, so it's always accurate.
  let nextBuyKey = null;
  let calendarPromptHtml = '';
  if (!beforePeriod){
    nextBuyKey = findNextBuyDateKey(today, todayKey);
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
      calendarPromptHtml = `<div class="ui-banner-note ui-tap" id="calendar-sync-prompt" style="text-decoration:underline;">${promptLabel}</div>`;
    }
  }

  let leftNum = '–', leftSub = '', usedForBar = 0;
  if (beforePeriod){
    leftSub = `Starts ${dateLabelShort(parseKey(periodStart))}`;
  } else if (isPhantomToday){
    leftSub = 'No active ticket';
  } else if (todayState.inGap){
    leftSub = 'No ticket needed yet';
  } else {
    leftNum = String(todayState.unusedRemaining);
    usedForBar = todayState.usedCount;
    leftSub = `Day ${todayState.daysElapsed} of 28`;
  }

  const buyShownKey = buyToday ? todayKey : nextBuyKey;
  let rightNum = '–', rightMonth = '', rightSub = beforePeriod ? 'Not started yet' : 'Nothing due yet';
  if (buyShownKey){
    const nd = parseKey(buyShownKey);
    rightNum = String(nd.getDate());
    rightMonth = nd.toLocaleDateString('en-GB', { month: 'short' });
    if (buyToday){
      const lost = (!isPhantomToday && todayState.lostDays) ? ` · ${todayState.unusedRemaining} unused lost` : '';
      rightSub = `Buy tonight for tomorrow${lost}`;
    } else {
      const diff = Math.round((nd.getTime() - today.getTime()) / 86400000);
      rightSub = `${nd.toLocaleDateString('en-GB', { weekday: 'long' })} · in ${diff} day${diff === 1 ? '' : 's'}`;
    }
  }

  // Supporting line under the bar — the banner states the old Home showed.
  let noteHtml = '';
  if (!beforePeriod){
    const marked = todayComment !== '' && !travelOverrides[todayKey];
    if (isPhantomToday){
      if (buyToday) noteHtml = '';
      else if (todayIsWeekend) noteHtml = '<div class="ui-banner-note">Weekend — no ticket needed</div>';
      else if (singleToday) noteHtml = `<div class="ui-banner-note">Single ticket used today (£${singleToday.cost.toFixed(2)})</div>`;
      else if (marked) noteHtml = `<div class="ui-banner-note">Marked "${escapeHtml(todayComment)}" — not counted</div>`;
      else noteHtml = '<div class="ui-banner-note ui-tap" id="renewal-banner-tap">No active season ticket — log a single ticket, or buy your next one ›</div>';
    } else if (todayState.inGap){
      noteHtml = '<div class="ui-banner-note">Nothing due until you next travel</div>';
    } else if (todayIsWeekend){
      noteHtml = '<div class="ui-banner-note">Weekend — no ticket needed</div>';
    } else if (marked){
      noteHtml = `<div class="ui-banner-note">Marked "${escapeHtml(todayComment)}" — not counted</div>`;
    } else if (todayComment !== ''){
      noteHtml = `<div class="ui-banner-note">Marked "${escapeHtml(todayComment)}" but counted</div>`;
    }
  }
  const segments = Array.from({ length: 8 }, (_, i) => `<span class="${i < usedForBar ? 'on' : ''}"></span>`).join('');
  const rightHalf = buyToday
    ? `<button type="button" class="ui-pair-half ui-pair-buy ui-pair-action" id="renewal-banner-tap"><div class="ui-label">Buy next ticket</div><div class="ui-pair-big"><span class="ui-pair-num">${rightNum}</span><span class="ui-pair-unit ui-pair-unit-strong">${rightMonth}</span></div><div class="ui-train-sub">${rightSub}</div></button>`
    : `<div class="ui-pair-half"><div class="ui-label">Buy next ticket</div><div class="ui-pair-big"><span class="ui-pair-num">${rightNum}</span><span class="ui-pair-unit ui-pair-unit-strong">${rightMonth}</span></div><div class="ui-train-sub">${rightSub}</div></div>`;

  // ---------- Money row: three figures, each behind its own Settings switch ----------
  const realCurrentPeriod = getPayPeriodByOffset(today, 0);
  const estMonthKey = fmtKey(realCurrentPeriod.start);
  // Lock in the preceding period's parking figure the first time it's seen after ticking over
  // (a finished period's total shouldn't drift if a day is edited afterwards).
  homeParkingSavingsFor(today, -1);
  const currentYear = today.getFullYear();
  const yearToDatePurchases = purchases.filter(p => parseKey(p.date).getFullYear() === currentYear);
  const moneyHtml = homeMoneyRowHtml({
    payday: dismissedMonths[estMonthKey] ? null : estimateForPeriod(today, 0),
    parking: (!beforePeriod && !dismissedParkingSavingsPeriods[estMonthKey]) ? homeParkingSavingsFor(today, 0) : null,
    spent: ticketsSpentCardDismissed ? null : { total: yearToDatePurchases.reduce((sum, p) => sum + p.cost, 0), count: yearToDatePurchases.length },
  });

  const trainsInner = railTrains.length ? homeTrainsInnerHtml() : '';
  const trainsHtml = trainsInner ? `
    <div class="ui-section-head"><div class="ui-label">Your trains</div><span class="ui-link" id="home-live-link">Live board</span></div>
    <div id="home-trains">${trainsInner}</div>` : '';

  const stripHtml = homeBuildStrip(ctx);
  const weekLinkHtml = homeWeekOffset !== 0 ? '<span class="ui-link" id="home-week-today">This week</span>' : '';

  app.className = '';
  app.innerHTML = `
    <header class="top ui-home-head">
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
        <span class="bunting-flag" style="background:var(--holiday);"></span>
        <span class="bunting-flag" style="background:var(--good);"></span>
        <span class="bunting-flag" style="background:var(--amber);"></span>
        <span class="bunting-flag" style="background:var(--holiday);"></span>
        <span class="bunting-flag" style="background:var(--good);"></span>
        <span class="bunting-flag" style="background:var(--amber);"></span>
      </div>` : ''}
      <div>
        <div class="ui-home-date">${dateLabel(today)}</div>
        <div class="ui-home-version">${APP_VERSION}</div>
      </div>
      ${delayRepayBadgeHtml}
      ${menuOpen ? `
      <div class="menu-dropdown" id="menu-dropdown">
        ${menuItemsHtml}
      </div>` : ''}
    </header>

    <div class="ui-card">
      <div class="ui-pair">
        <div class="ui-pair-half">
          <div class="ui-label">Tickets left</div>
          <div class="ui-pair-big"><span class="ui-pair-num">${leftNum}</span><span class="ui-pair-unit">of 8</span></div>
          <div class="ui-train-sub">${leftSub}</div>
        </div>
        ${rightHalf}
      </div>
      <div class="ui-segments" role="img" aria-label="${usedForBar} of 8 tickets used">${segments}</div>
      ${noteHtml}
      ${calendarPromptHtml}
    </div>

    ${homeHolidayLineHtml(today)}

    ${trainsHtml}

    <div class="ui-section-head"><div class="ui-label">Days</div><span>${weekLinkHtml}<span class="ui-link" id="home-month-link">Month view</span></span></div>
    ${stripHtml}
    <div class="ui-card" id="home-day-panel" style="margin-top:var(--space-2);">${homeBuildDayPanel(homeSelectedDayKey, ctx)}</div>

    ${moneyHtml}

    <div style="height:var(--space-5);"></div>

    <nav class="bottom-nav">
      <div class="bottom-nav-item ${state.activeTab==='today'?'active':''}" id="bottom-nav-today">${NAV_ICONS.today}<span class="bn-label">Home</span></div>
      <div class="bottom-nav-item ${state.activeTab==='live'?'active':''}" id="bottom-nav-live">${NAV_ICONS.live}<span class="bn-label">Live</span></div>
      <div class="bottom-nav-item ${state.activeTab==='buy'?'active':''}" id="bottom-nav-buy">${NAV_ICONS.buy}<span class="bn-label">Buy</span></div>
      <div class="bottom-nav-item ${state.activeTab==='calendar'?'active':''}" id="bottom-nav-calendar">${NAV_ICONS.calendar}<span class="bn-label">Calendar</span></div>
      <div class="bottom-nav-item ${menuOpen?'active':''}" id="bottom-nav-more">${NAV_ICONS.more}<span class="bn-label">More</span></div>
    </nav>
  `;

  // ---------- Home wiring ----------
  const panelEl = document.getElementById('home-day-panel');
  homeWireDayPanel(panelEl);
  const stripEl = document.getElementById('home-strip');
  stripEl.querySelectorAll('.ui-day').forEach(b => b.addEventListener('click', () => {
    homeSelectedDayKey = b.dataset.dayKey;
    stripEl.querySelectorAll('.ui-day').forEach(x => x.classList.toggle('is-selected', x === b));
    panelEl.innerHTML = homeBuildDayPanel(homeSelectedDayKey, ctx);
    homeWireDayPanel(panelEl);
  }));
  let swipeX = null, swipeY = null;
  stripEl.addEventListener('touchstart', (e) => { swipeX = e.touches[0].clientX; swipeY = e.touches[0].clientY; }, { passive: true });
  stripEl.addEventListener('touchend', (e) => {
    if (swipeX === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeX, dy = t.clientY - swipeY;
    swipeX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) homeShiftWeek(dx < 0 ? 1 : -1);
  });
  const weekTodayLink = document.getElementById('home-week-today');
  if (weekTodayLink) weekTodayLink.addEventListener('click', () => { homeWeekOffset = 0; homeSelectedDayKey = null; render(); });
  document.getElementById('home-month-link').addEventListener('click', () => openCalendarView());
  const holidayLine = document.getElementById('home-holiday-line');
  if (holidayLine) holidayLine.addEventListener('click', () => openCalendarView());
  const moneyEl = document.getElementById('home-money');
  if (moneyEl) moneyEl.addEventListener('click', () => openMoneyDetails());
  const moneyLink = document.getElementById('home-money-link');
  if (moneyLink) moneyLink.addEventListener('click', () => openMoneyDetails());
  const liveLink = document.getElementById('home-live-link');
  if (liveLink) liveLink.addEventListener('click', () => homeOpenLive());
  homeWireTrains();
  homeEnsureBoards();


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
    homeWeekOffset = 0;
    homeSelectedDayKey = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

  if (homePageRefresh) homePageRefresh(); // keeps an open Month view / Money details in step with the data
}
