// home-sections.js — building blocks for the Home tab (facelift stage 3, 2026-11-12).
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.
// Spec: claude/facelift-spec.md in the Project. Styles: the "Stage 3" parts at the end of css/design.css.
// Declarations only — nothing runs at load. screen-home.js render() assembles these;
// openCalendarView (screen-calendar.js) reuses the day panel and countdown card.

let homeWeekOffset = 0;          // 0 = this week, -1 = last week … (swipe on the day strip)
let homeSelectedDayKey = null;   // day shown in the panel under the strip; null = today
let homePageRefresh = null;      // set while Month view / Money details is open; render() calls it
// Live boards for the Your trains card — session-only, refetched at most once a minute.
const HOME_BOARDS_MAX_AGE_MS = 60000;
let homeBoardsCache = { at: 0, boards: null, loading: false, error: null };

// ---------- Shared day information (strip, Month view, day panel) ----------
// One place that works out what a day looks like, so the strip, the month grid and the panel agree.
function homeDayCtx(minRangeEnd){
  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const todayKey = fmtKey(today);
  const floor = addDays(today, Math.max(state.daysAhead || 0, 35));
  const rangeEnd = (minRangeEnd && minRangeEnd > floor) ? minRangeEnd : floor;
  const states = computeStates(rangeEnd);
  const beforePeriod = !states[todayKey];
  return { today, todayKey, states, beforePeriod, realPeriodEnd: beforePeriod ? null : getRealPeriodEnd() };
}

function homeDayInfo(d, ctx){
  const key = fmtKey(d);
  const weekend = isWeekend(d);
  const comment = (comments[key] || '').trim();
  const overridden = comment !== '' && !!travelOverrides[key];
  const info = { key, d, weekend, comment, overridden, isToday: key === ctx.todayKey, hasState: false, mark: '–', markClass: 'dim', tag: '', ticketDay: null, buy: false, delay: null };
  const s = ctx.states[key] || findHistoricalStateForDate(key);
  if (isEligibleRailDay(d, ctx.todayKey)) info.delay = getDelayStatus(key) || null;
  if (!s){
    info.tag = weekend ? 'Weekend' : 'Before this ticket';
    return info;
  }
  info.hasState = true;
  const isPastPhantom = !weekend && !ctx.beforePeriod && key <= ctx.todayKey && key > fmtKey(ctx.realPeriodEnd.endDate);
  const single = isPastPhantom ? getSingleTicketForDate(key) : null;
  const esc = escapeHtml(comment);
  if (isPastPhantom){
    info.mark = single ? 'S' : '–';
    info.markClass = single ? 'buy' : 'dim';
    if (comment && single) info.tag = `${esc} · Single ticket (£${single.cost.toFixed(2)})`;
    else if (single) info.tag = `Single ticket (£${single.cost.toFixed(2)})`;
    else if (comment) info.tag = esc + (overridden ? ' · counted' : '');
    else info.tag = 'No active ticket';
    return info;
  }
  info.buy = !!s.buyFlag;
  if (weekend || s.inGap){
    info.mark = '–'; info.markClass = 'dim';
  } else if (comment && !overridden){
    info.mark = comment.length <= 4 ? comment.toUpperCase() : comment.slice(0, 3).toUpperCase() + '…';
    info.markClass = 'dim';
  } else {
    info.mark = String(s.usedCount);
    info.markClass = '';
    info.ticketDay = s.usedCount;
  }
  if (s.buyFlag) info.markClass = 'buy';
  const lost = s.lostDays ? ` · ${s.unusedRemaining} lost` : '';
  if (comment && s.buyFlag) info.tag = `${esc}${overridden ? ' · counted' : ''} · Buy ticket${lost}`;
  else if (comment) info.tag = esc + (overridden ? ' · counted' : '');
  else if (s.buyFlag) info.tag = `Buy ticket${lost}`;
  else if (weekend) info.tag = 'Weekend';
  return info;
}

