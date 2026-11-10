// tickets.js — Ticket periods and states, next buy date, holiday countdown, pay periods, payday estimates, parking savings, bank holidays.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

async function syncBankHolidays(){
  let events = null;

  try{
    const resp = await fetch('https://www.gov.uk/bank-holidays.json');
    if (resp.ok){
      const data = await resp.json();
      events = (data['england-and-wales'] && data['england-and-wales'].events) || [];
      try{ localStorage.setItem('bank-holidays-cache', JSON.stringify(events)); }catch(e){}
    }
  }catch(e){ /* offline or blocked — fall back to cache below */ }

  if (!events){
    try{
      const cached = localStorage.getItem('bank-holidays-cache');
      events = cached ? JSON.parse(cached) : [];
    }catch(e){ events = []; }
  }

  let changed = false;
  for (const ev of events){
    if (ev && ev.date && !comments[ev.date]){
      comments[ev.date] = 'BANK HOLIDAY';
      changed = true;
    }
  }
  if (changed) await saveComments();
  return changed;
}

// Find the first date after 'afterDate' (exclusive) that actually needs a ticket
// (a weekday with no comment). Capped to avoid runaway loops.
function findNextTravelDay(afterDate){
  let d = addDays(afterDate, 1);
  let guard = 0;
  while (guard < 400){
    const key = fmtKey(d);
    const isTravel = (comments[key] || '').trim() === '' || travelOverrides[key];
    if (!isWeekend(d) && isTravel){
      return d;
    }
    d = addDays(d, 1);
    guard++;
  }
  return d;
}

// Compute per-day state from periodStart up to targetDate inclusive.
// Ticket periods run up to 28 calendar days OR 8 used days, whichever comes first.
// Once a period ends, the next one doesn't start until the next day actually
// needed (skipping weekends/comment days) — you buy the ticket the day before
// you next need it, not automatically the day after the old one runs out.
// Returns a map dateKey -> { usedCount, daysElapsed, periodEnded, lostDays,
//   unusedRemaining, inGap, buyFlag }
// Finds the actual pay date for a given month: the 28th, walked backward
// a day at a time over weekends and bank holidays until it lands on a
// working day.
function getPayDate(year, monthIndex){
  let d = new Date(year, monthIndex, 28);
  while (true){
    const key = fmtKey(d);
    const isBankHoliday = (comments[key] || '').trim().toUpperCase() === 'BANK HOLIDAY';
    if (!isWeekend(d) && !isBankHoliday) return d;
    d = addDays(d, -1);
  }
}

// Returns {start, end} for the pay period `offset` periods away from the one
// containing `baseDate`. offset 0 = the period baseDate currently falls in,
// 1 = the next period, 2 = the one after that, etc. Negative offsets look
// backward. A period runs from one payday up to (not including) the next.
function getPayPeriodByOffset(baseDate, offset){
  let year = baseDate.getFullYear(), month = baseDate.getMonth();
  const thisMonthPay = getPayDate(year, month);
  let currentPayDate, nextPayDate;
  if (fmtKey(baseDate) >= fmtKey(thisMonthPay)){
    currentPayDate = thisMonthPay;
    let nm = month + 1, ny = year; if (nm > 11){ nm = 0; ny++; }
    nextPayDate = getPayDate(ny, nm);
  } else {
    let pm = month - 1, py = year; if (pm < 0){ pm = 11; py--; }
    currentPayDate = getPayDate(py, pm);
    nextPayDate = thisMonthPay;
  }
  for (let i = 0; i < offset; i++){
    const nm = nextPayDate.getMonth() + 1, ny = nextPayDate.getFullYear();
    currentPayDate = nextPayDate;
    nextPayDate = getPayDate(nm > 11 ? ny + 1 : ny, nm > 11 ? 0 : nm);
  }
  for (let i = 0; i < -offset; i++){
    const pm = currentPayDate.getMonth() - 1, py = currentPayDate.getFullYear();
    nextPayDate = currentPayDate;
    currentPayDate = getPayDate(pm < 0 ? py - 1 : py, pm < 0 ? 11 : pm);
  }
  return { start: currentPayDate, end: addDays(nextPayDate, -1) };
}

