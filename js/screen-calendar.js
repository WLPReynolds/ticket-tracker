// screen-calendar.js — openDayEditor, Month view (openCalendarView).
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

function openCalendarView(){
  // Month view (facelift stage 3): a full page with the holiday countdown on top,
  // the month grid, and the same day panel as the Home strip underneath.
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `${uiPageBar('Month', { backId: 'cal-close-btn', backLabel: 'Back to Home' })}
    <div class="ui-page-body">
      <div id="cal-countdown"></div>
      <div class="cal-nav">
        <div class="cal-nav-btn" id="cal-prev" role="button" aria-label="Previous month">&#8249;</div>
        <div class="cal-nav-title" id="cal-title"></div>
        <div class="cal-nav-btn" id="cal-next" role="button" aria-label="Next month">&#8250;</div>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
      <div class="ui-card" id="cal-panel" style="margin-top:var(--space-4);"></div>
    </div>`;
  document.body.appendChild(overlay);

  const realToday = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const todayKeyLocal = fmtKey(realToday);
  let viewYear = realToday.getFullYear();
  let viewMonth = realToday.getMonth(); // 0-indexed
  let selectedKey = todayKeyLocal;

  const weekdayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  function drawMonth(){
    const title = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    document.getElementById('cal-title').textContent = title;
    document.getElementById('cal-countdown').innerHTML = homeCountdownCardHtml(realToday);

    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const lastOfMonth = new Date(viewYear, viewMonth + 1, 0);
    const daysInMonth = lastOfMonth.getDate();
    // Monday-first offset: JS getDay() is 0=Sun..6=Sat, shift so Mon=0..Sun=6
    const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;

    // One shared view of the days — the same one the Home strip uses.
    const ctx = homeDayCtx(lastOfMonth);

    let cells = weekdayLabels.map(w => `<div class="cal-weekday">${w}</div>`).join('');
    for (let i = 0; i < leadingBlanks; i++){
      cells += `<div class="cal-day empty"></div>`;
    }
    for (let day = 1; day <= daysInMonth; day++){
      const d = new Date(viewYear, viewMonth, day);
      const key = fmtKey(d);
      const info = homeDayInfo(d, ctx);
      const isBuyDay = key >= todayKeyLocal && !!(ctx.states[key] && ctx.states[key].buyFlag);
      const delayDotHtml = info.delay === 'confirmed' ? '<span class="cal-dot-confirmed"></span>'
        : info.delay === 'maybe' ? '<span class="cal-dot-delay"></span>'
        : info.delay === 'declined' ? '<span class="cal-dot-declined"></span>'
        : '';
      const dots = (info.comment || isBuyDay || info.delay)
        ? `<span class="cal-dot-row">${info.comment ? '<span class="cal-dot"></span>' : ''}${isBuyDay ? '<span class="cal-dot-buy"></span>' : ''}${delayDotHtml}</span>`
        : '';
      cells += `<div class="cal-day ${info.weekend ? 'weekend' : ''} ${info.isToday ? 'today' : ''} ${key === selectedKey ? 'selected' : ''}" data-key="${key}">
        <span>${day}</span>${dots}
      </div>`;
    }
    document.getElementById('cal-grid').innerHTML = cells;

    document.querySelectorAll('#cal-grid .cal-day[data-key]').forEach(cell => {
      cell.style.cursor = 'pointer';
      cell.addEventListener('click', () => { selectedKey = cell.dataset.key; drawMonth(); });
    });

    const panel = document.getElementById('cal-panel');
    panel.innerHTML = homeBuildDayPanel(selectedKey, ctx);
    homeWireDayPanel(panel);
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
    homePageRefresh = null;
    overlay.remove();
    state.activeTab = 'today'; // the Calendar tab opened this page; Home is what is underneath
    render();
  });

  homePageRefresh = drawMonth; // render() calls this after an edit so the page stays current
  drawMonth();
}
