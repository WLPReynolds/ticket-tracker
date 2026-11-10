// delay-repay.js — Delay Repay bands and amounts, claim state, getDelayStatus, HSP sync, reason codes.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.
// The exact wording Avanti's own claim form uses for its delay bands —
// reuses the same boundaries as the payout calculation itself, so the
// two can never quietly drift out of sync with each other.
function delayRepayBandLabel(minutes){
  if (minutes >= 120) return '120+ min';
  if (minutes >= 60) return '60-119 min';
  if (minutes >= 30) return '30-59 min';
  if (minutes >= 15) return '15-29 min';
  return `${minutes} min`; // claims are only ever created at/above the 15-min threshold — this is just a safe fallback, not expected in practice
}
// 2026-09-30: the claim notification and claim-details file describe what's
// being claimed right now — a direction marked Not claiming, or one that
// expired, isn't part of that and would just confuse the form-filling.
function isClaimBeingMade(claim){
  return !!claim && claim.status !== 'declined' && claim.status !== 'expired';
}
// 2026-10-27: the minutes a claim's band is based on. Normally the HSP
// delay; for a cancelled train it's the band picked by hand (bandMinutes:
// 15 / 30 / 60), since minutesLate stays null to record the cancellation.
function claimBandMinutes(claim){
  if (!claim) return null;
  if (typeof claim.bandMinutes === 'number') return claim.bandMinutes;
  return claim.minutesLate;
}

// 2026-10-31: 120+ band added. Avanti paid £19.20 (two singles = a full
// return) for 120+ cancellations on 2025-11-19 and 2026-02-18, and £16.80 for
// the 17:31 on 2026-10-26 — which only fits if the day's total is capped at
// one return: £19.20 minus the £2.40 already paid for that morning's 08:08.
// So 120+ = 200% of a single, and a day's AM+PM total never exceeds 200%
// (see delayRepayDayCapAmount). The cap is inferred from that one claim.
function delayRepayBandPercent(minutes){
  if (minutes >= 120) return 2.0;
  if (minutes >= 60) return 1.0;
  if (minutes >= 30) return 0.5;
  if (minutes >= 15) return 0.25;
  return 0;
}

// Finds the season ticket price that was actually valid on a given past
// date, rather than just using whatever the current price is — so a later
// price change doesn't retroactively distort an older claim's value.
function getSeasonPriceForDate(dateKey){
  const seasonPurchases = purchases.filter(p => (p.type || undefined) !== 'single' && p.date <= dateKey);
  if (seasonPurchases.length === 0) return lastKnownPrice;
  seasonPurchases.sort((a, b) => a.date < b.date ? -1 : 1);
  return seasonPurchases[seasonPurchases.length - 1].cost;
}

function computeDelayRepayAmount(minutes, dateKey){
  const price = getSeasonPriceForDate(dateKey);
  return (price / DELAY_REPAY_DIVISOR) * delayRepayBandPercent(minutes);
}

// 2026-10-31: most Avanti will pay for one day's travel, AM + PM combined —
// one return, i.e. two singles. See delayRepayBandPercent.
function delayRepayDayCapAmount(dateKey){
  return (getSeasonPriceForDate(dateKey) / DELAY_REPAY_DIVISOR) * 2;
}

// The amount already counted against the day for the OTHER direction: its
// claim record's amount (unless declined/expired, which pay nothing). With no
// record yet, only a pending MORNING claim is counted — the morning takes its
// full amount and the evening absorbs the cap, as Avanti did on 2026-10-26.
// (Otherwise two unrecorded directions would each cap against the other.)
// A cancelled direction with no band chosen yet counts as nothing.
function delayRepayOtherDirAmount(dateKey, dir){
  const other = dir === 'AM' ? 'PM' : 'AM';
  const claim = (delayClaims[dateKey] || {})[other];
  if (claim) return isClaimBeingMade(claim) || claim.status === 'confirmed' ? (claim.amount || 0) : 0;
  if (other !== 'AM') return 0;
  const o = delayRepayOpportunities(dateKey).find(x => x.dir === other);
  if (!o || o.cancelled) return 0;
  return computeDelayRepayAmount(o.minutesLate, dateKey);
}