// ---------- Seven-day strip ----------
function homeWeekMonday(today){
  const base = addDays(today, homeWeekOffset * 7);
  return addDays(base, -((base.getDay() + 6) % 7));
}

function homeBuildStrip(ctx){
  const monday = homeWeekMonday(ctx.today);
  const keys = [];
  for (let i = 0; i < 7; i++) keys.push(fmtKey(addDays(monday, i)));
  if (!homeSelectedDayKey || !keys.includes(homeSelectedDayKey)){
    homeSelectedDayKey = keys.includes(ctx.todayKey) ? ctx.todayKey : keys[0];
  }
  const cells = keys.map(key => {
    const d = parseKey(key);
    const info = homeDayInfo(d, ctx);
    const dot = info.delay ? `<span class="ui-day-dot ${info.delay}"></span>` : '<span class="ui-day-dot"></span>';
    const label = `${dayNameShort(d)} ${d.getDate()}${info.ticketDay ? `, ticket day ${info.ticketDay}` : ''}${info.delay ? ', delay repay ' + info.delay : ''}`;
    return `<button type="button" class="ui-day ${info.isToday ? 'is-today' : ''} ${key === homeSelectedDayKey ? 'is-selected' : ''}" data-day-key="${key}" aria-label="${escapeHtml(label)}">
      <span class="ui-day-wk">${dayNameShort(d)}</span>
      <span class="ui-day-date">${d.getDate()}</span>
      <span class="ui-day-mark ${info.markClass}">${info.mark}</span>
      ${dot}
    </button>`;
  }).join('');
  return `<div class="ui-strip" id="home-strip">${cells}</div>`;
}

function homeShiftWeek(dir){
  const minOffset = -Math.floor(RAIL_MAX_DAYS_BACK / 7);
  const next = Math.max(minOffset, Math.min(12, homeWeekOffset + dir));
  if (next === homeWeekOffset) return;
  homeWeekOffset = next;
  homeSelectedDayKey = null;
  if (homeWeekOffset < 0) railDaysBack = Math.min(Math.max(railDaysBack, -homeWeekOffset * 7 + 7), RAIL_MAX_DAYS_BACK);
  render();
  if (homeWeekOffset < 0) railSyncMissingDates();
}

// The claims block for one day (the Morning / Evening columns with claim pills). '' if none.
function homeDayClaimsHtml(key, todayKey){
  const d = parseKey(key);
  const dayPerf = railPerfCache[key] || {};
  if (!(isEligibleRailDay(d, todayKey) && Object.keys(dayPerf).length > 0)) return '';
  const amTrains = railTrains.filter(t => t.direction === 'AM').sort((a, b) => a.time.localeCompare(b.time));
  const pmTrains = railTrains.filter(t => t.direction === 'PM').sort((a, b) => a.time.localeCompare(b.time));
  const none = '<div class="rail-detail-row"><span style="color:var(--ink-dim);">None configured</span></div>';
  return `<div class="ui-daypanel-claims"><div style="display:flex; gap:24px;">
    <div style="flex:1;"><div class="rail-col-header">Morning</div>${amTrains.length ? railDetailRowsForClaim(amTrains, dayPerf, key, 'AM') : none}</div>
    <div style="flex:1;"><div class="rail-col-header">Evening</div>${pmTrains.length ? railDetailRowsForClaim(pmTrains, dayPerf, key, 'PM') : none}</div>
  </div></div>`;
}

