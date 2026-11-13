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
  // Facelift stage 6 (2026-11-13): a full-screen page. Opened from Money
  // details, it stacks over that page and the back arrow returns to it.
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';

  function buildListHtml(){
    const sorted = [...purchases].sort((a, b) => a.date < b.date ? 1 : -1); // newest first
    if (sorted.length === 0){
      return `<div class="ui-empty">No purchases logged yet.</div>`;
    }
    return `<div class="ui-card ui-card-flush ui-data-list">${sorted.map(p => `
      <div class="ui-data-row">
        <span class="ui-data-row-main">${dateLabelShort(parseKey(p.date))}${p.type === 'single' ? ' <span class="ui-dim">(single)</span>' : ''}</span>
        <span class="ui-data-row-value">£${p.cost.toFixed(2)}</span>
        <span class="ui-link ui-link-dim ui-inline-action" role="button" data-del-date="${p.date}" data-del-type="${p.type || 'season'}">Remove</span>
      </div>`).join('')}</div>`;
  }

  overlay.innerHTML = `
    ${uiPageBar('Ticket purchases', { backId: 'purchases-close-btn', backLabel: 'Back' })}
    <div class="ui-page-body">
      <div class="sub">Every ticket you buy via the Buy screen is logged here automatically. Add past ones below to backfill this year's total.</div>
      <div id="purchases-list">${buildListHtml()}</div>

      <div class="ui-subhead">Add a past purchase</div>
      <div class="ui-card">
        <div class="ui-field">
          <label class="ui-field-label" for="backfill-date-input">Ticket start date</label>
          <input type="date" id="backfill-date-input" />
        </div>
        <div class="ui-field">
          <label class="ui-field-label" for="backfill-cost-input">Cost (£)</label>
          <input type="number" inputmode="decimal" id="backfill-cost-input" placeholder="Cost (£)" step="0.01" min="0" value="${lastKnownPrice.toFixed(2)}" />
        </div>
        <button type="button" class="ui-btn-secondary ui-btn-block ui-gap-top" id="backfill-add-btn">Add purchase</button>
      </div>

      <div class="ui-subhead">Import</div>
      <div class="ui-card">
        <div class="ui-field">
          <label class="ui-field-label" for="purchases-import-textarea">Bulk-import as JSON</label>
          <textarea id="purchases-import-textarea" class="ui-code" rows="4" placeholder='[{"date":"2026-01-13","cost":153.60}, ...]'></textarea>
          <div class="ui-field-help" id="purchases-import-status"></div>
        </div>
        <button type="button" class="ui-btn-secondary ui-btn-block ui-gap-top" id="purchases-import-btn">Import list</button>
      </div>
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
    overlay.remove();
  });
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

  // Facelift stage 6 (2026-11-13): a full-screen page with Save top-right
  // and a Season / Single switch. Same ids and the same save logic.
  const overlay = document.createElement('div');
  overlay.className = 'ui-page';
  overlay.innerHTML = `
    ${uiPageBar('Buy tickets', { backId: 'buy-close-btn', backLabel: 'Back', saveId: 'buy-save-btn' })}
    <div class="ui-page-body">
      <div class="ui-segmented">
        <button type="button" class="${buyType==='season'?'is-selected':''}" data-buy-type="season">Season ticket</button>
        <button type="button" class="${buyType==='single'?'is-selected':''}" data-buy-type="single">Single ticket</button>
      </div>

      <div class="ui-notice ui-gap-top" id="advisor-note" hidden></div>

      <div class="ui-notice ui-notice-info ui-gap-top" id="fare-update-banner" hidden>
        <div id="fare-update-text"></div>
        <div class="ui-sheet-actions">
          <button type="button" class="ui-btn-secondary" id="fare-update-decline">Keep mine</button>
          <button type="button" class="ui-btn-primary" id="fare-update-accept">Use these prices</button>
        </div>
      </div>

      <div id="buy-season-fields" class="ui-gap-top"${buyType==='season'?'':' hidden'}>
        <div class="sub">Every time you buy a new ticket, set the date it starts. Your 8 uses and 28-day window will be tracked fresh from that date.</div>
        <div class="ui-card">
          <div class="ui-field">
            <label class="ui-field-label" for="season-date-input">Start date</label>
            <input type="date" id="season-date-input" value="${suggested}" />
          </div>
          <div class="ui-field">
            <label class="ui-field-label" for="season-cost-input">Cost of this ticket (£)</label>
            <input type="number" inputmode="decimal" id="season-cost-input" value="${lastKnownPrice.toFixed(2)}" step="0.01" min="0" />
          </div>
          <div class="ui-field">
            <label class="ui-field-label" for="season-bought-input">Bought on</label>
            <input type="date" id="season-bought-input" value="${fmtKey(today)}" />
          </div>
        </div>
      </div>

      <div id="buy-single-fields" class="ui-gap-top"${buyType==='single'?'':' hidden'}>
        <div class="sub">For a day return bought instead of using your season ticket — doesn't affect your 8-use/28-day tracking, just logs the cost and marks that day as covered.</div>
        <div class="ui-card">
          <div class="ui-field">
            <label class="ui-field-label" for="single-date-input">Date this ticket is for</label>
            <input type="date" id="single-date-input" value="${suggested}" />
          </div>
          <div class="ui-field">
            <label class="ui-field-label" for="single-cost-input">Cost (£)</label>
            <input type="number" inputmode="decimal" id="single-cost-input" value="${dayReturnPrice.toFixed(2)}" step="0.01" min="0" />
          </div>
        </div>
      </div>
      <div class="ui-field-help ui-gap-top" id="buy-save-hint">${buyType==='season' ? 'Save sets this as your new ticket start.' : 'Save logs this single ticket.'}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Leaving Buy (back arrow or Save) returns to Home with the Home tab lit,
  // since this page sits over the bottom nav.
  function leave(){
    if (overlay.isConnected) overlay.remove();
    if (state.activeTab === 'buy') state.activeTab = 'today';
    render();
  }

  // Always reflects the season-vs-singles comparison, regardless of which
  // tab is currently active — it's relevant either way, since it's really
  // answering "which of these two should I be doing", not a season-only
  // detail. Reads from the season fields even while that block is hidden;
  // the inputs still exist in the DOM and keep their values.
  function updateAdvisor(){
    const startVal = document.getElementById('season-date-input').value;
    const costVal = parseFloat(document.getElementById('season-cost-input').value);
    const note = document.getElementById('advisor-note');
    if (!startVal || isNaN(costVal)){ note.hidden = true; return; }
    const info = computeAdvisorInfo(startVal, costVal);
    note.hidden = false;
    note.classList.toggle('ui-notice-bad', info.recommendSingles);
    note.classList.toggle('ui-notice-good', !info.recommendSingles);
    if (info.recommendSingles){
      note.innerHTML = `Based on days already planned, you're likely to need ~${info.estDays} travel day${info.estDays===1?'':'s'} in this window. At £${dayReturnPrice.toFixed(2)} a day return, singles would cost £${info.singlesCost.toFixed(2)} vs £${costVal.toFixed(2)} for this ticket — singles may be cheaper this time.`;
    } else {
      note.innerHTML = `Based on days already planned, you're likely to need ~${info.estDays} travel day${info.estDays===1?'':'s'} in this window. The season ticket looks like the better value (£${costVal.toFixed(2)} vs £${info.singlesCost.toFixed(2)} for singles).`;
    }
  }

  function switchType(newType){
    buyType = newType;
    overlay.querySelectorAll('[data-buy-type]').forEach(btn => {
      btn.classList.toggle('is-selected', btn.dataset.buyType === buyType);
    });
    document.getElementById('buy-season-fields').hidden = buyType !== 'season';
    document.getElementById('buy-single-fields').hidden = buyType !== 'single';
    document.getElementById('buy-save-hint').textContent = buyType === 'season' ? 'Save sets this as your new ticket start.' : 'Save logs this single ticket.';
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
      banner.hidden = false;
      document.getElementById('fare-update-accept').addEventListener('click', () => {
        document.getElementById('season-cost-input').value = seasonPrice.toFixed(2);
        document.getElementById('single-cost-input').value = freshDayReturnPrice.toFixed(2);
        banner.hidden = true;
        updateAdvisor();
      });
      document.getElementById('fare-update-decline').addEventListener('click', () => {
        banner.hidden = true;
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
    leave();
  });
  document.getElementById('buy-close-btn').addEventListener('click', leave);
}
