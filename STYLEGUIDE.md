# STYLEGUIDE — ticket tracker PWA

**Read this before writing any new styling or screen.** It exists because earlier sessions each styled screens in place, so the app drifted. Every new or reworked screen follows these rules so it looks like the rest.

The repo is public: design rules only, never secrets.

The tone is **business-like**: calm, dense with information, no playful touches outside the seasonal easter eggs. The look is the existing dark navy and amber palette and the font the phone already uses. Do not change either without Wayne asking.

Files: tokens and shared parts are in `css/design.css` (loaded before `css/app.css`). The colour palette is in `css/app.css` `:root`.

## The rule

**If a shared part covers it, use the part. No inline `style="…"` for anything a part or token covers.** Inline styles are for genuinely one-off values only (a computed width on a progress segment, say). If you find yourself repeating an inline style, it belongs in `css/design.css` as a part, and in this file.

## Tokens

**Colour** (`css/app.css` `:root`)

| Token | Use |
|---|---|
| `--board`, `--board-2`, `--tile` | page background, card background, raised/inset surface |
| `--ink`, `--ink-dim` | main text, secondary text |
| `--line` | borders and dividers |
| `--amber` | **action needed, or selected/active.** Not decoration. |
| `--good` | good news (on time, saved money) |
| `--salmon` | a claim or problem, including small text |
| `--danger` | hard errors and Expired. Too dark for small text on cards (about 4.4:1); use `--salmon` for small problem text. |
| `--holiday` | the holiday countdown, nothing else |

**Type** (`css/design.css`) — six sizes only. Do not add half-pixel or in-between sizes.

| Token | Size | Use |
|---|---|---|
| `--fs-label` | 11px | uppercase labels (`.ui-label`) |
| `--fs-small` | 13px | secondary text, help text, links, pills |
| `--fs-body` | 15px | normal text, row labels, inputs, buttons |
| `--fs-title` | 20px | screen titles, medium figures |
| `--fs-large` | 32px | train time, large money figure |
| `--fs-hero` | 44px | the two Home hero figures (tickets left, next buy date) |

Weights: 400 normal, 600 for links, 700 for labels, figures and buttons. Times and money use `.ui-num` (or the figure part, which has it) for fixed-width digits.

**Radii** — three: `--radius-sm` 8px (buttons, inputs, day cells), `--radius-md` 12px (cards, list groups), `--radius-pill` (pills, chips, circles).

**Spacing** — multiples of 4 (`--space-1` … `--space-5`). `--margin` (16px) is the screen edge margin: every card, strip and row aligns to it. Check this on every screen; a strip that runs off one edge looks wrong.

**Touch targets** — at least `--tap` (44px) tall. Small visible controls get a 44px hit area.

**Contrast** — text at least 4.5:1 against its background, including the small dim labels.

## Shared parts

All prefixed `ui-`, all in `css/design.css`.

