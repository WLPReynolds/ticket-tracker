// buy.js — Buy screen, purchases manager, fares check.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.
// True only on/after this year's fare change AND only if this year
// hasn't already been checked — stays instant every other time the Buy
// screen opens, which is the whole point (see backlog discussion: the
// one-a-year network delay only matters right when it's worth paying
// for it).
function shouldFetchFreshFares(today){
  const year = today.getFullYear();
  const changeDate = getFirstSundayOfMarch(year);
  if (today < changeDate) return false;
  return fareCheckedYear !== year;
}

function openManagePurchases(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  function buildListHtml(){
    const sorted = [...purchases].sort((a, b) => a.date < b.date ? 1 : -1); // newest first
    if (sorted.length === 0){
      return `<div class="sub">No purchases logged yet.</div>`;
    }
    return sorted.map(p => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);">
        <span>${dateLabelShort(parseKey(p.date))} — £${p.cost.toFixed(2)}${p.type === 'single' ? ' <span style="color:var(--ink-dim); font-size:12px;">(single)</span>' : ''}</span>
        <span class="modal-close" data-del-date="${p.date}" data-del-type="${p.type || 'season'}" style="margin:0; font-size:13px;">Remove</span>
      </div>`).join('');
  }

  overlay.innerHTML = `
    <div class="modal">
      <h3>Ticket purchases</h3>
      <div class="sub">Every ticket you buy via "Set ticket start date" is logged here automatically. Add past ones below to backfill this year's total.</div>
      <div id="purchases-list" style="margin:12px 0; max-height:220px; overflow-y:auto;">${buildListHtml()}</div>
      <label style="display:block; font-size:13px; color:var(--ink-dim); margin-bottom:6px;">Add a past purchase</label>
      <input type="date" id="backfill-date-input" style="margin-bottom:8px;" />
      <input type="number" id="backfill-cost-input" placeholder="Cost (£)" step="0.01" min="0" value="${lastKnownPrice.toFixed(2)}" style="margin-bottom:12px;" />
      <button class="save-btn" id="backfill-add-btn">Add purchase</button>

      <label style="display:block; font-size:13px; color:var(--ink-dim); margin:16px 0 6px;">Or bulk-import as JSON</label>
      <textarea id="purchases-import-textarea" rows="4" style="width:100%; background:var(--tile); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:10px; font-family:'Courier New',monospace; font-size:13px; margin-bottom:8px;" placeholder='[{"date":"2026-01-13","cost":153.60}, ...]'></textarea>
      <div id="purchases-import-status" style="font-size:13px; color:var(--ink-dim); margin-bottom:10px;"></div>
      <button class="save-btn" id="purchases-import-btn">Import list</button>

      <div class="modal-close" id="purchases-close-btn">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);

  function refreshList(){
    document.getElementById('purchases-list').innerHTML = buildListHtml();
    overlay.querySelectorAll('[data-del-date]').forEach(el => {
      el.addEventListener('click', async () => {
        const delType = el.dataset.delType === 'single' ? 'single' : undefined;
        purchases = purchases.filter(p => !(p.date === el.dataset.delDate && (p.type || undefined) === delType));
        await savePurchases();
        refreshList();
        render();
      });
    });
  }
  refreshList();

  document.getElementById('backfill-add-btn').addEventListener('click', async () => {
    const dateVal = document.getElementById('backfill-date-input').value;
    const costVal = parseFloat(document.getElementById('backfill-cost-input').value);
    if (dateVal && !isNaN(costVal) && costVal >= 0){
      purchases = purchases.filter(p => !(p.date === dateVal && (p.type || undefined) !== 'single'));
      purchases.push({ date: dateVal, cost: costVal });
      purchases.sort((a, b) => a.date < b.date ? -1 : 1);
      await savePurchases();
      document.getElementById('backfill-date-input').value = '';
      refreshList();
      render();
    }
  });

  document.getElementById('purchases-import-btn').addEventListener('click', async () => {
    const raw = document.getElementById('purchases-import-textarea').value.trim();
    const status = document.getElementById('purchases-import-status');
    if (!raw){ status.textContent = 'Paste some JSON first.'; return; }
    let parsed;
    try{ parsed = JSON.parse(raw); }
    catch(e){ status.textContent = 'That is not valid JSON.'; return; }
    if (!Array.isArray(parsed)){ status.textContent = 'Expected a JSON array of {date, cost} entries.'; return; }
    let added = 0;
    for (const entry of parsed){
      if (entry && typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && typeof entry.cost === 'number'){
        purchases = purchases.filter(p => p.date !== entry.date);
        purchases.push({ date: entry.date, cost: entry.cost });
        added++;
      }
    }
    purchases.sort((a, b) => a.date < b.date ? -1 : 1);
    if (added > 0){
      lastKnownPrice = purchases[purchases.length - 1].cost;
      await savePurchases();
      await saveLastKnownPrice();
    }
    status.textContent = `Imported ${added} purchase${added===1?'':'s'}.`;
    refreshList();
    render();
  });

  document.getElementById('purchases-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}

// Once-a-year live price check (see backlog discussion): only ever
// called on the first Buy screen open on/after the current year's first
// Sunday of March, and only once that year hasn't already been checked
// — so the "no longer instant" network cost lands only at the one
// moment it's actually worth paying for it. Returns the two prices in
// pounds (converting from the Worker's pence figures) or throws.
async function fetchFaresUpdate(){
  const resp = await fetch(FARES_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orig: FARE_CHECK_ORIG, dest: FARE_CHECK_DEST })
  });
  if (!resp.ok) throw new Error(`Fares request failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.reason || 'Fares API returned no usable price');
  return {
    seasonPrice: data.season.pricePence / 100,
    dayReturnPrice: data.dayReturn.pricePence / 100,
  };
}

function openBuyScreen(defaultType){
  const today = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate());
  const suggested = fmtKey(addDays(today, 1));

  // Work out the recommendation up front, using the default suggested
  // date/price, so the screen can open on whichever tab it actually
  // recommends — unless the caller explicitly asked for a specific tab
  // (e.g. the renewal banner asking for 'season' directly), in which
  // case that explicit intent wins over the suggestion.
  function computeAdvisorInfo(startDate, cost){
    const estDays = estimateTravelDaysInWindow(startDate, 28);
    const singlesCost = estDays * dayReturnPrice;
    return { estDays, singlesCost, recommendSingles: singlesCost < cost && estDays < 8 };
  }
  const initialInfo = computeAdvisorInfo(suggested, lastKnownPrice);
  let buyType = defaultType || (initialInfo.recommendSingles ? 'single' : 'season');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Buy tickets</h3>
      <div class="chip-row" style="margin-bottom:14px;">
        <div class="chip ${buyType==='season'?'active':''}" data-buy-type="season">Season ticket</div>
        <div class="chip ${buyType==='single'?'active':''}" data-buy-type="single">Single ticket</div>
      </div>

      <div id="advisor-note" style="font-size:13px; padding:10px 12px; border-radius:8px; margin-bottom:16px;"></div>

      <div id="fare-update-banner" style="display:none; font-size:13px; padding:10px 12px; border-radius:8px; margin-bottom:16px; background:rgba(90,140,224,0.12); border:1px solid rgba(90,140,224,0.35);">
        <div id="fare-update-text" style="margin-bottom:8px;"></div>
        <div style="display:flex; gap:8px;">
          <div class="chip" id="fare-update-accept" style="flex:1; text-align:center;">Use these prices</div>
          <div class="chip" id="fare-update-decline" style="flex:1; text-align:center;">Keep mine</div>
        </div>
      </div>

      <div id="buy-season-fields" style="${buyType==='season'?'':'display:none;'}">
        <div class="sub" style="margin-top:0;">Every time you buy a new ticket, set the date it starts. Your 8 uses and 28-day window will be tracked fresh from that date.</div>
        <label style="display:block; font-size:13px; color:var(--ink-dim); margin-bottom:6px;">Start date</label>
        <input type="date" id="season-date-input" value="${suggested}" style="margin-bottom:12px;" />
        <label style="display:block; font-size:13px; color:var(--ink-dim); margin-bottom:6px;">Cost of this ticket (£)</label>
        <input type="number" id="season-cost-input" value="${lastKnownPrice.toFixed(2)}" step="0.01" min="0" style="margin-bottom:12px;" />
        <label style="display:block; font-size:13px; color:var(--ink-dim); margin-bottom:6px;">Bought on</label>
        <input type="date" id="season-bought-input" value="${fmtKey(today)}" style="margin-bottom:12px;" />
      </div>

      <div id="buy-single-fields" style="${buyType==='single'?'':'display:none;'}">
        <div class="sub" style="margin-top:0;">For a day return bought instead of using your season ticket — doesn't affect your 8-use/28-day tracking, just logs the cost and marks that day as covered.</div>
        <label style="display:block; font-size:13px; color:var(--ink-dim); margin-bottom:6px;">Date this ticket is for</label>
        <input type="date" id="single-date-input" value="${suggested}" style="margin-bottom:12px;" />
        <label style="display:block; font-size:13px; color:var(--ink-dim); margin-bottom:6px;">Cost (£)</label>
        <input type="number" id="single-cost-input" value="${dayReturnPrice.toFixed(2)}" step="0.01" min="0" style="margin-bottom:12px;" />
      </div>

      <button class="save-btn" id="buy-save-btn">${buyType==='season' ? 'Set as new ticket start' : 'Log this ticket'}</button>
      <div class="modal-close" id="buy-close-btn">Cancel</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Always reflects the season-vs-singles comparison, regardless of which
  // tab is currently active — it's relevant either way, since it's really
  // answering "which of these two should I be doing", not a season-only
  // detail. Reads from the season fields even while that block is hidden;
  // the inputs still exist in the DOM and keep their values.
  function updateAdvisor(){
    const startVal = document.getElementById('season-date-input').value;
    const costVal = parseFloat(document.getElementById('season-cost-input').value);
    const note = document.getElementById('advisor-note');
    if (!startVal || isNaN(costVal)){ note.style.display = 'none'; return; }
    const info = computeAdvisorInfo(startVal, costVal);
    note.style.display = 'block';
    if (info.recommendSingles){
      note.style.background = 'rgba(224,90,78,0.12)';
      note.style.border = '1px solid rgba(224,90,78,0.35)';
      note.style.color = '#ff8b7e';
      note.innerHTML = `Based on days already planned, you're likely to need ~${info.estDays} travel day${info.estDays===1?'':'s'} in this window. At £${dayReturnPrice.toFixed(2)} a day return, singles would cost £${info.singlesCost.toFixed(2)} vs £${costVal.toFixed(2)} for this ticket — singles may be cheaper this time.`;
    } else {
      note.style.background = 'rgba(111,191,138,0.1)';
      note.style.border = '1px solid rgba(111,191,138,0.3)';
      note.style.color = 'var(--good)';
      note.innerHTML = `Based on days already planned, you're likely to need ~${info.estDays} travel day${info.estDays===1?'':'s'} in this window. The season ticket looks like the better value (£${costVal.toFixed(2)} vs £${info.singlesCost.toFixed(2)} for singles).`;
    }
  }

  function switchType(newType){
    buyType = newType;
    overlay.querySelectorAll('[data-buy-type]').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.buyType === buyType);
    });
    document.getElementById('buy-season-fields').style.display = buyType === 'season' ? '' : 'none';
    document.getElementById('buy-single-fields').style.display = buyType === 'single' ? '' : 'none';
    document.getElementById('buy-save-btn').textContent = buyType === 'season' ? 'Set as new ticket start' : 'Log this ticket';
  }

  overlay.querySelectorAll('[data-buy-type]').forEach(chip => {
    chip.addEventListener('click', () => { switchType(chip.dataset.buyType); updateAdvisor(); });
  });

  document.getElementById('season-date-input').addEventListener('change', updateAdvisor);
  document.getElementById('season-cost-input').addEventListener('input', updateAdvisor);
  updateAdvisor();

  // Once-a-year live price check — see fetchFaresUpdate() above. Fires
  // in the background; the screen itself has already opened instantly
  // either way, so there's nothing to wait on here.
  if (shouldFetchFreshFares(today)){
    fetchFaresUpdate().then(({ seasonPrice, dayReturnPrice: freshDayReturnPrice }) => {
      if (!overlay.isConnected) return; // screen closed before this resolved
      // A successful check — regardless of whether the person ends up
      // accepting the new figures — is what "checked" means here, so
      // this year won't be re-queried on the next Buy screen open.
      fareCheckedYear = today.getFullYear();
      saveFareCheckedYear();
      const seasonChanged = Math.abs(seasonPrice - lastKnownPrice) >= 0.005;
      const dayReturnChanged = Math.abs(freshDayReturnPrice - dayReturnPrice) >= 0.005;
      if (!seasonChanged && !dayReturnChanged) return; // nothing to surface
      const banner = document.getElementById('fare-update-banner');
      document.getElementById('fare-update-text').innerHTML =
        `This year's regulated fares are in. Season ticket: £${seasonPrice.toFixed(2)}` +
        `${seasonChanged ? ` (currently £${lastKnownPrice.toFixed(2)})` : ''}` +
        ` · Day return: £${freshDayReturnPrice.toFixed(2)}` +
        `${dayReturnChanged ? ` (currently £${dayReturnPrice.toFixed(2)})` : ''}. Use the new prices?`;
      banner.style.display = 'block';
      document.getElementById('fare-update-accept').addEventListener('click', () => {
        document.getElementById('season-cost-input').value = seasonPrice.toFixed(2);
        document.getElementById('single-cost-input').value = freshDayReturnPrice.toFixed(2);
        banner.style.display = 'none';
        updateAdvisor();
      });
      document.getElementById('fare-update-decline').addEventListener('click', () => {
        banner.style.display = 'none';
      });
    }).catch(e => {
      // Left unchecked so the next Buy screen open tries again — a
      // transient network failure shouldn't leave this year's price
      // check permanently skipped. Logged rather than surfaced; the
      // screen still works exactly as it always has either way.
      console.error(`Fares update check failed: ${e.message}`);
    });
  }

  document.getElementById('buy-save-btn').addEventListener('click', async () => {
    if (buyType === 'season'){
      const val = document.getElementById('season-date-input').value;
      const costVal = parseFloat(document.getElementById('season-cost-input').value);
      if (!val) return;
      periodStart = val;
      await savePeriodStart();
      if (!isNaN(costVal) && costVal >= 0){
        // 2026-10-06 — purchasedOn from "Bought on" (defaults to today); id is
        // filled in by savePurchases(). Re-saving the same start date keeps the
        // same id ('p-' + start date).
        const boughtVal = document.getElementById('season-bought-input').value;
        const purchasedOn = /^\d{4}-\d{2}-\d{2}$/.test(boughtVal) ? boughtVal : fmtKey(today);
        purchases = purchases.filter(p => !(p.date === val && (p.type || undefined) !== 'single'));
        purchases.push({ date: val, cost: costVal, purchasedOn });
        purchases.sort((a, b) => a.date < b.date ? -1 : 1);
        lastKnownPrice = costVal;
        await savePurchases();
        await saveLastKnownPrice();
      }
    } else {
      const dateVal = document.getElementById('single-date-input').value;
      const costVal = parseFloat(document.getElementById('single-cost-input').value);
      if (!dateVal || isNaN(costVal) || costVal < 0) return;
      purchases = purchases.filter(p => !(p.date === dateVal && p.type === 'single'));
      purchases.push({ date: dateVal, cost: costVal, type: 'single' });
      purchases.sort((a, b) => a.date < b.date ? -1 : 1);
      dayReturnPrice = costVal;
      await savePurchases();
      await saveDayReturnPrice();
    }
    document.body.removeChild(overlay);
    state.activeTab = 'today';
    render();
  });
  document.getElementById('buy-close-btn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}
