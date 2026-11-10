// stations.js — Station list, station index, createStationPicker.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// ---- Station reference data (name, CRS code, coordinates) ----
// Station names, codes, and locations change almost never, so rather
// than asking for this on every visit, it's fetched once from a public
// dataset and cached in localStorage indefinitely. "Refresh" (in the
// station picker UI below) re-pulls it on demand, for the rare case a
// brand new station doesn't resolve yet. Served via jsDelivr rather
// than hitting the source GitHub repo directly — jsDelivr keeps a
// permanent cached copy of whatever it's first served, so this keeps
// working even if that small repo is ever renamed or taken down.
//
// v2 swaps in a richer dataset (adds lat/lon alongside name+CRS, in a
// single CSV) so the same lookup that powers the station picker can
// also drive the live-progress weather feature below, rather than
// maintaining two separate station lists that both need to agree on
// CRS codes.
const STATION_LIST_KEY = 'station-list-v2';
const STATION_LIST_URL = 'https://cdn.jsdelivr.net/gh/ellcom/UK-Train-Station-Locations@master/uk-train-stations.csv';

let stationIndexCache = null; // { byCrs: Map, list: [{name,crs,lat,lon}], fetchedAt } — built once per page load

function getCachedStationList(){
  try{
    const raw = localStorage.getItem(STATION_LIST_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

// Minimal RFC4180-ish CSV line parser — just enough to handle the
// quoted-name, bare-number shape this particular file uses (no
// multi-line quoted fields, which this dataset doesn't have).
function parseCsvLine(line){
  const fields = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++){
    const ch = line[i];
    if (inQuotes){
      if (ch === '"'){
        if (line[i+1] === '"'){ cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ','){ fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseStationCsv(text){
  const lines = text.split('\n').filter(l => l.trim().length);
  const entries = [];
  // First line is the header ("3alpha","station_name","latitude","longitude") — skip it.
  for (let i = 1; i < lines.length; i++){
    const [crs, rawName, lat, lon] = parseCsvLine(lines[i]);
    const latNum = parseFloat(lat), lonNum = parseFloat(lon);
    if (!crs || !rawName || isNaN(latNum) || isNaN(lonNum)) continue;
    // This dataset suffixes every entry with "Rail Station" (e.g. "Wigan
    // North Western Rail Station") — stripped here to match the plain
    // names already shown throughout the app (station boards, calling
    // points, the picker itself).
    const name = rawName.replace(/\s+Rail Station$/i, '').trim();
    entries.push({ crs, name, lat: latNum, lon: lonNum });
  }
  return entries;
}

function buildStationIndex(entries, fetchedAt){
  const byCrs = new Map();
  const list = [];
  entries.forEach(e => {
    const name = e.name, crs = (e.crs || '').toUpperCase();
    if (!name || crs.length !== 3) return;
    const record = { name, crs, lat: e.lat, lon: e.lon };
    byCrs.set(crs, record);
    list.push(record);
  });
  list.sort((a,b) => a.name.localeCompare(b.name));
  return { byCrs, list, fetchedAt };
}

// Instant from localStorage once cached; only hits the network the
// first time ever, or when force is true (the manual refresh control).
async function loadStationIndex(force){
  if (!force && stationIndexCache) return stationIndexCache;
  if (!force){
    const cached = getCachedStationList();
    if (cached && Array.isArray(cached.entries) && cached.entries.length){
      stationIndexCache = buildStationIndex(cached.entries, cached.fetchedAt);
      return stationIndexCache;
    }
  }
  const resp = await fetch(STATION_LIST_URL);
  if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
  const text = await resp.text();
  const entries = parseStationCsv(text);
  if (!entries.length) throw new Error('came back empty');
  const fetchedAt = new Date().toISOString();
  try{ localStorage.setItem(STATION_LIST_KEY, JSON.stringify({ entries, fetchedAt })); }
  catch(e){ /* storage full — still usable for this session */ }
  stationIndexCache = buildStationIndex(entries, fetchedAt);
  return stationIndexCache;
}

function stationNameForCrs(crs){
  const c = (crs || '').toUpperCase();
  const rec = stationIndexCache && stationIndexCache.byCrs.get(c);
  return rec ? rec.name : null;
}

function stationCoordsForCrs(crs){
  const c = (crs || '').toUpperCase();
  const rec = stationIndexCache && stationIndexCache.byCrs.get(c);
  return rec ? { lat: rec.lat, lon: rec.lon } : null;
}

// A text input that accepts either a station name or a 3-letter CRS
// code, with a live filtered dropdown, and always resolves to a
// { code, name } pair. Falls back to a bare code (name left
// unresolved) for a station not yet in the cached list — e.g. a
// genuinely brand-new one — rather than blocking the search.
function createStationPicker(opts){
  const onChange = (opts && opts.onChange) || function(){};
  const placeholder = (opts && opts.placeholder) || 'Station name or code';
  const initialCode = opts && opts.initialCode;
  const initialName = opts && opts.initialName;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative; flex:1;';
  const initialValue = initialCode ? (initialName ? `${initialName} (${initialCode})` : initialCode) : '';
  wrap.innerHTML = `
    <input type="text" class="station-picker-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(initialValue)}"
      style="width:100%; padding:10px 32px 10px 10px; border-radius:8px; border:1px solid var(--line); background:var(--tile); color:var(--ink); box-sizing:border-box;" />
    <span class="station-picker-clear" style="display:${initialValue ? 'flex' : 'none'}; position:absolute; right:6px; top:0; bottom:0; width:22px; align-items:center; justify-content:center; cursor:pointer; color:var(--ink-dim); font-size:15px; -webkit-user-select:none; user-select:none; touch-action:manipulation;">✕</span>
    <div class="station-picker-dropdown" style="display:none; position:absolute; left:0; right:0; top:100%; margin-top:4px; background:var(--board-2); border:1px solid var(--line); border-radius:8px; max-height:220px; overflow-y:auto; z-index:20;"></div>
  `;
  const input = wrap.querySelector('.station-picker-input');
  const dropdown = wrap.querySelector('.station-picker-dropdown');
  const clearBtn = wrap.querySelector('.station-picker-clear');
  let selected = initialCode ? { code: initialCode.toUpperCase(), name: initialName || null } : { code: null, name: null };

  function closeDropdown(){ dropdown.style.display = 'none'; dropdown.innerHTML = ''; }
  function updateClearVisibility(){ clearBtn.style.display = input.value ? 'flex' : 'none'; }

  function pick(entry){
    selected = { code: entry.crs, name: entry.name };
    input.value = `${entry.name} (${entry.crs})`;
    closeDropdown();
    updateClearVisibility();
    onChange(selected.code, selected.name);
  }

  function clear(){
    selected = { code: null, name: null };
    input.value = '';
    updateClearVisibility();
    closeDropdown();
    onChange(null, null);
  }
  // mousedown, not click — same reasoning as the dropdown options: fires
  // before the input's blur handler would otherwise run first.
  clearBtn.addEventListener('mousedown', (e) => { e.preventDefault(); clear(); });

  function renderMatches(q){
    const idx = stationIndexCache;
    const query = (q || '').trim();
    if (!idx || !query){ closeDropdown(); return; }
    const lowerQ = query.toLowerCase();
    const upperQ = query.toUpperCase();
    let matches = idx.list.filter(e => e.name.toLowerCase().includes(lowerQ) || e.crs === upperQ);
    matches.sort((a,b) => {
      const aExact = a.crs === upperQ ? 0 : 1, bExact = b.crs === upperQ ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aStarts = a.name.toLowerCase().startsWith(lowerQ) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(lowerQ) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.name.localeCompare(b.name);
    });
    matches = matches.slice(0, 8);
    if (!matches.length){
      if (/^[A-Z]{3}$/.test(upperQ)){
        dropdown.innerHTML = `<div style="padding:10px 12px; font-size:12.5px; color:var(--ink-dim);">Not in the station list — will be used as typed: <strong style="color:var(--ink);">${escapeHtml(upperQ)}</strong></div>`;
        dropdown.style.display = 'block';
      } else {
        closeDropdown();
      }
      return;
    }
    dropdown.innerHTML = matches.map(m => `
      <div class="station-picker-option" data-crs="${m.crs}" style="padding:10px 12px; cursor:pointer; border-bottom:1px solid var(--line); -webkit-user-select:none; user-select:none;">
        <span style="color:var(--ink);">${escapeHtml(m.name)}</span>
        <span style="color:var(--ink-dim); float:right;">${m.crs}</span>
      </div>
    `).join('');
    dropdown.style.display = 'block';
    dropdown.querySelectorAll('.station-picker-option').forEach(el => {
      // mousedown, not click — fires before the input's own blur handler
      // would otherwise close the dropdown first and swallow the tap.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const entry = matches.find(m => m.crs === el.dataset.crs);
        if (entry) pick(entry);
      });
    });
  }

  input.addEventListener('input', () => {
    selected = { code: null, name: null }; // typing invalidates the old selection until re-confirmed
    updateClearVisibility();
    renderMatches(input.value);
  });
  input.addEventListener('focus', () => { if (input.value) renderMatches(input.value); });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      closeDropdown();
      if (selected.code) return; // already resolved via a dropdown pick
      const raw = input.value.trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(raw)){
        const name = stationNameForCrs(raw);
        selected = { code: raw, name };
        input.value = name ? `${name} (${raw})` : raw;
        updateClearVisibility();
        onChange(raw, name);
      } else if (raw === ''){
        selected = { code: null, name: null };
        updateClearVisibility();
        onChange(null, null);
      }
      // else: unresolved free text left as typed — no valid selection
      // until it's fixed, same as leaving a required field blank.
    }, 150);
  });

  return {
    el: wrap,
    getCode: () => selected.code,
    getName: () => selected.name,
    clear
  };
}
