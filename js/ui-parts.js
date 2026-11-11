// ui-parts.js — small HTML builders for the shared ui- parts in css/design.css.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.
// Read STYLEGUIDE.md before adding a screen: these builders exist so a screen never hand-writes
// the page frame, list rows or switches. Declarations only — nothing runs at load.

const UI_ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const UI_ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

// The page frame's top bar: back arrow top-left, title, optional Save top-right.
// opts: { backId, backLabel, saveId, saveLabel }. Put the result at the top of an
// element with class "ui-page", then the content in a .ui-page-body (form pages)
// or .ui-page-list (grouped lists).
function uiPageBar(title, opts){
  const o = opts || {};
  const save = o.saveId ? `<button type="button" class="ui-btn-primary ui-page-save" id="${o.saveId}">${o.saveLabel || 'Save'}</button>` : '';
  return `<div class="ui-page-bar"><button type="button" class="ui-page-back" id="${o.backId}" aria-label="${escapeHtml(o.backLabel || 'Back')}">${UI_ICON_BACK}</button><div class="ui-page-title">${escapeHtml(title)}</div>${save}</div>`;
}

// A section header (label, optional link) followed by a card of rows.
function uiGroup(title, rowsHtml){
  return `<div class="ui-section-head"><div class="ui-label">${escapeHtml(title)}</div></div><div class="ui-card ui-card-flush">${rowsHtml.join('')}</div>`;
}

// A row that opens a page, showing its current value on the right.
function uiRow(id, label, value){
  const v = value ? `<span class="ui-row-value">${escapeHtml(value)}</span>` : '';
  return `<div class="ui-row" id="${id}" role="button" tabindex="0"><span class="ui-row-label">${escapeHtml(label)}</span>${v}<span class="ui-row-chev">${UI_ICON_CHEV}</span></div>`;
}

// A row with an on/off switch. The id is on the switch button.
function uiSwitchRow(id, label, on){
  return `<div class="ui-row ui-row-switch"><span class="ui-row-label">${escapeHtml(label)}</span><button type="button" class="ui-switch" id="${id}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${escapeHtml(label)}"></button></div>`;
}

function uiSetSwitch(id, on){
  const el = document.getElementById(id);
  if (el) el.setAttribute('aria-checked', on ? 'true' : 'false');
}