// 2026-10-06 (transport-estimates-spec.md + tracker addendum) — the "Set
// aside on payday" figure for the pay period `offset` periods from the one
// containing `today`, used by both the Home card and the Personal Finance
// publisher. Moved here unchanged from render(), lock rule included: a
// period is locked into paydayEstimateSnapshots the first time it's worked
// out on or after its own start date (its payday) — whichever caller gets
// there first. Future periods are never locked. `today` must be the same
// local-midnight date render() uses (from state.today).
//
// `states` is optional: a computeStates() map reaching at least this
// period's end. The publisher passes one map for all 13 periods instead of
// rebuilding it each time; buy flags for a window don't depend on how far
// past it the map reaches.
//
// Returns { start, end, ticketCount, ticketCost, parkingDays, parkingCost,
// total, locked } — costs in pounds, exactly as the card has always shown.
function estimateForPeriod(today, offset, states){
  const period = getPayPeriodByOffset(today, offset);
  const startKey = fmtKey(period.start);
  const snap = paydayEstimateSnapshots[startKey];
  if (snap){
    // Already locked in for this period — use exactly what was budgeted
    // on payday, not a fresh recalculation. A ticket purchase logged
    // partway through the period, or a day re-tagged since, would
    // otherwise change a projected figure into a different number — the
    // whole point of a payday budget is that it doesn't retroactively
    // move once the money's already been set aside.
    return {
      start: period.start, end: period.end,
      ticketCount: snap.ticketCount, ticketCost: snap.ticketCost,
      parkingDays: snap.parkingDays, parkingCost: snap.parkingCost,
      total: snap.total, locked: true
    };
  }
  const dayStates = states || computeStates(period.end);
  let ticketCount = 0;
  let parkingDays = 0;
  for (let d = new Date(period.start); d <= period.end; d = addDays(d, 1)){
    const key = fmtKey(d);
    if (dayStates[key] && dayStates[key].buyFlag) ticketCount++;
    const weekend = isWeekend(d);
    const comment = (comments[key] || '').trim();
    const isTravel = comment === '' || travelOverrides[key];
    if (!weekend && isTravel) parkingDays++;
  }
  const ticketCost = ticketCount * lastKnownPrice;
  const parkingCostTotal = parkingDays * parkingCost;
  const total = ticketCost + parkingCostTotal;

  // Locked the moment this period's own start date has genuinely been
  // reached — not before. A future period hasn't had its own payday yet,
  // so it stays a live, evolving projection until it actually arrives.
  let locked = false;
  if (fmtKey(today) >= startKey){
    paydayEstimateSnapshots[startKey] = {
      ticketCount, parkingDays,
      ticketCost, parkingCost: parkingCostTotal, total
    };
    savePaydayEstimateSnapshots();
    locked = true;
  }
  return {
    start: period.start, end: period.end,
    ticketCount, ticketCost, parkingDays, parkingCost: parkingCostTotal,
    total, locked
  };
}

// Generic "money saved versus a per-day budgeted expense, for days that
// have already happened" — built once, parameterized by which tracked
// days map and default cost to use, rather than written specifically
// for parking. A possible future second daily expense (bus fares,
// whatever) could reuse this directly with its own tracked-days map and
// default cost, rather than needing its own copy of the same logic.
// Deliberately only sums days up to and including today, not the whole
// period — a day that hasn't happened yet has no real outcome either
// way, so this stays a running total of what's actually occurred, never
// needing the same kind of "lock it in" fix the payday estimate needed.
function computeExpenseSavingsForPeriod(periodStart, periodEnd, todayDate, trackedDays, defaultCost){
  let total = 0;
  const cutoff = todayDate < periodEnd ? todayDate : periodEnd;
  for (let d = new Date(periodStart); d <= cutoff; d = addDays(d, 1)){
    const key = fmtKey(d);
    if (isWeekend(d)) continue;
    const comment = (comments[key] || '').trim();
    const isTravel = comment === '' || travelOverrides[key];
    if (!isTravel) continue; // this expense doesn't apply on a non-travel day
    total += (trackedDays[key] !== undefined) ? (defaultCost - trackedDays[key]) : defaultCost;
  }
  return total;
}

