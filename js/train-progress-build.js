// train-progress-build.js — buildTrainProgress.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

const TRAIN_PROGRESS_ROW_HEIGHT = 54; // px — a sensible minimum row height; actual positioning now measures real rendered rows, not this value

function buildTrainProgress(train, service, showRawDebug, showAllReasons, boardOverrides, staffPlatformOverrides, staffLiveStatusOverrides, staffDataAge, staffOverrunLatch){
  const now = new Date();
  boardOverrides = boardOverrides || {};
  staffPlatformOverrides = staffPlatformOverrides || {};
  staffLiveStatusOverrides = staffLiveStatusOverrides || {};
  staffDataAge = staffDataAge || null;
  staffOverrunLatch = staffOverrunLatch || null;

  // Applied to any point (before/here/after) whose crs has a fresher
  // result from a stationBoardForService lookup — that's the whole
  // reason that lookup exists (the combined board used for `service`
  // here can sit on a stale/blank platform or estimate-only time long
  // after the pure dep/arr board already has the confirmed one), but
  // until this merge existed, that fetched data only ever reached the
  // debug panel and the notification check, never the row someone's
  // actually looking at. Only overrides fields the override actually
  // has an answer for — never blanks out perfectly good combined-board
  // data with an absence.
  function mergeBoardOverride(point){
    const ov = point.crs && boardOverrides[point.crs];
    if (!ov || !ov.data) return point;
    const d = ov.data;
    const isDeparture = ov.boardType === 'dep';
    const confirmedTime = isDeparture ? d.atd : d.ata;
    return {
      ...point,
      platform: d.platform || point.platform,
      liveTime: confirmedTime || point.liveTime,
      hasConfirmedActual: point.hasConfirmedActual || !!confirmedTime,
      isCancelled: point.isCancelled || !!d.isCancelled,
      reason: point.reason || d.delayReason || d.cancelReason || null,
    };
  }

  function pointsFrom(arr){
    return (arr && arr[0] && arr[0].callingPoint) ? arr[0].callingPoint : [];
  }
  const before = pointsFrom(service.previousCallingPoints).map(cp => mergeBoardOverride({
    locationName: cp.locationName,
    schedTime: cp.st,
    liveTime: cp.at || cp.et || cp.st,
    isCancelled: !!cp.isCancelled,
    reason: cp.delayReason || cp.cancelReason || null,
    platform: cp.platform || null,
    crs: cp.crs || null,
    hasConfirmedActual: !!cp.at,
    raw: { st: cp.st, at: cp.at, et: cp.et },
  }));
  // Whichever side of this station is actually relevant to the wider
  // journey — departure if the service carries on from here (the usual
  // case for a station you're tracking from), arrival if this is
  // actually the far end of the service you searched for (the "?"
  // origin case fixed earlier, where the searched station turns out to
  // be someone's destination, not their origin). Checked the same way
  // as everywhere else: real confirmed time first (atd/ata), estimate
  // second, schedule last — this station previously only ever checked
  // the estimate, so a point that had already been genuinely confirmed
  // could still show as unconfirmed if Darwin stopped repeating the
  // estimate once the real time was known (a common Darwin pattern).
  // (A side-by-side arrival+departure display was tried here briefly,
  // but reverted — Darwin only ever gives one time per ordinary calling
  // point, departure-only or arrival-only depending on position, so
  // showing both would only ever be possible for this one row and
  // nowhere else in the list, which read as inconsistent rather than
  // useful. This single governing status remains correctly atd/ata-
  // aware either way.)
  const departsHere = !!(service.std || service.etd || service.atd);
  const hereSchedTime = departsHere ? service.std : service.sta;
  const hereLiveTime = departsHere ? (service.atd || service.etd || service.std) : (service.ata || service.eta || service.sta);
  const here = [mergeBoardOverride({
    locationName: (STATION_COORDS[train.fromLoc] && STATION_COORDS[train.fromLoc].name) || stationNameForCrs(train.fromLoc) || train.fromLoc,
    schedTime: hereSchedTime,
    liveTime: hereLiveTime,
    isCancelled: !!service.isCancelled,
    reason: service.delayReason || service.cancelReason || null,
    isYourStation: true,
    platform: service.platform || null,
    crs: train.fromLoc || null,
    hasConfirmedActual: !!(departsHere ? service.atd : service.ata),
    raw: { std: service.std, sta: service.sta, etd: service.etd, eta: service.eta, atd: service.atd, ata: service.ata },
  })];
  const after = pointsFrom(service.subsequentCallingPoints).map(cp => mergeBoardOverride({
    locationName: cp.locationName,
    schedTime: cp.st,
    // Darwin's before/after split is fixed relative to the station you
    // queried from, not to real time — a point can sit in "subsequent"
    // and still be genuinely already passed once enough time's gone by,
    // so check for a real confirmed actual time first, same as "before".
    liveTime: cp.at || cp.et || cp.st,
    isCancelled: !!cp.isCancelled,
    reason: cp.delayReason || cp.cancelReason || null,
    platform: cp.platform || null,
    crs: cp.crs || null,
    hasConfirmedActual: !!cp.at,
    raw: { st: cp.st, at: cp.at, et: cp.et },
  }));
  let points = [...before, ...here, ...after];
  // Fills in platform ONLY where nothing already supplied one — never
  // overrides a platform GetServiceDetails or the existing fromLoc/
  // toLoc board-override already gave. Deliberately fallback-only, not
  // "Staff always wins": tonight's goal is populating the gaps every
  // other intermediate point has today, not re-litigating which source
  // is more current for the two stations that already have one. See
  // staffPlatformOverrides above for why this is a separate, narrower
  // mechanism rather than reusing boardOverrides' own merge.
  points = points.map(p => (
    p.platform || !p.crs || !staffPlatformOverrides[p.crs]
      ? p
      : { ...p, platform: staffPlatformOverrides[p.crs] }
  ));
  // Backlog #7 (closed 2026-08-26): GetServiceDetails can flatten a
  // genuinely-known specific delay down to the literal string "On
  // time" — confirmed via a real side-by-side comparison (Crewe showed
  // "On time" here while Staff's own atd/lateness said 60 seconds
  // late). Corrects it using Staff's own confirmed atd (for an
  // ordinary calling point — Darwin's calling-point time convention is
  // departure) or ata (for the final point, which only ever arrives in
  // this app's journey view — same isFinalPoint distinction the AT
  // PLATFORM logic below uses). Deliberately narrow, matching that
  // same "fallback only" discipline: only steps in for the *exact*
  // literal "On time" case, and only when Staff's own value for the
  // relevant field is genuinely confirmed (ataSpecified/atdSpecified),
  // never an unconfirmed forecast — this is closing one specific known
  // flattening bug, not a general "prefer Staff" policy. Setting
  // hasConfirmedActual here is deliberate too: the train genuinely did
  // depart/arrive, so treating this point as reached is objectively
  // correct — if anything an improvement to lastPassedIdx's walkback,
  // not a risk to it.
  //
  // Bug fixed same day it shipped (2026-08-26): truncating to "HH:MM"
  // can make a genuinely-confirmed under-a-minute delay (Warrington
  // Bank Quay, 56 seconds late — real atd 08:26:56, schedule 08:26)
  // round down to exactly the scheduled minute. describePointStatus's
  // own first check treats an exact schedTime/liveTime string match as
  // "no real data, just fell back to schedule" (confirmed: false) —
  // right assumption normally, wrong here, since this genuinely is
  // confirmed, just not by a whole minute. That false triggered the
  // separate "~X min late (estimated)" inference display, undoing the
  // fix for anything under a minute late — Crewe's own 61-second delay
  // happened to cross a minute boundary, which is why it worked while
  // this didn't. Fix: when the precise value rounds to the same minute
  // as schedule, use the literal string 'On time' instead of the bare
  // HH:MM — describePointStatus already treats that exact string as
  // "confirmed, genuinely on time" (a different, later branch than the
  // ambiguous fallback case), which is the correct thing to say here
  // and needs no change to describePointStatus itself.
  points = points.map((p, i, arr) => {
    if (p.liveTime !== 'On time' || !p.crs) return p;
    const status = staffLiveStatusOverrides[p.crs];
    if (!status) return p;
    const isFinalPointRow = i === arr.length - 1;
    // 2026-10-07: measured like-for-like against Staff's OWN schedule for
    // the same event (atd vs std, or ata vs sta for the final point), not
    // against Darwin's st — which after your boarding station is the
    // scheduled arrival, so an actual departure compared with it counted
    // the scheduled dwell as delay (Warrington 17:41/17:42, Crewe
    // 18:00/18:04, both reading late on 2026-10-07 for an on-time train).
    // The result is then expressed against Darwin's st (shiftClockTime),
    // so the row and describePointStatus report the true minutes without
    // anything else that reads schedTime having to change. No Staff
    // schedule for that event -> left as Darwin's "On time".
    const lateMin = isFinalPointRow
      ? (status.ataSpecified ? staffMinutesDiff(status.ata, status.sta) : null)
      : (status.atdSpecified ? staffMinutesDiff(status.atd, status.std) : null);
    if (lateMin === null) return p;
    // Only ever moves Darwin's "On time" LATER, never earlier, for an
    // ordinary calling point (2026-09-29, Lancaster): this correction
    // exists to surface hidden lateness only. The destination (final
    // point) keeps its early arrival: that one is genuine.
    const correctedLiveTime = (lateMin === 0 || (!isFinalPointRow && lateMin < 0))
      ? 'On time'
      : shiftClockTime(p.schedTime, lateMin);
    if (!correctedLiveTime) return p;
    return { ...p, liveTime: correctedLiveTime, hasConfirmedActual: true };
  });
  // Early ARRIVAL mistaken for an early DEPARTURE (2026-09-29, found live
  // at Warrington Bank Quay): a calling point's st is its scheduled
  // departure, but while the train is still standing there Darwin's `at`
  // holds the actual ARRIVAL time (st=08:26, at=08:24). Compared
  // directly, that read as "2 min early" on the row and "Running 2 min
  // early" in the summary, for a train that then left on time.
  // Only ever touches a point whose live time is EARLIER than schedule,
  // and never the final point (an early arrival there is real and is
  // exactly what that row reports) or your own boarding station (its
  // time is the board's departure-specific atd/etd). For those points:
  //   - Staff has a confirmed departure (atd) -> use that instead;
  //   - otherwise -> 'On time'. A passenger train doesn't leave a public
  //     stop ahead of time, so the early figure is the arrival, and the
  //     departure is still due at schedule. If it then leaves late, the
  //     NOT YET DEPARTED / "X min late" handling takes over as usual.
  // hasConfirmedActual is deliberately left as it was: the train really
  // has reached this point, so lastPassedIdx's walkback is unchanged.
  points = points.map((p, i, arr) => {
    if (p.isYourStation || i === arr.length - 1) return p;
    if (!p.liveTime || !p.liveTime.includes(':') || !p.schedTime || !p.schedTime.includes(':')) return p;
    let diff = (parseInt(p.liveTime.slice(0,2),10)*60 + parseInt(p.liveTime.slice(3,5),10))
             - (parseInt(p.schedTime.slice(0,2),10)*60 + parseInt(p.schedTime.slice(3,5),10));
    if (diff > 720) diff -= 1440; else if (diff < -720) diff += 1440; // midnight wrap, same as describePointStatus
    if (diff >= 0) return p;
    const status = p.crs ? staffLiveStatusOverrides[p.crs] : null;
    // 2026-10-07: Staff's departure measured against Staff's own std, not
    // Darwin's st (the scheduled arrival here) — see staffMinutesDiff.
    // Found live at Crewe: arrived 17:57 (sta 18:00), left 18:04:26
    // (std 18:04), shown as "18:04 · 4 min late"; now On time.
    const lateMin = (status && status.atdSpecified) ? staffMinutesDiff(status.atd, status.std) : null;
    if (lateMin !== null){
      // Same rule as the correction above: never early, only ever late.
      const liveTime = lateMin <= 0 ? 'On time' : shiftClockTime(p.schedTime, lateMin);
      if (liveTime) return { ...p, liveTime, hasConfirmedActual: true };
    }
    return { ...p, liveTime: 'On time' };
  });
  // Darwin attaches one reason to a service and doesn't seem to clear or
  // refresh it as the journey continues — a reason first seen on an
  // early cancelled point can still be sitting there hours and hundreds
  // of miles later, long after it's stopped being the genuine cause of
  // anything current. Track which reasons belong to cancelled points so
  // they can be recognised as inherited boilerplate rather than treated
  // as a fresh explanation for the service's current running status.
  // Darwin phrases the same underlying cause differently depending on
  // whether the specific point is cancelled ("cancelled because of X")
  // or merely delayed ("delayed by X") — comparing full sentences misses
  // the match entirely, so strip the standard prefixes down to just the
  // actual cause before comparing.
  function normalizeReason(reason){
    if (!reason) return null;
    return reason
      .replace(/^This service (has been|was)\s*(cancelled because of|delayed by|delayed because of|cancelled due to|delayed due to)\s*/i, '')
      .trim()
      .toLowerCase();
  }
  const inheritedReasons = new Set(points.filter(p => p.isCancelled && p.reason).map(p => normalizeReason(p.reason)));

  // The best available time for each point — a real timestamp if Darwin
  // gave us one, falling back to the scheduled time if it only gave a
  // status word ("On time"/"Delayed") rather than an actual time. Used
  // for display.
  function bestTime(p){
    return (p.liveTime && p.liveTime.includes(':')) ? p.liveTime : p.schedTime;
  }
  // For inferring which calendar day each point falls on, always use the
  // *scheduled* time rather than bestTime(). A live time reflects how
  // delayed a point is — but a cancelled point typically has no live
  // estimate at all and falls back to its own untouched scheduled time.
  // Comparing those two side by side (a delayed real point vs. a
  // cancelled point's un-delayed schedule time) can make the schedule
  // look like it's gone backwards even on an ordinary same-day service,
  // which the midnight-rollover logic below misreads as having crossed
  // into the next day. The timetable itself — not how late a train is
  // running — is what actually determines which calendar day a point
  // belongs to, so date inference is kept on a consistent basis.
  function scheduleTime(p){
    return p.schedTime || bestTime(p);
  }
  // A point showing a delay (a specific figure, or the literal "Delayed"
  // flag) that Darwin hasn't actually confirmed happened yet — no real
  // at/atd/ata behind it. Shared by the "not yet departed/arrived" pill,
  // the walkback that keeps the blob from advancing through such a
  // point, and the summary's "currently at" vs "currently between"
  // wording — one signal, not three separately-maintained copies of the
  // same condition drifting apart from each other over time. Deliberately
  // leaves a plain unconfirmed on-time point alone (liveTime falling
  // back to schedTime, or the literal "On time") — Darwin very often
  // never sends a real actual time even for a point that's clearly
  // already happened, and flagging every such point would be flagging
  // most of an ordinary journey.
  function isGenuinelyUnconfirmedDelay(p){
    return !p.hasConfirmedActual && !p.isCancelled && !!p.liveTime && p.liveTime !== p.schedTime && p.liveTime !== 'On time';
  }
  const pointDates = points.map(p => liveTimeToDate((scheduleTime(p) || '').replace(':', ''), now));
  // The very first point has no earlier point to roll forward from, so it
  // needs its own inference: a bare clock time could plausibly belong to
  // yesterday, today, or tomorrow relative to right now — pick whichever
  // is actually closest. Without this, viewing an overnight service
  // shortly after midnight would anchor its pre-midnight first point to
  // tonight (many hours in the future) instead of correctly recognising
  // it as last night (a few minutes in the past).
  if (pointDates[0]){
    const hhmm = (scheduleTime(points[0]) || '').replace(':', '');
    if (hhmm.length >= 4){
      const closest = closestDateForTime(hhmm, now);
      if (closest) pointDates[0] = closest;
    }
  }
  // A journey can cross midnight partway through (e.g. departs 23:58,
  // still calling at stations after 00:01 the next day). Every point is
  // otherwise built against the same calendar day as "now", so an
  // early-morning point would look like it already happened hours ago
  // today, rather than genuinely being later tonight — which is exactly
  // what made an unstarted journey look fully arrived. Points are always
  // in chronological order, so any date that's not genuinely later than
  // the one before it must actually belong to the next day.
  for (let i = 1; i < pointDates.length; i++){
    if (pointDates[i] && pointDates[i-1] && pointDates[i] <= pointDates[i-1]){
      pointDates[i] = new Date(pointDates[i].getTime() + 24*60*60*1000);
    }
  }

  let lastPassedIdx = -1;
  // A second set of dates, used only from here on for "has this point
  // actually been reached" — pointDates above stays exactly as it was,
  // schedule-only, since that's what correctly handles day inference
  // and the midnight-crossing fix. This one inherits each point's
  // already-correctly-inferred calendar day from pointDates (no new day
  // inference of its own — reusing that logic is exactly the risk this
  // was deferred twice to avoid), and swaps in each point's live time
  // of day (confirmed actual, then estimate, then schedule) in place of
  // the pure schedule time. A badly delayed point's *scheduled* time
  // can pass long before the train genuinely does — Preston scheduled
  // 17:18, only estimated for 17:23 with no confirmed departure at all,
  // is a real case this was checked against directly.
  // 6 hours — comfortably beyond any real early-running margin (a train
  // running early is real, but only ever by a few minutes), comfortably
  // inside any real midnight-crossing gap. Distinguishes "genuinely
  // running early" from "the live time has actually rolled into the
  // next calendar day" below.
  const MIDNIGHT_ROLLOVER_THRESHOLD_MS = 6 * 60 * 60 * 1000;
  const liveDates = points.map((p, i) => {
    if (!pointDates[i]) return null;
    const raw = (p.liveTime && p.liveTime.includes(':')) ? p.liveTime : scheduleTime(p);
    const hhmm = (raw || '').replace(':', '');
    if (hhmm.length < 4) return pointDates[i];
    const h = parseInt(hhmm.slice(0,2), 10), m = parseInt(hhmm.slice(2,4), 10);
    if (isNaN(h) || isNaN(m)) return pointDates[i];
    let d = londonWallClockOn(pointDates[i], h, m);
    // pointDates[i] (the schedule) is already correctly midnight-aware
    // via the day-inference used to build it — this just naively
    // applies the live time's hours/minutes to that same calendar day,
    // which breaks the moment the live estimate has itself crossed
    // midnight relative to the schedule (e.g. scheduled 23:54, running
    // late enough that the live estimate is 00:09 — naively landing on
    // the same day as 23:54 puts it hours in the PAST rather than hours
    // in the future). A genuine delay only ever pushes the actual time
    // later than scheduled, never dramatically earlier, so an
    // implausibly large apparent "earliness" here means a day boundary
    // was actually crossed, not that the train is running early.
    // Reproduced live on two separate points (a "not yet departed" and
    // a "not yet arrived" pill both firing hours too soon) before fixing
    // this — both share this exact computation, so the one fix covers
    // both symptoms.
    if (pointDates[i] - d > MIDNIGHT_ROLLOVER_THRESHOLD_MS) d = new Date(d.getTime() + 24*60*60*1000);
    return d;
  });
  liveDates.forEach((t, i) => { if (t && t <= now) lastPassedIdx = i; });
  // The comparison above has no concept of "cancelled", or of Darwin's
  // explicit "Delayed" flag — genuinely different from having no data at
  // all, since it means the departure/arrival time is actively unknown
  // rather than just running some estimatable number of minutes late.
  // Left to scheduled-time comparison alone:
  // - a cancelled point's own scheduled time is no longer meaningful
  //   once the service never actually reached it, but bestTime() still
  //   falls back to it when there's no real time to use instead — this
  //   would let lastPassedIdx keep advancing through every remaining
  //   cancelled point's original slot as real time passes them,
  //   eventually landing on the booked destination even though the
  //   train genuinely stopped much earlier.
  // - a "Delayed" point's schedule time having elapsed can't
  //   distinguish "left a minute late" from "still sitting at the
  //   platform 20 minutes on" — assuming the schedule still held would
  //   show the train partway to the next stop it may never have
  //   actually left for.
  // Both cases mean the same thing here: don't trust this point as
  // "reached", walk back to the true last point genuinely confirmed —
  // all the way to -1 (giving the correct "Not yet departed" state) if
  // every point up to and including the very first is affected.
  // Cancelled, or showing a delay Darwin hasn't actually confirmed yet
  // (no genuine at/atd/ata — the same signal the "not yet departed" pill
  // uses) — walked back past either way, since neither is safe to treat
  // as "this point has genuinely been reached". The old version of this
  // only caught the literal "Delayed" flag; a specific delayed estimate
  // like "et=10:17" is a real HH:MM value, not that literal string, so
  // it slipped through untouched — the point got counted as reached the
  // moment its *estimate* passed, even with nothing confirmed behind it.
  // A plain unconfirmed on-time point is deliberately left alone here —
  // Darwin very often never sends a real "at" even once a point has
  // clearly already happened, and treating every such point as unsafe
  // would stop the blob advancing through most of an ordinary journey.
  //
  // staffPlatformStatusFor exception added 2026-08-26, closing the
  // blob-position gap found live on a real Cardiff–Holyhead service:
  // this walkback only ever looked at Darwin's own confirmed-actual
  // signal, with no awareness that Staff might independently confirm
  // ataSpecified for the exact same point — so a genuinely-reached
  // point Darwin itself hadn't confirmed got walked back past anyway,
  // even though Staff already knew the train was sitting right there.
  // Once atdSpecified also becomes true (genuinely departed),
  // staffPlatformStatusFor stops returning anything for that point —
  // by then Darwin's own hasConfirmedActual has almost always caught
  // up too (helped along by the backlog #7 fix), so this exception is
  // only ever needed for exactly the still-there window, not beyond it.
  while (lastPassedIdx >= 0 && (
    points[lastPassedIdx].isCancelled ||
    (isGenuinelyUnconfirmedDelay(points[lastPassedIdx]) && !staffPlatformStatusFor(points[lastPassedIdx].crs, staffLiveStatusOverrides, now, staffDataAge, staffOverrunLatch))
  )){
    lastPassedIdx--;
  }

  // Symmetrical forward-advance, added 2026-08-26 — fixes a genuinely
  // different bug found live on an early-running train (Birkdale,
  // arrived confirmed 70 seconds before its own scheduled time): the
  // forward pass above only advances lastPassedIdx once a point's own
  // Darwin-based time has passed "now", which an early train can defeat
  // entirely (Darwin's forecast simply hadn't moved yet, still sitting
  // in the future relative to "now" even though Staff already confirmed
  // arrival). The walkback just above only ever pulls lastPassedIdx
  // backward, so it has nothing to do here — this is the forward-facing
  // counterpart, advancing through any consecutive run of points Staff
  // confirms were genuinely reached, regardless of whether Darwin's own
  // due-time has technically elapsed yet. staffConfirmsArrival is
  // deliberately broader than staffPlatformStatusFor (arrival alone,
  // not "still there right now") — a point that's already departed too
  // is even more clearly reached, and should still count here. The
  // isCancelled guard is defensive: a genuinely cancelled point
  // shouldn't real-world ever have a Staff-confirmed arrival, but this
  // never advances onto one regardless.
  while (
    lastPassedIdx < points.length - 1 &&
    !points[lastPassedIdx + 1].isCancelled &&
    staffConfirmsArrival(points[lastPassedIdx + 1].crs, staffLiveStatusOverrides, now, staffDataAge)
  ){
    lastPassedIdx++;
  }

  // How far between the last-passed and next-due point we are right now,
  // as a plain fraction of the scheduled gap between them — the same
  // "50% of the way there" maths regardless of how long that gap is.
  // Rows now vary in real rendered height (the delay-reason text can wrap
  // onto extra lines), so the actual pixel position is measured from the
  // real DOM after rendering rather than assumed from a fixed row height
  // — this fraction is just "how far between these two points", applied
  // to real measurements by positionBlobAndLine().
  //
  // Pinned to 0 whenever Staff confirms the train is still genuinely
  // sitting at lastPassedIdx itself (ataSpecified && !atdSpecified) —
  // added 2026-08-26, same live finding as the walkback exception just
  // above. Without this, the elapsed-time maths below would keep
  // computing partial "progress" toward the next point purely because
  // real clock time has gone past a schedule reality has since
  // overtaken — creeping the blob forward even though the train
  // genuinely hasn't moved. Once it actually departs, atdSpecified
  // flips true, this stops applying, and the ordinary elapsed-time
  // fraction takes back over correctly from wherever it actually is.
  let fraction = 0;
  if (lastPassedIdx >= 0 && lastPassedIdx < points.length - 1 && !points[lastPassedIdx + 1].isCancelled){
    const stillAtLastPassed = !!staffPlatformStatusFor(points[lastPassedIdx].crs, staffLiveStatusOverrides, now, staffDataAge, staffOverrunLatch);
    if (!stillAtLastPassed){
      const t1 = liveDates[lastPassedIdx], t2 = liveDates[lastPassedIdx + 1];
      if (t1 && t2 && t2 > t1){
        fraction = Math.max(0, Math.min(1, (now - t1) / (t2 - t1)));
      }
    }
  }

  // Hoisted here (rather than computed only where it's used for the
  // amber highlighting further down) so journeyFinished and the fast
  // polling trigger can both reason about "my journey" too, not just
  // the physical train's own true endpoint. Only ever resolves when
  // train.toLoc is genuinely set (a "My Trains" configured route) — for
  // anything else (search-tracked or arrival-only), there's no defined
  // "my journey" segment, so this stays -1 and everything downstream
  // correctly falls back to the physical-endpoint behaviour instead.
  const toLocIdx = train.toLoc ? points.findIndex(p => p.crs === train.toLoc) : -1;

  let summaryHtml = '';
  let primaryReason = null;
  let knownOverallDelay = 0; // the most reliable delay figure we have, in minutes — used both for the summary headline and to infer real times for passed points Darwin only gave a generic "On time" word for
  let anyReasonSuppressed = false; // true if a reason was hidden by the staleness heuristic or the repeat-dedup — drives the "Show all reasons" reveal link
  let journeyFinished = !!service.isCancelled; // true once there's genuinely nothing left to poll for — arrived at the booked destination, terminated early with everything remaining cancelled, or the whole service has been cancelled outright
  // Index of whichever point atPlatformPoint below resolves to (last or
  // afterLast), or -1 if neither. Added 2026-08-27 alongside the row
  // loop's staffPlatformHere fix: the summary already reconciles "last"
  // vs "afterLast" to pick the single most-current point (see
  // atPlatformPoint's own comment below), but that reconciled answer
  // used to live only inside this if-block, so the row loop had no way
  // to see it and fell back to always checking lastPassedIdx's own row
  // instead — letting the two disagree on which row is "AT PLATFORM"
  // whenever afterLast turned out to be the more current one. Hoisted
  // here so the row loop can check against this instead, making "which
  // row gets the badge" and "what the banner calls current" the same
  // answer by construction, the same principle the Wigan Wallgate fix
  // already established one level up (a real position can only be
  // claimed once).
  let atPlatformPointIdx = -1;
  if (lastPassedIdx >= 0){
    const last = points[lastPassedIdx];
    const status = describePointStatusRemembered(service.serviceID, last.crs || `idx-${lastPassedIdx}`, last.schedTime, last.liveTime, last.isCancelled);
    const afterLast = points[lastPassedIdx + 1];
    const remaining = points.slice(lastPassedIdx + 1);
    // Same Staff AT PLATFORM signal the row pill uses, checked here too
    // (2026-08-26) — without this, the summary banner could keep saying
    // "Currently between Carlisle and Glasgow Central" / "Running on
    // time" while the Carlisle row itself correctly showed AT PLATFORM
    // then NOT YET DEPARTED, found live. Genuinely more accurate either
    // way: it hasn't actually left `last` yet, so "between" is wrong
    // regardless of whether it's overrunning its expected departure.
    //
    // Checks afterLast too, not just last (fixed same day, found live
    // on a real Cardiff–Holyhead service): Darwin's own lastPassedIdx
    // walkback and Staff's independent AT PLATFORM confirmation don't
    // always agree on which point is "current" — here Darwin's own
    // logic was still one step behind at Shrewsbury while Staff had
    // already confirmed Crewe (afterLast) as arrived-not-departed, so
    // checking only `last` missed it entirely and kept showing
    // "between Shrewsbury and Crewe" through the whole AT PLATFORM /
    // NOT YET DEPARTED cycle. afterLast takes priority when both
    // somehow show it, since it's the more forward, more current
    // position.
    const lastStaffPlatformRaw = staffPlatformStatusFor(last.crs, staffLiveStatusOverrides, now, staffDataAge, staffOverrunLatch);
    const afterLastStaffPlatform = afterLast ? staffPlatformStatusFor(afterLast.crs, staffLiveStatusOverrides, now, staffDataAge, staffOverrunLatch) : null;
    // Also recognises the original, pre-existing Darwin-only "not yet
    // departed" trigger for afterLast, not just Staff's — found live
    // (2026-08-26) on a later point in the same journey (Colwyn Bay):
    // its own row correctly showed NOT YET DEPARTED, but the summary
    // still said "between Rhyl and Colwyn Bay", because that particular
    // row's pill had actually come from isGenuinelyUnconfirmedDelay
    // (Staff simply had no ata/atd for Colwyn Bay on that poll), which
    // the Staff-only check above has no way to see. Whichever mechanism
    // triggered the pill, the real-world meaning is identical — it
    // hasn't left afterLast yet — so both need to count here. Mirrors
    // the row loop's own dueMomentPassed/isGenuinelyUnconfirmedDelay
    // condition for that exact index, minus the i === lastPassedIdx + 1
    // check, since afterLast already IS that index by definition.
    const afterLastDueMomentPassed = !!(afterLast && liveDates[lastPassedIdx + 1] && now >= liveDates[lastPassedIdx + 1]);
    const afterLastNotYetDepartedViaDarwin = !!(afterLast && afterLastDueMomentPassed && isGenuinelyUnconfirmedDelay(afterLast));
    const atPlatformPoint = (afterLastStaffPlatform || afterLastNotYetDepartedViaDarwin) ? afterLast : (lastStaffPlatformRaw ? last : null);
    atPlatformPointIdx = (atPlatformPoint === afterLast) ? (lastPassedIdx + 1) : (atPlatformPoint === last ? lastPassedIdx : -1);
    const lastStaffPlatform = afterLastStaffPlatform || lastStaffPlatformRaw;
    // "Terminated early" — every remaining booked calling point has been
    // cancelled, meaning the train stops here and won't reach its real
    // destination (or the last-passed point itself was cancelled, an
    // edge case that amounts to the same thing).
    const terminatedEarly = (remaining.length > 0 && remaining.every(p => p.isCancelled)) || (!afterLast && last.isCancelled);

    if (terminatedEarly){
      journeyFinished = true;
      const finalPoint = points[points.length - 1];
      const locLine = `Terminated at ${last.locationName}`;
      const statusLine = (finalPoint && finalPoint.locationName !== last.locationName) ? `Did not continue to ${finalPoint.locationName}` : '';
      summaryHtml = `<div>${locLine}</div>${statusLine ? `<div style="font-size:13px; margin-top:4px; opacity:0.9;">${statusLine}</div>` : ''}`;
    } else if (!afterLast){
      journeyFinished = true;
      // Genuinely reached the final booked destination — no "running",
      // the journey's over.
      const arrivalText = status.minutesLate === null ? status.text : (status.minutesLate > 0 ? `${status.minutesLate} min late` : 'On time');
      summaryHtml = `<div>Arrived at ${last.locationName}</div><div style="font-size:13px; margin-top:4px; opacity:0.9;">${arrivalText}</div>`;
    } else {
      // Darwin sometimes only attaches a specific recalculated number to
      // some points and not others on a given poll, leaving nearby
      // points showing a generic "On time" word even when a delay
      // reason is clearly attached to them. Rather than trust whichever
      // point happens to be "last passed" (which might only have that
      // generic word) — or only check the far final destination, which
      // may not have a specific number yet either — scan forward through
      // every remaining point for the first one with a real confirmed
      // figure, since a nearby point is far more likely to have current
      // data than a still-distant one.
      // The next point ahead is Darwin's freshest, most current read on
      // how the service is running — the last-passed point's figure is
      // already history and won't be revised further once it's actually
      // happened. Prefer the next point's number when it has a real one,
      // rather than defaulting to whatever the passed point locked in.
      let overallStatus = status;
      const afterLastStatus = describePointStatus(afterLast.schedTime, afterLast.liveTime, afterLast.isCancelled);
      if (afterLastStatus.minutesLate !== null && afterLastStatus.minutesLate > 0){
        overallStatus = afterLastStatus;
      } else if (afterLastStatus.confirmed && afterLastStatus.text === 'Delayed'){
        // The current point can be genuinely, correctly confirmed "on
        // time" while the very next point has already been flagged
        // Delayed — that's new information the current point's own
        // status has no way to reflect yet, since it happened
        // afterward. "Delayed" carries no minutes-late number, so the
        // check above (which only reacts to a positive figure) was
        // silently ignoring it entirely — confirmed live against a real
        // Heathrow Express service showing "Running on time" while the
        // very next point was clearly Delayed.
        overallStatus = afterLastStatus;
      } else if (overallStatus.minutesLate === null || (overallStatus.minutesLate === 0 && !overallStatus.confirmed)){
        // Genuinely confirmed on time (or early) at the current point is
        // real, current information — not the same as having no data.
        // The scan below exists to find a usable figure when there's
        // truly nothing to go on (unconfirmed "Delayed", or no live time
        // at all yet), but it was also firing whenever the current point
        // had *resolved back* to on time, walking back through the
        // entire already-passed journey for the first old delay it could
        // find — e.g. reporting a 2-minute delay from Wigan as the
        // train's current status long after Preston, Lancaster and
        // Oxenholme had all confirmed it back on schedule. Only search
        // when there's actually nothing confirmed to trust instead.
        // Neither the passed point nor the very next one has a usable
        // figure — scan further ahead, then behind, for the first real
        // confirmed number anywhere in the journey.
        for (const candidate of points.slice(lastPassedIdx + 1)){
          const candidateStatus = describePointStatus(candidate.schedTime, candidate.liveTime, candidate.isCancelled);
          if (candidateStatus.minutesLate !== null && candidateStatus.minutesLate > 0){
            overallStatus = candidateStatus;
            break;
          }
        }
        if (overallStatus.minutesLate === null || overallStatus.minutesLate === 0){
          for (let j = lastPassedIdx - 1; j >= 0; j--){
            const candidateStatus = describePointStatus(points[j].schedTime, points[j].liveTime, points[j].isCancelled);
            if (candidateStatus.minutesLate !== null && candidateStatus.minutesLate > 0){
              overallStatus = candidateStatus;
              break;
            }
          }
        }
      }
      let runningText;
      if (overallStatus.minutesLate === null){
        runningText = overallStatus.text;
      } else if (overallStatus.minutesLate > 0){
        runningText = `Running ${overallStatus.minutesLate} min late`;
      } else if (overallStatus === status && status.minutesEarly > 0){
        runningText = `Running ${status.minutesEarly} min early`;
      } else {
        runningText = 'Running on time';
      }
      if (overallStatus.minutesLate > 0) knownOverallDelay = overallStatus.minutesLate;
      // Overrides the "Running X" line specifically for the overrun
      // case (2026-08-26) — same reasoning as the row-level fix: once
      // Staff confirms it's sat there past its expected departure,
      // "Running on time" (or any other pre-existing text) is actively
      // contradicted by the AT PLATFORM/NOT YET DEPARTED pill on its
      // own row. Left alone (not overridden) when it's genuinely still
      // within its expected dwell — "Running on time" can be perfectly
      // correct there.
      // Wording split from the overrun signal itself (2026-09-16) — found
      // live on a train that departed exactly on time: overrun only means
      // Staff hasn't confirmed the departure past Darwin's predicted etd,
      // which for an on-time service is the scheduled time itself, so it
      // goes true within seconds of an on-time departure purely from
      // confirmation lag, not because the train is actually late.
      // "Delayed" is only accurate once there's a genuine known delay
      // figure (knownOverallDelay, already set just above whenever
      // overallStatus.minutesLate is a real positive number); otherwise
      // this stays a plain, non-judgemental "Not yet departed" — the pill
      // on the row already says that on its own.
      if (lastStaffPlatform && lastStaffPlatform.overrun){
        runningText = knownOverallDelay > 0 ? `Delayed — ${knownOverallDelay} min late, not yet departed` : 'Not yet departed';
      }
      // Three separate lines — where it is, its status, and why (if
      // known) — rather than one long line that wraps awkwardly with
      // longer station names.
      const rawReason = last.reason || (afterLast && afterLast.reason) || null;
      // Only trust this as a genuine current explanation if it isn't
      // just carried-over text from an earlier cancellation elsewhere in
      // the journey — unless the current point is itself cancelled, in
      // which case it's directly relevant again. showAllReasons bypasses
      // this entirely as a manual override, since the heuristic can be
      // wrong on the rare service where the same cause genuinely never
      // stops being relevant.
      const wouldSuppress = rawReason && !last.isCancelled && !afterLast.isCancelled && inheritedReasons.has(normalizeReason(rawReason));
      if (wouldSuppress) anyReasonSuppressed = true;
      primaryReason = (rawReason && (showAllReasons || !wouldSuppress)) ? rawReason : null;
      // "Currently at X" (with platform, when known) whenever Staff
      // confirms it's genuinely still sitting there, rather than
      // "Currently between X and Y" — found live (2026-08-26) saying
      // "between Carlisle and Glasgow Central" while Carlisle's own row
      // correctly showed AT PLATFORM. True regardless of overrun: it
      // hasn't left that point either way, so "between" undersells what's
      // actually known here. Uses atPlatformPoint (last or afterLast,
      // whichever Staff actually confirms — see its declaration above),
      // not always `last`.
      const atPlatformText = atPlatformPoint && atPlatformPoint.platform ? ` · Platform ${atPlatformPoint.platform}` : '';
      const locationLine = atPlatformPoint
        ? `Currently at ${atPlatformPoint.locationName}${atPlatformText}`
        : `Currently between ${last.locationName} and ${afterLast.locationName}`;
      summaryHtml = `<div>${locationLine}</div>` +
        `<div style="font-size:13px; margin-top:4px; opacity:0.9;">${runningText}</div>` +
        (primaryReason ? `<div style="font-size:13px; margin-top:4px; opacity:0.85;">${primaryReason}</div>` : '');
    }
  } else if (points.length){
    summaryHtml = `Not yet departed ${points[0].locationName}`;
  }

  // Tracks whichever reason was most recently actually shown, in row
  // order — starts as primaryReason (already shown once in the summary
  // box), then updates as we go, so a whole run of consecutively
  // cancelled points sharing the same reason collapses to showing it
  // only on the first one, not repeated down the entire list.
  let lastShownReason = primaryReason;

  // hereIdx computed here alongside the row-rendering it's used for —
  // toLocIdx itself now lives further up, computed once for
  // journeyFinished and the polling cadence too, not re-derived here.
  const hereIdx = points.findIndex(p => p.isYourStation);
  const rowsHtml = points.map((p, i) => {
    try{
      const isToLocRow = toLocIdx !== -1 && i === toLocIdx;
      const inMyJourney = toLocIdx !== -1 && hereIdx !== -1 && i >= Math.min(hereIdx, toLocIdx) && i <= Math.max(hereIdx, toLocIdx);
      // A separator wherever the journey crosses into a new calendar
      // day — matches National Rail's own presentation. pointDates is
      // already correctly day-aware (built for the midnight-crossing
      // fix), so this is just comparing each point's real date to the
      // one before it; no new date logic needed.
      const daySeparator = (i > 0 && pointDates[i] && pointDates[i-1] && pointDates[i].toDateString() !== pointDates[i-1].toDateString())
        ? `<div style="text-align:center; font-size:13px; color:var(--amber); padding:8px 0; border-bottom:1px solid var(--line); margin-left:6px;">${pointDates[i].toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long'})}</div>`
        : '';
      const status = describePointStatusRemembered(service.serviceID, p.crs || `idx-${i}`, p.schedTime, p.liveTime, p.isCancelled);
      const nameColor = (p.isYourStation || isToLocRow) ? 'var(--amber)' : 'var(--ink)';
      // The reason text often stays attached even once a point's own
      // status has recovered to genuinely on time — show it whenever
      // there's real uncertainty or an actual problem, but not once a
      // point has positively confirmed it's back on time. Also skip it
      // if it's the same reason already shown on the row immediately
      // before it (or in the summary box) — no need to repeat it over
      // and over down a whole run of affected stations. And skip it if
      // it's boilerplate inherited from an earlier cancellation rather
      // than a fresh explanation — unless this row is itself cancelled,
      // in which case it's directly relevant again.
      const isStaleReason = !p.isCancelled && inheritedReasons.has(normalizeReason(p.reason));
      const showReason = !!p.reason && status.minutesLate !== 0 && (showAllReasons || (p.reason !== lastShownReason && !isStaleReason));
      if (p.reason) lastShownReason = p.reason;
      const reasonHtml = showReason ? `<div style="font-size:13px; color:#ff8b7e; margin-top:1px;">${p.reason}</div>` : '';
      // Cross out the scheduled time and show the real one whenever
      // Darwin gave a genuine specific delayed time (not just a status
      // word) — same idea as Avanti's own calling-points view.
      const hasRealTime = p.liveTime && p.liveTime.includes(':') && p.liveTime !== p.schedTime;
      // For an already-passed point that Darwin only gave a generic "On
      // time" word for, despite the service clearly running late overall
      // — infer a rough real time from the known overall delay, clearly
      // marked as an estimate rather than presented as confirmed data.
      const isInferred = !hasRealTime && !status.confirmed && i <= lastPassedIdx && status.minutesLate === 0 && knownOverallDelay > 0 && !p.isCancelled;
      const inferredTime = isInferred ? addMinutesToTime(p.schedTime, knownOverallDelay) : null;
      // A passed point Darwin never gave real data for (the Crewe-origin
      // limitation), but with no known overall delay elsewhere to infer a
      // real time from — e.g. the rest of the journey has since recovered
      // to on time. Still genuinely unconfirmed, so it must not fall
      // through to look identical to a point Darwin actively confirmed —
      // that's the bug where Crewe silently flipped from "estimated" to
      // plain green "On time" once the later delay cleared, even though
      // Darwin's data for Crewe itself never changed.
      const isUnconfirmedOnTime = !hasRealTime && !isInferred && !status.confirmed && i <= lastPassedIdx && status.minutesLate === 0 && !p.isCancelled;

      let timeHtml, statusText, statusColor;
      if (hasRealTime){
        timeHtml = `<span style="text-decoration:line-through; color:var(--ink-dim); font-size:13px;">${p.schedTime || ''}</span><br/><span style="color:${status.color}; font-weight:600;">${p.liveTime}</span>`;
        statusText = status.text;
        statusColor = status.color;
      } else if (isInferred && inferredTime){
        timeHtml = `<span style="text-decoration:line-through; color:var(--ink-dim); font-size:13px;">${p.schedTime || ''}</span><br/><span style="color:#e8935f; font-style:italic;">~${inferredTime}</span>`;
        statusText = `~${knownOverallDelay} min late (estimated)`;
        statusColor = '#e8935f';
      } else if (isUnconfirmedOnTime){
        timeHtml = p.schedTime || '';
        statusText = 'On time (estimated)';
        statusColor = '#e8935f';
      } else {
        timeHtml = p.schedTime || '';
        statusText = status.text;
        statusColor = status.color;
      }
      // 2026-10-07 — arrival/departure columns from Staff (option A); see
      // buildStaffTimeColumnsHtml. Only replaces the time cell; the status
      // line, pills and blob logic are untouched. Skipped once Staff data
      // has gone stale, same gate as the AT PLATFORM pill.
      {
        const staffFresh = staffDataAge !== null && staffDataAge !== undefined && (now - staffDataAge) <= STAFF_DATA_MAX_AGE_MS;
        const staffTimes = (staffFresh && p.crs) ? buildStaffTimeColumnsHtml(staffLiveStatusOverrides[p.crs], p.isCancelled) : null;
        if (staffTimes) timeHtml = staffTimes;
      }
      const platformText = p.platform ? ` <span style="color:var(--ink-dim);">· Platform ${p.platform}</span>` : '';
      // A specific delay figure (or the literal "Delayed" flag) is
      // sometimes shown for a point whose actual departure/arrival
      // hasn't been confirmed by Darwin at all yet (raw at/atd/ata still
      // blank) — genuinely still just a live estimate, even once its own
      // due moment has passed, not a settled fact. Flagged explicitly
      // rather than left looking as definitive as a confirmed delay.
      // Deliberately narrow: only once the point's own due moment has
      // actually passed (liveDates, the same live time basis the blob
      // itself now uses) — and only when it's a genuinely unconfirmed
      // delay, not just an ordinary unconfirmed on-time point, which is
      // most of a journey and would otherwise be flagged almost everywhere.
      // The very last point in the whole list doesn't "depart" at all —
      // it's the final destination, so the same signal is worded as
      // "not yet arrived" there instead, rather than the departure
      // language that's meaningless for a terminus.
      const dueMomentPassed = liveDates[i] && now >= liveDates[i];
      const isFinalPoint = i === points.length - 1;
      // AT PLATFORM (2026-08-26) — confirmed live three times now (Bryn,
      // Stockport, Rugby): ataSpecified && !atdSpecified from the Staff
      // board reliably means "arrived, still sitting at the platform".
      // Takes priority over the NOT YET DEPARTED/ARRIVED pill below for
      // the current point. Deliberately doesn't apply to the final
      // point — there's no "departing" the destination in this app's
      // journey view.
      //
      // Restricted to i === lastPassedIdx (fixed same day, found live
      // on a real Manchester–Southport service): originally this
      // checked every row's own crs independently, on the reasoning
      // that "a real train can only be at-platform-somewhere once at a
      // time" made it naturally self-limiting. That reasoning breaks
      // down for a permanent Darwin/Staff data gap — Wigan Wallgate's
      // own entry had departureType "NoLog" (no departure ever
      // recorded for that point at all, not "hasn't happened yet"),
      // even though the train had clearly continued for real, confirmed
      // several stops further on at Meols Cop and beyond. That left
      // ataSpecified && !atdSpecified permanently true for Wigan
      // Wallgate, so it kept showing AT PLATFORM at the same time as
      // the genuinely current point further down the journey — two rows
      // simultaneously claiming the train's position, which should be
      // structurally impossible. lastPassedIdx (already correctly
      // resolved by the walkback/forward-advance pair above, which
      // reconcile Darwin's and Staff's signals against each other) is
      // the one place in this function that already represents the
      // real current frontier — checking against it here, rather than
      // trusting any individual row's own raw ataSpecified/atdSpecified
      // in isolation, makes the two-rows-at-once case impossible by
      // construction instead of by an assumption that didn't hold.
      //
      // Routed through staffPlatformStatusFor rather than reading
      // staffLiveStatusOverrides directly (refactored 2026-08-26,
      // following peer review) — this was the one remaining place still
      // duplicating the same ataSpecified/atdSpecified/etd logic
      // inline, which meant it was also the one place the new
      // staffDataAge staleness gate could have been missed if it had
      // stayed separate.
      //
      // Checked against atPlatformPointIdx rather than lastPassedIdx
      // directly (2026-08-27) — found live on a Wigan–Crewe service
      // where Watford Junction's own Staff record still showed
      // ataSpecified && !atdSpecified (no departure ever logged for it)
      // while the train had clearly moved on to London Euston, whose
      // own due-moment had already passed with nothing confirmed. The
      // summary banner correctly named Euston as current (via
      // atPlatformPoint's own last/afterLast reconciliation just above),
      // but this check still only ever looked at lastPassedIdx's row —
      // Watford — so it kept showing AT PLATFORM there regardless,
      // directly contradicting the banner and Euston's own NOT YET
      // ARRIVED pill. atPlatformPointIdx is that same reconciled answer,
      // hoisted so this loop can check against it instead — the row
      // that can claim AT PLATFORM is now, by construction, whichever
      // one the banner also calls current, never a stale earlier point
      // Staff simply hasn't logged a departure for yet.
      const staffPlatformHere = (i === atPlatformPointIdx) ? staffPlatformStatusFor(p.crs, staffLiveStatusOverrides, now, staffDataAge, staffOverrunLatch) : null;
      const isAtPlatformViaStaff = !isFinalPoint && !!staffPlatformHere;
      const staffOverrun = isAtPlatformViaStaff && !!staffPlatformHere.overrun;
      // Fixes a real contradiction found live (2026-08-26): staffOverrun
      // firing the NOT YET DEPARTED pill while statusText underneath it
      // still said "On time" — genuinely confusing, since by definition
      // staffOverrun means it's now running late by some amount.
      //
      // Upgraded same day from a plain "Delayed" to a live minutes-late
      // figure — Wayne pointed out the data to do this properly was
      // already sitting right there (this row's own point has a real
      // Staff-confirmed ata to work from) and asked for it, then asked
      // for it to be terser: exactly the same plain "X min late" text
      // and colour describePointStatus already uses for every other
      // confirmed-late row, nothing extra appended — the AT
      // PLATFORM/NOT YET DEPARTED pill already says "still there" on
      // its own, so this text doesn't need to repeat it.
      //
      // Measured against pointDates[i] (the point's plain SCHEDULED
      // time, already correctly midnight-safe — see its own
      // declaration above) rather than building a second date-from-
      // HH:MM conversion here — reusing the one that's already careful
      // about day-rollover is safer than a second one that might get it
      // subtly wrong. Recalculated fresh every render, so this grows on
      // its own between polls purely from "now" moving forward — no new
      // fetch needed, same reasoning as everywhere else Staff data
      // already gets reused in this function.
      if (staffOverrun){
        const minutesLateNow = pointDates[i] ? Math.round((now - pointDates[i]) / 60000) : null;
        if (minutesLateNow !== null && minutesLateNow > 0){
          statusText = `${minutesLateNow} min late`;
          statusColor = '#ff8b7e';
        }
        // Otherwise (pointDates[i] missing, or no whole minute past
        // schedule yet) statusText is left as the row's normal status.
        // It used to be set to "Not yet departed" here (2026-09-16), but
        // that just repeated the NOT YET DEPARTED pill beside it word for
        // word (found live 2026-09-29) — the pill already says it.
      }
      const atPlatformPill = (isAtPlatformViaStaff && !staffOverrun)
        ? ` <span style="background:#2fa360; color:#fff; font-weight:700; font-size:11px; letter-spacing:0.3px; padding:2px 7px; border-radius:10px; white-space:nowrap;">AT PLATFORM</span>`
        : '';
      // Only the very next point after the last confirmed one gets the
      // pill. Once the train hasn't genuinely departed/arrived *there*,
      // it obviously hasn't reached any later point either — every
      // point further down the line would independently satisfy the
      // same dueMomentPassed && isGenuinelyUnconfirmedDelay check purely
      // because its own due time has also elapsed, producing a pill on
      // every remaining row (e.g. both Carlisle and the next stop after
      // it) instead of just the one place the train is actually stuck.
      // staffOverrun (confirmed arrived via Staff, past its own etd,
      // still not departed) is an additional, more precise trigger for
      // this exact same pill. Now implicitly gated to i === lastPassedIdx
      // rather than i === lastPassedIdx + 1 (see staffPlatformHere's own
      // restriction above) — previously described as "not gated" on the
      // reasoning that it was naturally self-limiting, which a real
      // permanent Darwin/Staff data gap (Wigan Wallgate's "NoLog"
      // departure, above) proved false. Never both pills at once:
      // showNotYetPill is forced false whenever the calmer AT PLATFORM
      // pill above is already showing.
      const showNotYetPill = !atPlatformPill && (
        staffOverrun || (dueMomentPassed && isGenuinelyUnconfirmedDelay(p) && i === lastPassedIdx + 1)
      );
      const notYetDepartedPill = showNotYetPill
        ? ` <span style="background:#ff4d3d; color:#fff; font-weight:700; font-size:11px; letter-spacing:0.3px; padding:2px 7px; border-radius:10px; white-space:nowrap;">NOT YET ${isFinalPoint ? 'ARRIVED' : 'DEPARTED'}</span>`
        : '';
      const debugHtml = (showRawDebug && p.raw)
        ? `<div style="font-family:monospace; font-size:10px; color:#6a7a8a; margin-top:2px;">${Object.entries(p.raw).map(([k,v]) => `${k}=${v === undefined || v === null ? '·' : v}`).join('  ')}</div>`
        : '';
      return `
        ${daySeparator}
        <div class="rail-detail-row" data-idx="${i}" style="align-items:center; min-height:${TRAIN_PROGRESS_ROW_HEIGHT}px; padding-left:22px; position:relative;${inMyJourney ? ' background:color-mix(in srgb, var(--amber) 8%, transparent);' : ''}">
          <span style="position:absolute; left:2px; width:8px; height:8px; border-radius:50%; background:var(--line); top:50%; transform:translateY(-50%);"></span>
          <span style="min-width:56px;">${timeHtml}</span>
          <span style="flex:1; text-align:right;">
            <span class="wx-badge" data-wx-idx="${i}" style="margin-right:6px; font-size:13px; white-space:nowrap;"></span><span style="color:${nameColor}; font-weight:${(p.isYourStation||isToLocRow)?600:400};">${p.locationName || 'Unknown'}</span>
            <div style="color:${statusColor}; font-size:13px; margin-top:1px;">${statusText}${atPlatformPill}${notYetDepartedPill}${platformText}</div>
            ${reasonHtml}
            ${debugHtml}
          </span>
        </div>`;
    }catch(e){
      // One malformed calling point shouldn't take the whole list down —
      // show what we can and keep going.
      return `<div class="rail-detail-row" data-idx="${i}"><span>${p.locationName || 'Unknown'}</span><span style="color:var(--ink-dim);">—</span></div>`;
    }
  }).join('');

  // Points worth fetching weather for: not already passed (a forecast for
  // a station the train left an hour ago is meaningless), not cancelled
  // (it's never actually going to stop there), and with a CRS code to
  // resolve coordinates from at all — Darwin doesn't always supply one.
  // dueAt is kept as a local wall-clock string (no timezone conversion)
  // to match Open-Meteo's own local-time response format one-for-one —
  // going via toISOString() here would silently shift by an hour
  // whenever BST is in effect, since that forces UTC.
  const weatherPoints = points
    .map((p, i) => ({ idx: i, crs: p.crs, dueAt: pointDates[i] ? localWallClockString(pointDates[i]) : null }))
    .filter(wp => wp.crs && wp.dueAt && !points[wp.idx].isCancelled && wp.idx > lastPassedIdx);

  // Persisted here (fire-and-forget, once per call — not from inside
  // describePointStatusRemembered itself, which runs once per point and
  // would otherwise trigger several redundant writes per single render)
  // so a freshly-confirmed status survives the app actually being killed
  // between polls, not just staying alive for the rest of this session.
  saveConfirmedPointStatusCache();

  let formationHtml = buildFormationHtml(service, train);
  const formationDebugHtml = buildFormationDebugHtml(service, showRawDebug, train && train.serviceId);
  const formationIsEstimated = !!getLengthOnlyFormationLetters(service);

  return { summaryHtml, rowsHtml, lastPassedIdx, fraction, pointCount: points.length, anyReasonSuppressed, journeyFinished, weatherPoints, departsHere, firstPoint: points[0] || null, lastPoint: points[points.length - 1] || null, toLocIdx, formationHtml, formationDebugHtml, formationIsEstimated };
}