// A direction's amount after the day cap, given what the other direction
// already takes up. Never negative.
function cappedDelayRepayAmount(minutes, dateKey, dir){
  const raw = computeDelayRepayAmount(minutes, dateKey);
  const room = delayRepayDayCapAmount(dateKey) - delayRepayOtherDirAmount(dateKey, dir);
  return Math.max(0, Math.min(raw, room));
}

// Runs on every app open. Fetches official UK bank holiday dates and fills
// them in as "BANK HOLIDAY" on any date that doesn't already have a comment.
// Never overwrites an existing entry. If offline, falls back to the last
// successful fetch (cached locally) so nothing breaks without a connection.
// Returns true if a date is one where a delay repay claim could plausibly
// apply: an actual past weekday travel day (not a weekend, not tagged
// WFH/HOLIDAY/etc unless overridden, and strictly before today).
function isEligibleRailDay(d, todayKeyParam){
  const key = fmtKey(d);
  if (key >= todayKeyParam) return false; // only completed past journeys
  if (isWeekend(d)) return false;
  const comment = (comments[key] || '').trim();
  return comment === '' || !!travelOverrides[key];
}

// 2026-10-27: true when an HSP record counts as a Delay Repay breach —
// 15+ minutes late, OR cancelled. A cancelled record has delayMinutes
// null, which every `delayMinutes >= 15` check silently treated as "not
// late", so a cancelled confirmed train showed "On time" on the day sheet
// and was never offered as a claim (17:31 on 20 Oct and 26 Oct).
function perfIsCancelled(perf){
  return !!(perf && perf.cancelled);
}
function perfBreachesThreshold(perf){
  return !!perf && (perfIsCancelled(perf) || perf.delayMinutes >= DELAY_REPAY_THRESHOLD_MINUTES);
}

// Returns 'confirmed' if a specific confirmed train for this date is
// known to have breached the delay threshold — a near-certain claim.
// Returns 'maybe' if no confirmation exists but at least one configured
// train that day did breach it — the existing general indicator.
// Returns 'declined' (2026-09-30) when the only confirmed breaches that day
// were marked "Not claiming" — shown as a grey blob/dot. A real claim on
// the other direction still wins and keeps the day red.
// Returns null if there's nothing to flag, including when every
// confirmed train for the day is known to have been on time (a
// confirmation should rule the day out, not just add to the guesswork).
function getDelayStatus(dateKey){
  const dayPerf = railPerfCache[dateKey];
  if (!dayPerf) return null;
  const confirmed = confirmedTrains[dateKey] || {};
  const dayClaims = delayClaims[dateKey] || {};
  let anyConfirmedDelay = false;
  let anyDeclinedDelay = false;
  let anyUnconfirmedDirection = false;

  ['AM', 'PM'].forEach(direction => {
    const dirTrains = railTrains.filter(t => t.direction === direction);
    if (dirTrains.length === 0) return;
    const confirmedKey = confirmed[direction];
    if (confirmedKey !== undefined){
      if (confirmedKey === '') return; // explicitly didn't travel that leg — ignore
      const perf = dayPerf[confirmedKey];
      if (perfBreachesThreshold(perf)){
        if (dayClaims[direction] && dayClaims[direction].status === 'declined') anyDeclinedDelay = true;
        else anyConfirmedDelay = true;
      }
    } else {
      anyUnconfirmedDirection = true;
    }
  });

  if (anyConfirmedDelay) return 'confirmed';
  const anyDelayAtAll = railTrains.some(t => perfBreachesThreshold(dayPerf[t.key]));
  if (anyUnconfirmedDirection && anyDelayAtAll) return 'maybe';
  if (anyDeclinedDelay) return 'declined';
  return null;
}

// ---------------------------------------------------------------------
// Delay repay claim window helpers (2026-09-30,
// claude/delay-repay-badge-rework-spec.md). Shared by render()'s expiry
// sweep and header badge, the day-detail views' Not claiming buttons, and
// the claims manager, so they can never disagree about what's claimable.
// ---------------------------------------------------------------------
const DELAY_REPAY_WINDOW_DAYS = 28; // Avanti: 28 days from date of travel
// Unclaimed delays only get auto-expired from this date onwards. Without a
// floor, the first run would stamp every unclaimed delay in the whole
// performance history (back to 2025) as Expired at once — those predate
// this feature and were never tracked here. 28 days before the build date.
const DELAY_REPAY_UNCLAIMED_EXPIRY_FROM = '2026-09-02';