// Returns the locked budget-day set for a period, computing and locking
// it on the spot the first time it's needed after the period's own start
// date has genuinely been reached (mirrors paydayEstimateSnapshots'
// timing exactly). Returns null for a period that hasn't started yet —
// there's nothing to budget for the future. Once locked, always returns
// the same set regardless of later comment/override edits, which is the
// whole fix: a day re-tagged afterward (WFH, holiday, sickness) doesn't
// silently disappear from the period's parking budget.
function getOrLockParkingBudgetDays(periodStart, periodEnd, todayDate){
  const periodStartKey = fmtKey(periodStart);
  if (parkingBudgetDays[periodStartKey]) return parkingBudgetDays[periodStartKey];
  if (fmtKey(todayDate) < periodStartKey) return null;
  const set = [];
  for (let d = new Date(periodStart); d <= periodEnd; d = addDays(d, 1)){
    if (isWeekend(d)) continue;
    const key = fmtKey(d);
    const comment = (comments[key] || '').trim();
    const isTravel = comment === '' || travelOverrides[key];
    if (isTravel) set.push(key);
  }
  parkingBudgetDays[periodStartKey] = set;
  saveParkingBudgetDays();
  return set;
}

// Parking savings for a period, measured against its locked budget-day
// set rather than live day-by-day travel status. A budgeted day counts
// as fully saved unless it's actually been parked on (in which case only
// the difference against the default cost counts); a day parked on that
// ISN'T in the locked budget — an unplanned extra commute — is a
// straight loss against the total, since the budget never covered it.
function computeParkingSavingsForPeriod(periodStart, periodEnd, todayDate, budgetDayKeys, trackedDays, defaultCost){
  const budgetSet = new Set(budgetDayKeys || []);
  let total = 0;
  const cutoff = todayDate < periodEnd ? todayDate : periodEnd;
  for (let d = new Date(periodStart); d <= cutoff; d = addDays(d, 1)){
    if (isWeekend(d)) continue;
    const key = fmtKey(d);
    const parkedCost = trackedDays[key];
    if (budgetSet.has(key)){
      total += (parkedCost !== undefined) ? (defaultCost - parkedCost) : defaultCost;
    } else if (parkedCost !== undefined){
      total -= parkedCost;
    }
  }
  return total;
}

// Finds the next date flagged as a ticket-buy day, searching well beyond
// the visible day list so it's accurate regardless of scroll position.
function findNextBuyDateKey(today, todayKeyParam){
  const buySearchStates = computeStates(addDays(today, Math.max(MAX_DAYS_AHEAD, PERIOD_LENGTH)));
  let nextBuyKey = null;
  for (const key in buySearchStates){
    if (key >= todayKeyParam && buySearchStates[key].buyFlag){
      if (!nextBuyKey || key < nextBuyKey) nextBuyKey = key;
    }
  }
  return nextBuyKey;
}

// Computes the end of the *actual* current ticket period only — no
// chaining into imagined future cycles. This is the real boundary of what
// you've actually paid for; anything past it needs either a logged single
// ticket for that specific day, or a fresh season ticket purchase.
function getRealPeriodEnd(){
  let cursor = parseKey(periodStart);
  let usedCount = 0, daysElapsed = 0;
  while (true){
    const key = fmtKey(cursor);
    daysElapsed += 1;
    const weekend = isWeekend(cursor);
    const comment = (comments[key] || '').trim();
    const isTravel = comment === '' || travelOverrides[key];
    if (!weekend && isTravel) usedCount += 1;
    const hitUses = usedCount >= USES_PER_PERIOD;
    const hitDays = daysElapsed >= PERIOD_LENGTH;
    if (hitUses || hitDays){
      return { endDate: new Date(cursor), lostDays: hitDays && !hitUses, unusedRemaining: USES_PER_PERIOD - usedCount };
    }
    cursor = addDays(cursor, 1);
  }
}

