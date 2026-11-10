// screen-calendar.js — openDayEditor, calendar view, calendar day detail.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

function openDayEditor(key){
  const d = parseKey(key);
  const weekend = isWeekend(d);
  const current = comments[key] || '';
  const isTravelDay = !weekend && (current === '' || travelOverrides[key]);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>${dateLabel(d)}</h3>
      <div class="sub">${weekend ? 'Weekend day — always skipped' : 'Add a reason this day doesn\'t count (or leave blank for a normal travel day)'}</div>
      <div class="chip-row" id="modal-chip-row">
        ${PRESET_TAGS.map(tag => `<div class="chip ${current.toUpperCase()===tag?'active':''}" data-tag="${tag}">${tag}</div>`).join('')}
        <div class="chip" data-tag="__clear">Clear</div>
      </div>
      <input type="text" id="modal-custom-comment" placeholder="Or type your own" value="${escapeHtml(current && !PRESET_TAGS.includes(current.toUpperCase()) ? current : '')}" />
      ${!weekend ? `
      <label style="display:flex; align-items:center; gap:8px; margin:12px 0 4px; font-size:14px; color:var(--ink-dim); cursor:pointer;">
        <input type="checkbox" id="modal-override-checkbox" ${travelOverrides[key] ? 'checked' : ''} style="width:16px; height:16px;" />
        I still used the ticket this day
      </label>` : ''}
      ${!weekend ? `
      <label style="display:flex; align-items:center; gap:8px; margin:12px 0 4px; font-size:14px; color:var(--ink-dim); cursor:pointer;">
        <input type="checkbox" id="modal-parked-checkbox" ${parkedDays[key] !== undefined ? 'checked' : ''} style="width:16px; height:16px;" />
        I parked today
      </label>
      <div id="modal-parked-cost-wrap" style="display:${parkedDays[key] !== undefined ? 'flex' : 'none'}; align-items:center; gap:8px; margin-bottom:8px;">
        <span style="font-size:13px; color:var(--ink-dim);">Cost (£)</span>
        <input type="number" id="modal-parked-cost-input" value="${(parkedDays[key] !== undefined ? parkedDays[key] : parkingCost).toFixed(2)}" step="0.01" min="0" style="width:100px;" />
      </div>` : ''}
      <button class="save-btn" id="modal-save-btn">Save</button>
      <div class="modal-close" id="modal-close-btn">Cancel</div>
    </div>
  `;
  document.body.appendChild(overlay);

  function getOverrideChecked(){
    const cb = document.getElementById('modal-override-checkbox');
    return cb ? cb.checked : false;
  }

  const modalOverrideCb = document.getElementById('modal-override-checkbox');
  if (modalOverrideCb){
    modalOverrideCb.addEventListener('change', async () => {
      if (modalOverrideCb.checked) travelOverrides[key] = true; else delete travelOverrides[key];
      await saveTravelOverrides();
      render(); // safe: this overlay is attached to document.body, not #app, so it survives re-render
      if (modalOverrideCb.checked) railSyncMissingDates();
    });
  }

  const modalParkedCb = document.getElementById('modal-parked-checkbox');
  const modalParkedCostWrap = document.getElementById('modal-parked-cost-wrap');
  const modalParkedCostInput = document.getElementById('modal-parked-cost-input');
  if (modalParkedCb){
    modalParkedCb.addEventListener('change', async () => {
      if (modalParkedCb.checked){
        modalParkedCostWrap.style.display = 'flex';
        const val = parseFloat(modalParkedCostInput.value);
        parkedDays[key] = isNaN(val) ? parkingCost : val;
      } else {
        modalParkedCostWrap.style.display = 'none';
        delete parkedDays[key];
      }
      await saveParkedDays();
      render();
    });
  }
  if (modalParkedCostInput){
    // Editable per instance, not just at the moment of first marking —
    // the actual cost genuinely varies (a different car park, a
    // different rate), and this needs to be correctable any time the
    // day's revisited, not fixed at whatever was entered first.
    modalParkedCostInput.addEventListener('change', async () => {
      const val = parseFloat(modalParkedCostInput.value);
      if (!isNaN(val) && val >= 0 && parkedDays[key] !== undefined){
        parkedDays[key] = val;
        await saveParkedDays();
        render();
      }
    });
  }

  overlay.querySelectorAll('#modal-chip-row .chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const tag = chip.dataset.tag;
      if (tag === '__clear'){
        comments[key] = '';
        delete travelOverrides[key];
      } else {
        comments[key] = tag;
        document.getElementById('modal-custom-comment').value = '';
        if (getOverrideChecked()) travelOverrides[key] = true; else delete travelOverrides[key];
      }
      // If this day genuinely stopped being a travel day, any parking
      // record for it no longer makes sense — cleared alongside the tag
      // change rather than left as a stale, inconsistent leftover.
	  // Removed next two lines of code as suggested by Claude 12.10.26 to allow saving of oarking cost even if didn't use ticket
      //const stillTravelDay = !weekend && (comments[key] === '' || travelOverrides[key]);
      //if (!stillTravelDay) delete parkedDays[key];
      await saveComments();
      await saveTravelOverrides();
      await saveParkedDays();
      document.body.removeChild(overlay); render();
    });
  });
  document.getElementById('modal-save-btn').addEventListener('click', async () => {
    const val = document.getElementById('modal-custom-comment').value.trim();
    if (val !== ''){
      comments[key] = val;
      if (getOverrideChecked()) travelOverrides[key] = true; else delete travelOverrides[key];
      // Removed next two lines of code as suggested by Claude 12.10.26 to allow saving of oarking cost even if didn't use ticket
	  //const stillTravelDay = !weekend && (comments[key] === '' || travelOverrides[key]);
      //if (!stillTravelDay) delete parkedDays[key];
      await saveComments();
      await saveTravelOverrides();
      await saveParkedDays();
      document.body.removeChild(overlay); render();
    } else {
      document.body.removeChild(overlay);
    }
  });
  document.getElementById('modal-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}

function openCalendarDayDetail(key){
  const d = parseKey(key);
  const todayKeyLocal = fmtKey(new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate()));
  const comment = (comments[key] || '').trim();
  const dayPerf = railPerfCache[key] || {};
  const eligible = isEligibleRailDay(d, todayKeyLocal);
  const hasDelayData = eligible && Object.keys(dayPerf).length > 0;

  const commentHtml = comment ? `
    <div class="rail-col-header">Logged</div>
    <div class="rail-detail-row"><span>${escapeHtml(comment)}</span>${travelOverrides[key] ? '<span style="color:var(--ink-dim);">counted anyway</span>' : ''}</div>
  ` : '';

  const buyHtml = isBuyTicketDay(key, todayKeyLocal) ? `
    <div style="${commentHtml ? 'margin-top:14px;' : ''}">
      <div class="rail-detail-row"><span><span class="cal-dot-buy" style="display:inline-block; margin:0 8px 1px 0;"></span>Buy Ticket</span></div>
    </div>
  ` : '';

  let delayHtml = '';
  if (hasDelayData){
    const amTrains = railTrains.filter(t => t.direction === 'AM').sort((a, b) => a.time.localeCompare(b.time));
    const pmTrains = railTrains.filter(t => t.direction === 'PM').sort((a, b) => a.time.localeCompare(b.time));
    delayHtml = `
      <div style="display:flex; gap:24px;">
        <div style="flex:1;">
          <div class="rail-col-header">Morning</div>
          ${amTrains.length ? railDetailRowsForClaim(amTrains, dayPerf, key, 'AM') : '<div class="rail-detail-row"><span style="color:var(--ink-dim);">None configured</span></div>'}
        </div>
        <div style="flex:1;">
          <div class="rail-col-header">Evening</div>
          ${pmTrains.length ? railDetailRowsForClaim(pmTrains, dayPerf, key, 'PM') : '<div class="rail-detail-row"><span style="color:var(--ink-dim);">None configured</span></div>'}
        </div>
      </div>`;
  }

  const bodyHtml = (commentHtml || buyHtml || delayHtml) ? (commentHtml + buyHtml + delayHtml) : `<div class="sub">Nothing logged for this day.</div>`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>${dateLabel(d)}</h3>
      ${bodyHtml}
      <div class="modal-close" id="cal-day-detail-close-btn" style="margin-top:16px;">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);
  wireClaimHandlers(overlay, () => { document.body.removeChild(overlay); openCalendarDayDetail(key); });
  document.getElementById('cal-day-detail-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}

function openCalendarView(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay cal-overlay';
  overlay.innerHTML = `
    <div class="modal cal-modal">
      <div class="cal-nav">
        <div class="cal-nav-btn" id="cal-prev">&#8249;</div>
        <div class="cal-nav-title" id="cal-title"></div>
        <div class="cal-nav-btn" id="cal-next">&#8250;</div>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
      <div class="modal-close" id="cal-close-btn" style="margin-top:16px;">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const realToday = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const todayKeyLocal = fmtKey(realToday);
  let viewYear = realToday.getFullYear();
  let viewMonth = realToday.getMonth(); // 0-indexed

  const weekdayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  function drawMonth(){
    const title = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    document.getElementById('cal-title').textContent = title;

    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    // Monday-first offset: JS getDay() is 0=Sun..6=Sat, shift so Mon=0..Sun=6
    const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;

    // Projected "Buy Ticket" days for this month, from the same
    // computeStates() buyFlag that drives the main list's Buy Ticket line.
    // Only today onwards — same rule as findNextBuyDateKey(), and past
    // days have no live reminder to show.
    const buyStates = computeStates(new Date(viewYear, viewMonth + 1, 0));

    let cells = weekdayLabels.map(w => `<div class="cal-weekday">${w}</div>`).join('');
    for (let i = 0; i < leadingBlanks; i++){
      cells += `<div class="cal-day empty"></div>`;
    }
    for (let day = 1; day <= daysInMonth; day++){
      const d = new Date(viewYear, viewMonth, day);
      const key = fmtKey(d);
      const weekend = isWeekend(d);
      const isToday = key === todayKeyLocal;
      const hasEntry = !!(comments[key] || '').trim();
      let delayStatus = null;
      if (isEligibleRailDay(d, todayKeyLocal)){
        delayStatus = getDelayStatus(key);
      }
      const delayDotHtml = delayStatus === 'confirmed' ? '<span class="cal-dot-confirmed"></span>'
        : delayStatus === 'maybe' ? '<span class="cal-dot-delay"></span>'
        : delayStatus === 'declined' ? '<span class="cal-dot-declined"></span>'
        : '';
      const isBuyDay = key >= todayKeyLocal && !!(buyStates[key] && buyStates[key].buyFlag);
      const dots = (hasEntry || isBuyDay || delayStatus)
        ? `<span class="cal-dot-row">${hasEntry ? '<span class="cal-dot"></span>' : ''}${isBuyDay ? '<span class="cal-dot-buy"></span>' : ''}${delayDotHtml}</span>`
        : '';
      cells += `<div class="cal-day ${weekend ? 'weekend' : ''} ${isToday ? 'today' : ''}" data-key="${key}">
        <span>${day}</span>${dots}
      </div>`;
    }
    document.getElementById('cal-grid').innerHTML = cells;

    document.querySelectorAll('#cal-grid .cal-day[data-key]').forEach(cell => {
      cell.style.cursor = 'pointer';
      cell.addEventListener('click', () => openCalendarDayDetail(cell.dataset.key));
    });
  }

  document.getElementById('cal-prev').addEventListener('click', () => {
    viewMonth -= 1;
    if (viewMonth < 0){ viewMonth = 11; viewYear -= 1; }
    drawMonth();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    viewMonth += 1;
    if (viewMonth > 11){ viewMonth = 0; viewYear += 1; }
    drawMonth();
  });
  document.getElementById('cal-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });

  drawMonth();
}