// The panel under the strip / month grid: status line, Edit day, and any delay claims.
function homeBuildDayPanel(key, ctx){
  const d = parseKey(key);
  const info = homeDayInfo(d, ctx);
  const title = info.isToday ? 'Today' : `${dayNameShort(d)} ${dateLabelShort(d)}`;
  const parts = [];
  if (info.ticketDay) parts.push(`Ticket day ${info.ticketDay}`);
  if (info.tag) parts.push(info.tag);
  const sub = parts.join(' · ') || 'Nothing logged';
  const edit = info.weekend ? '' : `<button type="button" class="ui-btn-secondary" id="day-panel-edit" data-day-key="${key}">Edit day</button>`;
  return `<div class="ui-daypanel">
    <div class="ui-daypanel-head"><div class="ui-daypanel-text"><div class="ui-daypanel-title">${title}</div><div class="ui-daypanel-sub">${sub}</div></div>${edit}</div>
    ${homeDayClaimsHtml(key, ctx.todayKey)}
  </div>`;
}

// Wire a panel built by homeBuildDayPanel inside `container`.
function homeWireDayPanel(container){
  const edit = container.querySelector('#day-panel-edit');
  if (edit) edit.addEventListener('click', () => openDayEditor(edit.dataset.dayKey));
  wireClaimHandlers(container, () => {});
}

// ---------- Holiday: the line on Home and the card in Month view ----------
// 5 working days before the next holiday, the last working day, and through the holiday itself.
const HOME_HOLIDAY_LINE_DAYS = 5;
function homeHolidayState(today){
  const todayKey = fmtKey(today);
  const nextKey = findNextHoliday(todayKey);
  if (!nextKey) return null;
  const hDate = parseKey(nextKey);
  const c = getHolidayCountdownState(today, new Date(), hDate);
  return { hDate, c };
}

function homeHolidayLineHtml(today){
  const h = homeHolidayState(today);
  if (!h) return '';
  const { hDate, c } = h;
  let text;
  if (c.mode === 'off'){
    text = `<strong>Enjoy your holiday</strong> <span class="ui-holiday-sub">· Back to work ${dateLabelShort(c.backToWorkDay)}</span>`;
  } else if (c.mode === 'hours'){
    text = `<strong>${c.hours}h ${c.minutes}m</strong> <span class="ui-holiday-sub">until your holiday · starts ${dayNameShort(hDate)} ${dateLabelShort(hDate)}</span>`;
  } else if (c.dayCount <= HOME_HOLIDAY_LINE_DAYS){
    text = `<strong>Holiday in ${c.dayCount} working day${c.dayCount === 1 ? '' : 's'}</strong> <span class="ui-holiday-sub">· starts ${dayNameShort(hDate)} ${dateLabelShort(hDate)}</span>`;
  } else {
    return '';
  }
  return `<div class="ui-holiday-line" id="home-holiday-line" role="button"><div class="ui-holiday-text">${text}</div><span class="ui-train-chev">${UI_ICON_CHEV}</span></div>`;
}

function homeCountdownCardHtml(today){
  const h = homeHolidayState(today);
  if (!h) return '';
  const { hDate, c } = h;
  let big, bigClass = '', label, sub;
  if (c.mode === 'off'){
    big = 'Off'; bigClass = ' small';
    label = 'Enjoy your holiday'; sub = `Back to work ${dateLabel(c.backToWorkDay)}`;
  } else if (c.mode === 'hours'){
    big = `${c.hours}h ${c.minutes}m`; bigClass = ' small';
    label = "Until you're off for your holiday"; sub = dateLabel(hDate);
  } else {
    big = String(c.dayCount);
    label = `Working day${c.dayCount === 1 ? '' : 's'} until your next holiday`; sub = dateLabel(hDate);
  }
  return `<div class="ui-card ui-countdown"><div class="ui-countdown-num${bigClass}">${big}</div><div class="ui-countdown-text"><div style="font-size:var(--fs-body); font-weight:600;">${label}</div><div class="ui-train-sub">${sub}</div></div></div>`;
}

// ---------- Your trains ----------
function homeTimeLabel(t){ return t.slice(0, 2) + ':' + t.slice(2, 4); }
function homeStationLabel(crs){ return stationNameForCrs(crs) || crs; }