// Shared, single source of truth for "is today in a genuine gap" — no
// active season ticket (the real 28-day/8-use window has ended) and
// nothing bought to replace it yet. Used both by render() for what the
// card displays and by the Google Calendar sync logic below, so the two
// can't quietly drift apart the way they did before this existed —
// render() checked this inline, syncing didn't check it at all.
function isCurrentlyInTicketGap(dateObj, dateKeyParam){
  const dayStates = computeStates(dateObj);
  if (!dayStates[dateKeyParam]) return false; // hasn't started counting at all yet — that's "before period", not a gap
  const realPeriodEnd = getRealPeriodEnd();
  return dateKeyParam > fmtKey(realPeriodEnd.endDate);
}

// Returns the single-ticket purchase record for an exact date, if any.
function getSingleTicketForDate(key){
  return purchases.find(p => p.date === key && p.type === 'single');
}

function computeStates(targetDate){
  const map = {};
  let segStart = parseKey(periodStart);
  if (fmtKey(segStart) > fmtKey(targetDate)) return map; // nothing to show yet

  while (fmtKey(segStart) <= fmtKey(targetDate)){
    let cursor = new Date(segStart);
    let usedCount = 0;
    let daysElapsed = 0;
    let periodEndDate = null;
    let finalLostDays = false;
    let finalUnusedRemaining = 0;

    while (true){
      const key = fmtKey(cursor);
      daysElapsed += 1;
      const weekend = isWeekend(cursor);
      const comment = (comments[key] || '').trim();
      const isTravel = comment === '' || travelOverrides[key];
      if (!weekend && isTravel){
        usedCount += 1;
      }
      const hitUses = usedCount >= USES_PER_PERIOD;
      const hitDays = daysElapsed >= PERIOD_LENGTH;
      const periodEnded = hitUses || hitDays;
      const lostDays = hitDays && !hitUses;

      if (fmtKey(cursor) <= fmtKey(targetDate)){
        map[key] = {
          usedCount, daysElapsed, periodEnded, lostDays,
          unusedRemaining: USES_PER_PERIOD - usedCount,
          inGap: false, buyFlag: false
        };
      }

      if (periodEnded){
        periodEndDate = new Date(cursor);
        finalLostDays = lostDays;
        finalUnusedRemaining = USES_PER_PERIOD - usedCount;
        break;
      }
      if (fmtKey(cursor) >= fmtKey(targetDate)){
        periodEndDate = null; // period still ongoing beyond our range — nothing more to compute
        break;
      }
      cursor = addDays(cursor, 1);
    }

    if (!periodEndDate) break;

    const nextTravel = findNextTravelDay(periodEndDate);
    const buyFlagDate = addDays(nextTravel, -1);

    // mark any days between the old period ending and the next ticket starting
    // as "gap" days — no active ticket needed
    let gcursor = addDays(periodEndDate, 1);
    while (fmtKey(gcursor) < fmtKey(nextTravel) && fmtKey(gcursor) <= fmtKey(targetDate)){
      const key = fmtKey(gcursor);
      map[key] = Object.assign({usedCount: 0, daysElapsed: 0, periodEnded: false, lostDays: false, unusedRemaining: 0}, map[key], {inGap: true});
      gcursor = addDays(gcursor, 1);
    }

    // flag the day before the next real travel day as the day to buy the ticket
    if (fmtKey(buyFlagDate) <= fmtKey(targetDate)){
      const bKey = fmtKey(buyFlagDate);
      map[bKey] = Object.assign({usedCount: 0, daysElapsed: 0, periodEnded: false, inGap: (fmtKey(buyFlagDate) > fmtKey(periodEndDate))}, map[bKey], {
        buyFlag: true,
        lostDays: finalLostDays,
        unusedRemaining: finalUnusedRemaining
      });
    }

    segStart = nextTravel;
  }
  return map;
}