| Part | Classes | Use |
|---|---|---|
| Card | `.ui-card` (`.ui-card-flush` for no padding) | any grouped content |
| Section header | `.ui-section-head` containing `.ui-label` and optionally `.ui-link` | label on the left, link on the right ("Details", "Month view") |
| List row | `.ui-row` with `.ui-row-label`, `.ui-row-value`, `.ui-row-chev` inside a `.ui-card.ui-card-flush` | a row that opens another page; shows its current value |
| Switch row | `.ui-row.ui-row-switch` with a `button.ui-switch[role=switch][aria-checked]` | an on/off setting flipped in place |
| Buttons | `.ui-btn-primary` (amber, the one main action), `.ui-btn-secondary` | primary: Save, Yes. Secondary: everything else. |
| Figure | `.ui-figure` with `.ui-figure-label`, `.ui-figure-value` (`.ui-figure-large`, `.ui-figure-hero`), `.ui-figure-note` | a labelled number |
| Status pill | `.ui-pill` plus `-good`, `-warn`, `-bad` or `-info` | On time, Delayed, Cancelled, Claim available |
| Form field | `.ui-field` with `.ui-field-label`, `.ui-input`, `.ui-field-help` | a labelled input with its help text |
| Page frame | `.ui-page` with `.ui-page-bar` holding `.ui-page-back`, `.ui-page-title` and optionally `.ui-btn-primary.ui-page-save` | every full-screen page: back arrow top-left, title, **Save top-right** |
| Bottom sheet | `.ui-sheet-overlay` > `.ui-sheet` with `.ui-sheet-bar`, `.ui-sheet-body`, `.ui-sheet-sub`, `.ui-sheet-actions`; build with `uiOpenSheet()` | a quick edit or choice about one thing (the day editor): close icon top-right, action buttons at the bottom |
| Form controls | any `input`, `select`, `textarea` inside `.ui-page-body` or `.ui-sheet` is styled automatically; `.ui-subhead` heads a group; `.ui-check` (build with `uiCheck()`) for a checkbox row; `.ui-inline` for an input with a label or link beside it (`.ui-input-short` for a short number); `.ui-subcard` and `.ui-stack` to group | every form; never hand-style an input |
| Text action | `.ui-link` (amber) or `.ui-link.ui-link-dim` | Add another…, Remove, Clear |
| Chips | `.ui-chips` > `button.ui-chip` (`.is-selected`) | selectable tags (WFH, HOLIDAY…) |
| Segmented switch | `.ui-segmented` > `button` (`.is-selected`) | two or three views of one screen |
| Notice | `.ui-notice` plus `-info`, `-warn`, `-good` or `-bad` | a tinted note or error box |
| Data rows | `.ui-data-row` with `.ui-data-row-main`, `.ui-data-row-sub`, `.ui-data-row-value`; `.ui-data-table` for small tables | lists of records |
| Empty state | `.ui-empty` | "nothing here yet" |
| Station picker | `.ui-picker` (built by `createStationPicker`) | station name or code |
| Spacing helpers | `.ui-gap-top`, `.ui-gap-top-sm`, `.ui-dim` | instead of inline margins and colours |

Colour exception (Wayne, 2026-11-12): in the week strip the ticket number under the date is amber, so "30" and "5" don't read as "305"; purchase days are a full amber cell with the number on a dark pill. Don't "correct" these to the amber-for-actions rule.

Frame rule (stage 4): a place you go and work in is a page (`.ui-page`); a quick edit about one thing is a bottom sheet (`.ui-sheet`). `.ui-sheet-overlay` sits at z-index 65, above pages and the bottom nav. Inside a page or sheet, the `hidden` attribute always hides an element. `tools/check.sh` prints how many inline styles each file still has.

Page-frame behaviour (the reason it exists): going into a page and back out should look and feel the same everywhere. Back arrow top-left returns to wherever the page was opened from. Save, when the page has something to save, is top-right. No "← Back" or "Cancel" text links at the bottom; no bottom Save button.

`.ui-page` sits at `z-index` 60: above the bottom nav (55) and other overlays (50), below toasts (300). Checked in stage 2; keep it that way.

## Icons

Line SVGs only, 2px stroke, `currentColor`, in the style of `NAV_ICONS` (`js/config.js`). **No emoji in the interface.** Exempt: the seasonal easter eggs (`js/easter-eggs.js`, the Christmas header and bunting).

## Status

Stage 1 (tokens, parts, this guide) is in. Stage 3 (Home, Month view and Money details) is in. Stage 4 (2026-11-12) added the sheet, form and list parts above, converted the Settings sub-page interiors and the day editor, and deleted the unused old Home CSS. Next: Live (stage 5), Buy and money (6), Delay repay (7), reports (8) — see `claude/facelift-rollout-spec.md`. Stage 2 (Settings) uses them: the Settings list and the frame, title bar and back button of all ten sub-pages (`js/ui-parts.js`). Older screens still carry their own inline styles and about 20 odd font sizes; they move onto the parts as they are reworked — Settings (stage 2), Home (stage 3, done), then the rest. Until a screen is converted, do not "tidy" it piecemeal; convert it whole, on its own release.

Known leftovers, to clear when their screens are reworked: `#ff8b7e` and `#7fc9e8` still appear as literals in JS inline styles and SVG attributes (use `--salmon` / `--holiday` in new work); the old Home styles were deleted in stage 4.

Spec and decisions: `claude/facelift-spec.md` in the Project.