function homeServiceFor(train){
  if (!homeBoardsCache.boards) return null;
  const board = homeBoardsCache.boards[`${train.fromLoc}-${train.toLoc}`] || [];
  return board.find(s => s.std === homeTimeLabel(train.time)) || null;
}

// ---- Which trains the card shows (2026-11-12, Wayne) ----
// Every train set up in Settings → Trains for the journey in hand:
// today's morning trains until the last one has actually left, then today's
// evening trains until the last one has left, then the next working day's
// morning trains. The big slot goes to the next train that hasn't left yet,
// judged from live data, so a late 16:31 still at the platform at 17:00
// stays big. A cancelled train is never promoted.
const HOME_DEPART_GRACE_MIN = 2;

function homeMinutes(hhmm){ return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2, 4), 10); }
function homeNowMinutes(){ const p = londonParts(new Date()); return p.hour * 60 + p.minute; }
function homeTrainsFor(dir){ return railTrains.filter(t => t.direction === dir).sort((a, b) => a.time.localeCompare(b.time)); }

// Expected departure in minutes past midnight from a board service (etd "HH:MM"), else the schedule.
function homeExpectedMinutes(train, service){
  if (service && /^\d{2}:\d{2}$/.test(service.etd || '')) return homeMinutes(service.etd.replace(':', ''));
  return homeMinutes(train.time);
}

// Has today's run of this train left? Live board first, schedule as the fallback.
function homeHasDeparted(train, service){
  const now = homeNowMinutes();
  if (service){
    if (service.atd) return true;
    if (service.isCancelled) return now > homeMinutes(train.time) + HOME_DEPART_GRACE_MIN;
    if (service.etd === 'Delayed') return false;
    return now > homeExpectedMinutes(train, service) + HOME_DEPART_GRACE_MIN;
  }
  // Not on the board: once its time has come it has dropped off, i.e. left.
  if (homeBoardsCache.boards) return now >= homeMinutes(train.time);
  return now > homeMinutes(train.time) + HOME_DEPART_GRACE_MIN;
}

function homeNextTravelDay(from){
  for (let i = 1; i <= 21; i++){
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (!nonTravelLabelFor(fmtKey(d))) return { date: d, offset: i };
  }
  return null;
}

// { dir, live, label, trains } for the card, or null with nothing set up.
function homeJourney(){
  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const todayKey = fmtKey(today);
  if (!nonTravelLabelFor(todayKey)){
    for (const dir of ['AM', 'PM']){
      const trains = homeTrainsFor(dir);
      if (trains.some(t => !homeHasDeparted(t, homeServiceFor(t)))){
        return { dir, live: true, label: dir === 'AM' ? 'This morning' : 'This evening', trains };
      }
    }
  }
  const trains = homeTrainsFor('AM');
  if (!trains.length) return null;
  const next = homeNextTravelDay(today);
  let label = 'Next morning';
  if (next){
    if (next.offset === 1) label = 'Tomorrow morning';
    else if (next.offset < 7) label = `${next.date.toLocaleDateString('en-GB', { weekday: 'long' })} morning`;
    else label = `${dateLabelShort(next.date)} morning`;
  }
  return { dir: 'AM', live: false, label, trains };
}

// { text, cls } describing a train's state. live=false: a future day, no live data yet.
function homeTrainStatus(train, service, live){
  if (!live) return { text: 'Scheduled', cls: '' };
  if (service && service.isCancelled) return { text: 'Cancelled', cls: 'ui-pill-bad' };
  if (homeHasDeparted(train, service)) return { text: 'Departed', cls: '' };
  if (!service){
    if (!homeBoardsCache.boards && !homeBoardsCache.error) return { text: 'Checking…', cls: '' };
    return { text: 'Scheduled', cls: '' };
  }
  if (!service.etd || service.etd === 'On time') return { text: 'On time', cls: 'ui-pill-good' };
  if (service.etd === 'Delayed') return { text: 'Delayed', cls: 'ui-pill-warn' };
  return { text: `Now ${service.etd}`, cls: 'ui-pill-warn' };
}