// Recovers what a day's state WOULD have shown, for a date that falls
// before the current global periodStart — a genuine gap in the normal
// computeStates(), which only ever looks forward from periodStart.
// Without this, buying a new ticket instantly blanks every earlier day
// in the list down to a bare "Before this ticket" placeholder, even
// though those days genuinely belonged to a real previous ticket with
// real detail (confirmed trains, delay claims) worth still being able
// to see.
//
// Deliberately NOT just calling computeStates() with an earlier
// periodStart — that function auto-advances into a fresh 8-use cycle
// the moment one segment ends, which is exactly right for forward
// projections (the payday estimate assumes tickets keep getting bought
// on schedule) but wrong here: caught this producing "day 1 of 8" for
// a day that was actually sitting in a genuine unbought gap, simply
// because the calendar's next plausible travel day happened to land
// there — regardless of whether a ticket was ever really purchased for
// it. So this only ever walks the ONE real ticket's own segment plus
// its immediate gap afterward, and stops — never speculating about a
// second, unconfirmed cycle the way computeStates itself would.
function findHistoricalStateForDate(key){
  const seasonPurchases = purchases.filter(p => (p.type || undefined) !== 'single').sort((a, b) => a.date.localeCompare(b.date));
  const historicalPurchase = seasonPurchases.filter(p => p.date <= key).slice(-1)[0];
  if (!historicalPurchase) return null;

  let cursor = parseKey(historicalPurchase.date);
  let usedCount = 0, daysElapsed = 0, periodEndDate = null;
  while (true){
    const cKey = fmtKey(cursor);
    daysElapsed += 1;
    const weekend = isWeekend(cursor);
    const comment = (comments[cKey] || '').trim();
    const isTravel = comment === '' || travelOverrides[cKey];
    if (!weekend && isTravel) usedCount += 1;
    const hitUses = usedCount >= USES_PER_PERIOD;
    const hitDays = daysElapsed >= PERIOD_LENGTH;
    if (cKey === key){
      return { usedCount, daysElapsed, periodEnded: hitUses || hitDays, lostDays: hitDays && !hitUses, unusedRemaining: USES_PER_PERIOD - usedCount, inGap: false, buyFlag: false };
    }
    if (hitUses || hitDays){ periodEndDate = new Date(cursor); break; }
    cursor = addDays(cursor, 1);
  }
  // Reached the real ticket's own end without finding key yet — it's
  // somewhere in the gap that followed. No "buy ticket" flag applied
  // here even on what would have been that day — this is a look back
  // at a settled day, not a live reminder about the future.
  let gcursor = addDays(periodEndDate, 1);
  while (fmtKey(gcursor) <= key){
    if (fmtKey(gcursor) === key){
      return { usedCount: 0, daysElapsed: 0, periodEnded: false, lostDays: false, unusedRemaining: 0, inGap: true, buyFlag: false };
    }
    gcursor = addDays(gcursor, 1);
  }
  return null; // shouldn't happen given the !s guard already bounds key before periodStart
}

function getRange(centerDate, before, after){
  const days = [];
  for (let i=-before; i<=after; i++){
    days.push(addDays(centerDate, i));
  }
  return days;
}

function findNextHoliday(todayKey){
  let best = null;
  for (const key in comments){
    if (key <= todayKey) continue;
    if ((comments[key] || '').trim().toUpperCase() === 'HOLIDAY'){
      if (!best || key < best) best = key;
    }
  }
  return best;
}

// Counts working days strictly between `from` and `to` (both exclusive) —
// i.e. the days you actually still have to work through before `to` arrives.
// Weekends and dates tagged BANK HOLIDAY don't count; everything else
// (including WFH days) still counts as a working day.
function countWorkingDaysUntil(from, to){
  let count = 0;
  let d = addDays(from, 1);
  while (d < to){
    if (!isWeekend(d)){
      const key = fmtKey(d);
      const tag = (comments[key] || '').trim().toUpperCase();
      if (tag !== 'BANK HOLIDAY') count++;
    }
    d = addDays(d, 1);
  }
  return count;
}

// See holiday-countdown-time-aware-spec.md. Before this hour, "today"
// hasn't happened yet from a commute point of view, so it should still
// count as a day owed. From this hour on, today is spoken for — matching
// the plain countWorkingDaysUntil behaviour.
const HOLIDAY_COUNTDOWN_CUTOFF_HOUR = 9;
// Once the day-count would hit 0 on the actual last working day (past the
// cutoff above), the card switches from a day-count to an hour countdown
// to this clock time instead of showing a bare "0".
const HOLIDAY_COUNTDOWN_HOME_HOUR = 17;

// Same count as countWorkingDaysUntil, but optionally anchored one calendar
// day earlier so `today` itself is included in the result.
function holidayWorkingDaysCount(today, holidayDate, includeToday){
  const anchor = includeToday ? addDays(today, -1) : today;
  return countWorkingDaysUntil(anchor, holidayDate);
}