// 2026-10-01: Avanti's claim-received email says they'll respond within 20
// days of the claim being made. A submitted claim (AWC reference entered,
// not yet ticked Confirmed/paid) shows "Awaiting payment" counting down from
// submittedAt, then "Chase Avanti" once this many days have passed.
const DELAY_REPAY_RESPONSE_DAYS = 20;
// submittedAt is only recorded from this build onwards. A submitted claim
// without one (the 30 Sept claim, submitted 1 Oct) is backfilled with this.
const DELAY_REPAY_SUBMITTED_BACKFILL = '2026-10-01';

// Whole calendar days from a travel date to `today` (both local midnights).
// Math.round, not floor: across a BST/GMT change the gap is 23h or 25h,
// and floor would lose a day on the 23h side.
function delayRepayDaysSince(dateKey, today){
  return Math.round((today - parseKey(dateKey)) / 86400000);
}

// The directions on a date whose CONFIRMED train breached the delay
// threshold — each one a claim opportunity, whatever its claim status.
// [{ dir, trainKey, minutesLate, cancelled, claim }] — claim is the
// delayClaims record or null. 2026-10-27: cancelled trains are included,
// with minutesLate null and cancelled true. The app can't know the real
// delay (it depends on whatever was caught instead), so their amount is
// unknown until a band is picked when the claim is started.
function delayRepayOpportunities(dateKey){
  const dayPerf = railPerfCache[dateKey];
  if (!dayPerf) return [];
  const confirmed = confirmedTrains[dateKey] || {};
  const dayClaims = delayClaims[dateKey] || {};
  const out = [];
  ['AM', 'PM'].forEach(dir => {
    const trainKey = confirmed[dir];
    if (!trainKey) return; // unconfirmed, or '' = didn't travel
    const perf = dayPerf[trainKey];
    if (!perfBreachesThreshold(perf)) return;
    const cancelled = perfIsCancelled(perf);
    out.push({ dir, trainKey, minutesLate: cancelled ? null : perf.delayMinutes, cancelled, claim: dayClaims[dir] || null });
  });
  return out;
}

// True if this direction has a claimable delay with nothing recorded yet —
// exactly when the day-detail views show the red claim pill and the Not
// claiming button.
function isDirectionClaimable(dateKey, dir){
  return delayRepayOpportunities(dateKey).some(o => o.dir === dir && !o.claim);
}

// Directions with no confirmed train where one of that direction's usual
// trains breached the threshold — the "Confirm train" badge. Per direction,
// so a late 07:27 doesn't prompt for an unconfirmed evening.
function delayRepayUnconfirmedDirections(dateKey){
  const dayPerf = railPerfCache[dateKey];
  if (!dayPerf) return [];
  const confirmed = confirmedTrains[dateKey] || {};
  return ['AM', 'PM'].filter(dir => {
    if (confirmed[dir] !== undefined) return false;
    return railTrains.some(t => t.direction === dir && perfBreachesThreshold(dayPerf[t.key]));
  });
}