function homeOpenLive(){
  closeAllModals();
  menuOpen = false;
  state.activeTab = 'live';
  render();
  openLiveScreen();
}

function homeTrainsInnerHtml(){
  const j = homeJourney();
  if (!j || !j.trains.length) return '';

  const suggestion = likelyTrainSuggestion ? `
    <div class="ui-train-suggest">
      <div class="ui-train-suggest-title">Is this your train?</div>
      <div class="ui-train-suggest-text">Looks like you might be on the delayed <strong class="ui-amber">${escapeHtml(likelyTrainSuggestion.label)}</strong> instead of your usual one.</div>
      <div class="ui-train-suggest-btns"><button type="button" class="ui-btn-primary" id="likely-train-yes-btn">Yes, that's me</button><button type="button" class="ui-btn-secondary" id="likely-train-no-btn">No</button></div>
    </div>` : '';

  const rows = j.trains.map(t => {
    const svc = j.live ? homeServiceFor(t) : null;
    return { t, svc, st: homeTrainStatus(t, svc, j.live), gone: j.live && homeHasDeparted(t, svc) };
  });
  // The big one: the next train that hasn't left and isn't cancelled; failing that, the next not gone.
  const main = rows.find(r => !r.gone && !(r.svc && r.svc.isCancelled)) || rows.find(r => !r.gone) || rows[0];
  const pill = r => r.st ? `<span class="ui-pill ${r.st.cls}">${escapeHtml(r.st.text)}</span>` : '';
  const plat = r => r.svc && r.svc.platform && !r.gone ? `Platform ${escapeHtml(String(r.svc.platform))}` : '';

  const html = rows.map(r => {
    if (r === main){
      return `<div class="ui-train-main" data-home-train="${r.t.key}">
        <div class="ui-train-info">
          <div class="ui-label">${escapeHtml(j.label)}</div>
          <div class="ui-train-time-row"><span class="ui-train-time">${homeTimeLabel(r.t.time)}</span>${pill(r)}</div>
          <div class="ui-train-route">${escapeHtml(homeStationLabel(r.t.fromLoc))} to ${escapeHtml(homeStationLabel(r.t.toLoc))}</div>
          ${plat(r) ? `<div class="ui-train-sub">${plat(r)}</div>` : ''}
        </div>
        <span class="ui-train-chev">${UI_ICON_CHEV}</span>
      </div>`;
    }
    return `<div class="ui-train-line${r.gone ? ' is-gone' : ''}" data-home-train="${r.t.key}">
      <span class="ui-train-line-time">${homeTimeLabel(r.t.time)}</span>
      ${pill(r)}
      <span class="ui-train-line-text">${plat(r)}</span>
      <span class="ui-train-chev">${UI_ICON_CHEV}</span>
    </div>`;
  });
  // Main first, then the others in time order.
  const mainIdx = rows.indexOf(main);
  const ordered = [html[mainIdx], ...html.filter((_, i) => i !== mainIdx)];
  return `<div class="ui-card ui-card-flush">${ordered.join('')}${suggestion}</div>`;
}

function homeWireLikelyTrainButtons(){
  const yes = document.getElementById('likely-train-yes-btn');
  if (yes){
    yes.addEventListener('click', async () => {
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
        // the same thing — this interactive path needs the same call
        // (see departure-match-drift-spec).
        pushConfirmedTrain(s.dateKey, s.direction, s.trainKey, s.label);
      }
      likelyTrainSuggestion = null;
      noteJourneyTextTarget();
      render();
    });
  }
  const no = document.getElementById('likely-train-no-btn');
  if (no){
    no.addEventListener('click', () => {
      if (likelyTrainSuggestion) dismissedLikelyTrainKeys.add(`${likelyTrainSuggestion.dateKey}-${likelyTrainSuggestion.direction}-${likelyTrainSuggestion.trainKey}`);
      likelyTrainSuggestion = null;
      noteJourneyTextTarget();
      render();
    });
  }
}