// Minutes-precision countdown to HOLIDAY_COUNTDOWN_HOME_HOUR:00 today.
function hoursUntilHomeTime(now){
  const home = londonWallClockOn(now, HOLIDAY_COUNTDOWN_HOME_HOUR, 0);
  const diffMs = Math.max(0, home - now);
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.round((diffMs % 3600000) / 60000);
  return { hours, minutes, isPastHomeTime: home <= now };
}

// Walks backward from `beforeDate` (exclusive) to the closest working day —
// skips weekends and BANK HOLIDAY-tagged dates. Used to find the real last
// working day before a holiday block starts.
function findLastWorkingDayBefore(beforeDate){
  let d = addDays(beforeDate, -1);
  while (isWeekend(d) || (comments[fmtKey(d)] || '').trim().toUpperCase() === 'BANK HOLIDAY'){
    d = addDays(d, -1);
  }
  return d;
}

// Walks forward from `holidayStart` while the HOLIDAY tag continues,
// returning the last contiguous day of that block.
function findHolidayBlockEnd(holidayStart){
  let d = holidayStart;
  while ((comments[fmtKey(addDays(d, 1))] || '').trim().toUpperCase() === 'HOLIDAY'){
    d = addDays(d, 1);
  }
  return d;
}

// Walks forward from `afterDate` (exclusive) to the next genuine working
// day — skips weekends, BANK HOLIDAY, and any further HOLIDAY tags (in case
// two holiday blocks sit close together). Used for the "back to work" date.
function findNextWorkingDayAfter(afterDate){
  let d = addDays(afterDate, 1);
  while (isWeekend(d) || ['BANK HOLIDAY', 'HOLIDAY'].includes((comments[fmtKey(d)] || '').trim().toUpperCase())){
    d = addDays(d, 1);
  }
  return d;
}

// Decides what the holiday card should show. Three modes:
//  - 'off'   — today is already within the holiday's calendar gap (the
//              stretch between your last working day finishing and the
//              block starting, e.g. the weekend before a Monday start) or
//              within the tagged block itself. Persists all the way
//              through to the day before you're back at work.
//  - 'hours' — today is genuinely the last working day, it's past
//              HOLIDAY_COUNTDOWN_CUTOFF_HOUR, and home time hasn't arrived yet.
//  - 'days'  — the default working-day count, for every day before that.
// `today` is the calendar-only date used elsewhere in render(); `now` is
// the live clock, used only for the hour-of-day checks here.
// See holiday-countdown-time-aware-spec.md.
function getHolidayCountdownState(today, now, holidayStart){
  const holidayEnd = findHolidayBlockEnd(holidayStart);
  const lastWorkingDay = findLastWorkingDayBefore(holidayStart);
  const backToWorkDay = findNextWorkingDayAfter(holidayEnd);

  if (today.getTime() > lastWorkingDay.getTime() && today.getTime() <= holidayEnd.getTime()){
    return { mode: 'off', backToWorkDay };
  }

  if (today.getTime() === lastWorkingDay.getTime()){
    const isBeforeCutoff = londonParts(now).hour < HOLIDAY_COUNTDOWN_CUTOFF_HOUR;
    if (isBeforeCutoff) return { mode: 'days', dayCount: 1 };
    const h = hoursUntilHomeTime(now);
    if (h.isPastHomeTime) return { mode: 'off', backToWorkDay };
    return { mode: 'hours', hours: h.hours, minutes: h.minutes };
  }

  const isBeforeCutoff = londonParts(now).hour < HOLIDAY_COUNTDOWN_CUTOFF_HOUR;
  const dayCount = holidayWorkingDaysCount(today, holidayStart, isBeforeCutoff);
  return { mode: 'days', dayCount };
}

// True when the projection behind the main list's Buy Ticket line puts a
// ticket purchase on this day. Today onwards only, matching the calendar dot.
function isBuyTicketDay(key, todayKey){
  if (key < todayKey) return false;
  const st = computeStates(parseKey(key));
  return !!(st[key] && st[key].buyFlag);
}