// True if HSP has never been asked about this date for one or more of
// the given trains — not whether railPerfCache has data for it, since
// "asked and got nothing back" (service didn't run, no HSP record) is a
// perfectly valid outcome that shouldn't be retried forever.
// Shared fetch loop used by both railSyncMissingDates (travel days only,
// for the delay-repay claims flow) and railSyncFullHistory (every
// weekday, for the Performance history page). Takes neededByTrain —
// { trainKey: [dates] } — rather than one date list shared across every
// train, and narrows each train's own list independently as rounds
// complete, so a retry only ever asks about the specific (train, date)
// gaps still outstanding. Sharing one list across all trains would mean
// a train that already had a complete answer gets needlessly resent (and
// reprocessed server-side, burning its subrequest budget) on every round
// just because some OTHER train in the batch still had gaps — starving
// whichever trains happen to sort last in the list, worse the longer the
// date range. Mutates neededByTrain in place; updates railPerfCache and
// railSyncedDays with whatever the Worker resolved, marking exactly
// which (date, train) pairs it actually answered — genuinely checked,
// whether or not it found anything — so a genuine gap doesn't get
// re-queried indefinitely.
async function railSyncDatesBatch(neededByTrain, trains){
  let guard = 0;
  while (guard < 8){
    guard++;
    const requestPayload = trains
      .map(t => ({ key: t.key, fromLoc: t.fromLoc, toLoc: t.toLoc, time: t.time, dates: neededByTrain[t.key] || [] }))
      .filter(r => r.dates.length > 0);
    if (requestPayload.length === 0) break;

    let response;
    try{
      const resp = await fetch(RAIL_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: requestPayload })
      });
      if (!resp.ok) break;
      response = await resp.json();
    }catch(e){ break; }

    const trainResults = response.trainResults || {};
    for (const trainKey in trainResults){
      for (const date in trainResults[trainKey]){
        if (!railPerfCache[date]) railPerfCache[date] = {};
        railPerfCache[date][trainKey] = trainResults[trainKey][date];
      }
    }

    const attemptedDates = response.attemptedDates || {};
    let anyProgress = false;
    // 2026-09-30: HSP only publishes a day's record some hours after the
    // train ran, and the proxy reports "no service found" as a definitive
    // answer. Asked too early (e.g. first app open just after midnight),
    // yesterday's delayed train would be marked synced-with-nothing and
    // never asked about again — no blob, no claim. So an empty answer for
    // the last few days isn't recorded as final: it's dropped from this
    // round, and asked again on the next sync until a real result arrives.
    const recentCutoffKey = fmtKey(addDays(new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate()), -RAIL_RECENT_RETRY_DAYS));
    for (const trainKey in neededByTrain){
      const attempted = new Set(attemptedDates[trainKey] || []);
      if (attempted.size > 0) anyProgress = true;
      neededByTrain[trainKey] = (neededByTrain[trainKey] || []).filter(d => !attempted.has(d));
      for (const d of attempted){
        const gotResult = !!(railPerfCache[d] && railPerfCache[d][trainKey]);
        if (!gotResult && d >= recentCutoffKey) continue; // not final yet — see above
        const already = railSyncedDays[d] || [];
        if (!already.includes(trainKey)) railSyncedDays[d] = [...already, trainKey];
      }
    }

    await saveRailPerfCache();
    await saveRailSyncedDays();
    render();

    const remainingTotal = Object.values(neededByTrain).reduce((sum, arr) => sum + arr.length, 0);
    if (remainingTotal === 0 || !anyProgress) break; // done, or no progress — stop rather than loop forever
  }
}

// Checks the past-day window for any eligible travel days that don't yet
// have performance data cached, and fetches just those from the Worker.
// Stays scoped to actual travel days (isEligibleRailDay) since this feeds
// the delay-repay claims flow, where a day you didn't travel is simply
// irrelevant. For the broader "how punctual is this train generally"
// picture, see railSyncFullHistory below.
// 2026-09-30: always covers the full 28-day claim window, not just the
// rows the day list currently shows — the header badge (Claim available /
// Confirm train) and the unclaimed-expiry sweep look across all 28 days.
// railDaysBack still controls only what the list displays.
async function railSyncMissingDates(){
  if (railSyncInProgress) return;
  if (!railTrains || railTrains.length === 0) return;
  if (RAIL_WORKER_URL.includes('YOUR-WORKER-NAME')) return; // not configured yet

  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const todayKeyLocal = fmtKey(today);
  const oldestVisible = addDays(today, -Math.max(railDaysBack, RAIL_MAX_DAYS_BACK));

  const neededByTrain = {};
  for (const t of railTrains) neededByTrain[t.key] = [];
  for (let d = new Date(oldestVisible); d < today; d = addDays(d, 1)){
    if (!isEligibleRailDay(d, todayKeyLocal)) continue;
    const key = fmtKey(d);
    const synced = railSyncedDays[key] || [];
    for (const t of railTrains){
      if (!synced.includes(t.key)) neededByTrain[t.key].push(key);
    }
  }
  const totalNeeded = Object.values(neededByTrain).reduce((sum, arr) => sum + arr.length, 0);
  if (totalNeeded === 0) return;

  railSyncInProgress = true;
  try{ await railSyncDatesBatch(neededByTrain, railTrains); }
  finally{ railSyncInProgress = false; }
}