function homeWireTrains(){
  document.querySelectorAll('#home-trains [data-home-train]').forEach(el => {
    el.addEventListener('click', () => {
      const train = railTrains.find(t => t.key === el.dataset.homeTrain);
      const svc = train ? homeServiceFor(train) : null;
      if (train && svc && !svc.isCancelled) openTrainProgress(train, svc);
      else homeOpenLive();
    });
  });
  homeWireLikelyTrainButtons();
}

function homePaintTrains(){
  const el = document.getElementById('home-trains');
  if (!el) return;
  el.innerHTML = homeTrainsInnerHtml();
  homeWireTrains();
}

// Fetch live boards for the usual trains, at most once a minute, and only on a commute day.
// Updates the card in place (no full render) so the page doesn't flicker or loop.
function homeEnsureBoards(){
  if (!railTrains.length || homeBoardsCache.loading) return;
  const todayKey = fmtKey(new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate()));
  if (nonTravelLabelFor(todayKey)) return;
  if (homeBoardsCache.at && (Date.now() - homeBoardsCache.at) < HOME_BOARDS_MAX_AGE_MS) return;
  homeBoardsCache.loading = true;
  fetchLiveBoards().then(b => { homeBoardsCache.boards = b; homeBoardsCache.error = null; })
    .catch(e => { homeBoardsCache.error = e.message || 'failed'; })
    .finally(() => { homeBoardsCache.loading = false; homeBoardsCache.at = Date.now(); homePaintTrains(); });
}

// ---------- Money ----------
// Parking savings for a pay period offset (0 = current, live; negative = locked snapshot).
// Locks the snapshot the first time a past period is seen, exactly as the old card did.
function homeParkingSavingsFor(today, offset){
  const period = getPayPeriodByOffset(today, offset);
  const startKey = fmtKey(period.start);
  if (offset === 0){
    const budget = getOrLockParkingBudgetDays(period.start, period.end, today);
    return computeParkingSavingsForPeriod(period.start, period.end, today, budget, parkedDays, parkingCost);
  }
  if (parkingSavingsSnapshots[startKey] !== undefined) return parkingSavingsSnapshots[startKey];
  const budget = getOrLockParkingBudgetDays(period.start, period.end, today);
  const v = computeParkingSavingsForPeriod(period.start, period.end, today, budget, parkedDays, parkingCost);
  parkingSavingsSnapshots[startKey] = v;
  saveParkingSavingsSnapshots();
  return v;
}

function homeMoneyText(v){ return v >= 0 ? `£${v.toFixed(2)}` : `£${Math.abs(v).toFixed(2)} over`; }

// m: { payday: est|null, parking: number|null, spent: {total,count}|null }
function homeMoneyRowHtml(m){
  const figs = [];
  if (m.payday) figs.push(`<div class="ui-figure"><div class="ui-figure-label">Set aside</div><div class="ui-figure-value ui-amber ui-num">£${m.payday.total.toFixed(2)}</div><div class="ui-figure-note">${m.payday.ticketCount} ticket${m.payday.ticketCount === 1 ? '' : 's'} + ${m.payday.parkingDays} parking</div></div>`);
  if (m.parking !== null) figs.push(`<div class="ui-figure"><div class="ui-figure-label">Parking saved</div><div class="ui-figure-value ui-num ${m.parking >= 0 ? 'ui-good' : 'ui-bad'}">${homeMoneyText(m.parking)}</div><div class="ui-figure-note">this period</div></div>`);
  if (m.spent) figs.push(`<div class="ui-figure"><div class="ui-figure-label">Spent this year</div><div class="ui-figure-value ui-num">£${m.spent.total.toFixed(2)}</div><div class="ui-figure-note">${m.spent.count} ticket${m.spent.count === 1 ? '' : 's'}</div></div>`);
  if (!figs.length) return '';
  return `<div class="ui-section-head"><div class="ui-label">Money</div><span class="ui-link" id="home-money-link">Details</span></div>
    <div class="ui-card ui-money" id="home-money">${figs.join('')}</div>`;
}

