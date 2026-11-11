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

Page-frame behaviour (the reason it exists): going into a page and back out should look and feel the same everywhere. Back arrow top-left returns to wherever the page was opened from. Save, when the page has something to save, is top-right. No "← Back" or "Cancel" text links at the bottom; no bottom Save button.

The first stage-2 use of `.ui-page` must check its `z-index` (60) against the bottom nav (55) and the other overlays, and adjust here if needed.

## Icons

Line SVGs only, 2px stroke, `currentColor`, in the style of `NAV_ICONS` (`js/config.js`) and `SETTINGS_ICONS` (`js/settings.js`). **No emoji in the interface.** Exempt: the seasonal easter eggs (`js/easter-eggs.js`, the Christmas header and bunting).

## Status

Stage 1 (tokens, parts, this guide) is in. **Nothing uses the parts yet.** Older screens still carry their own inline styles and about 20 odd font sizes; they move onto the parts as they are reworked — Settings (stage 2), Home (stage 3), then the rest. Until a screen is converted, do not "tidy" it piecemeal; convert it whole, on its own release.

Known leftovers, to clear when their screens are reworked: `#ff8b7e` and `#7fc9e8` still appear as literals in JS inline styles and SVG attributes (use `--salmon` / `--holiday` in new work); emoji in the buy banner and the holiday card (both are replaced in stage 3).

Spec and decisions: `claude/facelift-spec.md` in the Project.