// Backfills performance data for every weekday in the window,
// regardless of whether it was a day you actually travelled — unlike
// railSyncMissingDates above. This is what gives the Performance history
// page (and its averages) the full picture of how the trains actually
// run, not just the subset of days you happened to be on them. Safe to
// call often: dates already covered for every currently-configured
// train are skipped, so a repeat call is cheap — though the very first
// call after a usual train is added or changed will genuinely re-check
// the whole window for that train, which is the point (a newly added
// train should get its own backfilled history too).
async function railSyncFullHistory(){
  if (railSyncInProgress) return;
  if (!railTrains || railTrains.length === 0) return;
  if (RAIL_WORKER_URL.includes('YOUR-WORKER-NAME')) return;

  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const oldest = addDays(today, -railHistoryDaysBack);

  const neededByTrain = {};
  for (const t of railTrains) neededByTrain[t.key] = [];
  for (let d = new Date(oldest); d < today; d = addDays(d, 1)){
    if (isWeekend(d)) continue;
    const key = fmtKey(d);
    const synced = railSyncedDays[key] || [];
    for (const t of railTrains){
      if (!synced.includes(t.key)) neededByTrain[t.key].push(key);
    }
  }
  const totalNeeded = Object.values(neededByTrain).reduce((sum, arr) => sum + arr.length, 0);
  if (totalNeeded === 0) return;

  railSyncInProgress = true;
  try{ await railSyncDatesBatch(neededByTrain, railTrains); }
  finally{ railSyncInProgress = false; }
}

// Fetches and caches the reason-code → English text table (see
// darwin-live-worker.js's /reason-codes route) if the local copy is
// missing or older than REASON_CODES_MAX_AGE_MS. Safe to call often —
// it's a no-op whenever the cache is already fresh. Never throws; a
// failed fetch just leaves whatever was already cached (possibly
// nothing) in place, since a bare numeric code is still shown as a
// fallback rather than the toast being blocked entirely.
async function ensureReasonCodes(){
  const age = Date.now() - (reasonCodesCache.fetchedAt || 0);
  if (age < REASON_CODES_MAX_AGE_MS && Object.keys(reasonCodesCache.codes).length > 0) return;
  try{
    const resp = await fetch(`${DARWIN_WORKER_URL}/reason-codes`);
    if (!resp.ok){
      console.error(`reason-codes fetch failed: HTTP ${resp.status}`, await resp.text().catch(() => ''));
      return;
    }
    const list = await resp.json();
    if (!Array.isArray(list)){
      console.error('reason-codes response was not an array:', list);
      return;
    }
    const codes = {};
    for (const entry of list){
      if (entry && entry.code !== undefined && entry.code !== null){
        codes[String(entry.code)] = { late: entry.lateReason || null, canc: entry.cancReason || null };
      }
    }
    reasonCodesCache = { fetchedAt: Date.now(), codes };
    await saveReasonCodesCache();
  }catch(e){
    console.error('reason-codes fetch threw:', e);
    // Offline or the worker's unreachable — whatever was already cached
    // (even if that's nothing) is left as-is; nothing to surface here.
  }
}

// Looks up a raw reason code (as stored in railPerfCache[date][key].reason)
// against the cached table, returning the right text for whether the
// service was delayed or cancelled. Falls back to a plain "reason code
// N" string if the table hasn't loaded that code yet, rather than
// showing nothing at all.
function describeReasonCode(code, isCancelled){
  if (code === null || code === undefined || code === '') return null;
  const entry = reasonCodesCache.codes[String(code)];
  const text = entry ? (isCancelled ? entry.canc : entry.late) : null;
  return text || `Reason code ${code} — description not loaded yet`;
}