function openMoneyDetails(){
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `${uiPageBar('Money', { backId: 'money-close-btn', backLabel: 'Back to Home' })}<div class="ui-page-body" id="money-body"></div>`;
  document.body.appendChild(overlay);
  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const MIN = -12, MAX = 24;
  let offset = 0;

  function draw(){
    const period = getPayPeriodByOffset(today, offset);
    const startKey = fmtKey(period.start);
    const label = `${dateLabelShort(period.start)} – ${dateLabelShort(period.end)}`;
    const nowLabel = offset === 0 ? ' · this period' : '';

    let setAside;
    if (offset < 0 && !paydayEstimateSnapshots[startKey]){
      setAside = '<div class="ui-train-sub">No payday figure was kept for this period.</div>';
    } else {
      const est = estimateForPeriod(today, offset);
      setAside = `<div class="ui-figure-value ui-figure-large ui-amber ui-num">£${est.total.toFixed(2)}</div>
        <div class="ui-train-sub" style="margin-top:6px;">${est.ticketCount} ticket${est.ticketCount === 1 ? '' : 's'} (£${est.ticketCost.toFixed(2)}) + ${est.parkingDays} parking day${est.parkingDays === 1 ? '' : 's'} (£${est.parkingCost.toFixed(2)})</div>`;
    }
    let parking = '';
    if (offset <= 0){
      const v = homeParkingSavingsFor(today, offset);
      parking = `<div class="ui-card ui-block"><div class="ui-block-title">Parking savings</div>
        <div class="ui-figure-value ui-figure-large ui-num ${v >= 0 ? 'ui-good' : 'ui-bad'}">${v >= 0 ? '£' + v.toFixed(2) + ' saved' : '£' + Math.abs(v).toFixed(2) + ' over budget'}</div></div>`;
    }
    const year = today.getFullYear();
    const bought = purchases.filter(p => parseKey(p.date).getFullYear() === year);
    const spent = bought.reduce((sum, p) => sum + p.cost, 0);

    document.getElementById('money-body').innerHTML = `
      <div class="ui-period">
        <button type="button" class="ui-period-btn" id="money-prev" aria-label="Earlier pay period" ${offset <= MIN ? 'disabled' : ''}>&#8249;</button>
        <div class="ui-period-label">Payday period ${label}${nowLabel}</div>
        <button type="button" class="ui-period-btn" id="money-next" aria-label="Later pay period" ${offset >= MAX ? 'disabled' : ''}>&#8250;</button>
      </div>
      <div class="ui-card ui-block" style="margin-top:var(--space-2);"><div class="ui-block-title">Set aside on payday</div>${setAside}</div>
      ${parking}
      <div class="ui-card ui-block"><div class="ui-block-title">This year</div>
        <div class="ui-figure-value ui-figure-large ui-num">£${spent.toFixed(2)}</div>
        <div class="ui-train-sub" style="margin:6px 0 var(--space-3);">Spent on tickets · ${bought.length} logged in ${year}</div>
        <button type="button" class="ui-btn-secondary" id="money-manage">Manage purchases</button>
      </div>`;
    document.getElementById('money-prev').addEventListener('click', () => { offset = Math.max(MIN, offset - 1); draw(); });
    document.getElementById('money-next').addEventListener('click', () => { offset = Math.min(MAX, offset + 1); draw(); });
    document.getElementById('money-manage').addEventListener('click', () => openManagePurchases());
  }
  homePageRefresh = draw;
  document.getElementById('money-close-btn').addEventListener('click', () => {
    homePageRefresh = null;
    overlay.remove();
  });
  draw();
}
