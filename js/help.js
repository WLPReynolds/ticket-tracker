// help.js — HELP_GUIDE_MD, the Markdown renderer, Help view.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// ---- Help guide ----
// 2026-09-25: maintained here, against the app itself — the app is the
// source of truth (the earlier Gemini-drafted copy is no longer kept in
// step). {{TOKENS}} are filled from live settings/constants when Help
// opens — see buildHelpGuideMd — so numbers like geofence radii can't go
// stale again. Written as Markdown rather
// than hand-converted to HTML each time it changes — this parser only
// covers the specific subset of Markdown this particular guide actually
// uses (headers, bold, bullet/numbered lists, tables, links, hr), not
// Markdown in general, so a future revision using something outside
// that subset may need the parser extended too.
const HELP_GUIDE_MD = `
Welcome to your **8-Day Ticket Tracker**. This app tracks your Flexi Season Ticket usage, follows your trains live, detects which train you actually caught (on your phone and your Wear OS watch), checks performance for Delay Repay claims, syncs reminders to Google Calendar, and backs up your data to Google Drive.

---

## 1. How Your Ticket Is Tracked

Your Flexi Season Ticket gives you **{{USES}} day-passes** to use within a **{{PERIOD}}-calendar-day window**.

* **Automatic Pass Allowance:** Every weekday (Monday to Friday) automatically uses 1 pass unless you tag it as a non-travel day.
* **Weekends:** Weekends are automatically skipped and never consume a pass.
* **The {{PERIOD}}-Day Window:** Your validity period starts on the date you set when logging a new season ticket. The progress bar on the Home tab shows how many days have elapsed out of {{PERIOD}}.
* **Ticket Expiry:** A ticket period finishes as soon as you either **use all {{USES}} passes** OR **reach day {{PERIOD}}**, whichever happens first. Unused passes can't be carried over.
* **Gap Days & Smart Renewal Prompts:** Once a ticket period ends, the app works out when you next need to commute and flags the evening before that day as your "Buy Ticket" day — skipping non-working days and weekends in between.

---

## 2. Managing Your Daily Schedule

### Tagging Non-Travel Days
1. Tap any weekday on the Home tab or in the upcoming day list.
2. Choose a preset tag (**WFH**, **HOLIDAY**, **DENTIST**, **SICK**) or type your own reason.
3. Tap **Save**. That day's pass is restored and your renewal date adjusts automatically.

### Working Day Overrides
If you tagged a day but commuted anyway, tick **"I still used the ticket this day"** in that day's editor. Your note is kept and a pass is still deducted.

### Parking
Tick **"I parked today"** in a day's editor to record what you actually paid (it defaults to your daily parking cost from **Settings → Costs**).

### UK Bank Holidays
The app checks the official gov.uk bank holiday feed and tags weekday public holidays as **BANK HOLIDAY** automatically.

### Holiday Countdown
When a holiday is coming up, a Home tab card counts down the working days left. On your last working day it switches to an hour countdown to home time, then shows **"Enjoy your holiday!"** with your return date for the whole break.

---

## 3. Live Trains & Station Boards

The app connects to National Rail's Darwin live feeds via a private proxy Worker.

### Live Trains Tab ("My Trains" & "Tracked")
1. **My Trains:** Live departures for your usual morning (Crewe → Wigan) and evening (Wigan → Crewe) trains — times, platforms, delays and cancellations. Tap a row for its full live journey.
2. **Tracked Trains:** Follow up to **{{TRACKED_MAX}}** specific services. Tap **Track a train** to search any UK station by name or 3-letter code (e.g. \`CRE\`, \`WGN\`, \`EUS\`). A tracked train stays in the list for up to {{TRACKED_HOURS}} hours.

### Real-Time Journey Progress
Tapping a live train opens a detailed timeline:
* **Live Progress Line:** An animated marker moves down the stops based on real departure reports, and pins at a platform while the train is actually standing there.
* **Platforms & Status:** Platform numbers and an **AT PLATFORM** / **NOT YET DEPARTED** pill come from the rail industry's staff data where available, which is often more precise than public boards.
* **Coach Formation:** A side-on strip shows the train's coaches, with class and loading where the operator sends them. When only the train's length is reported (usual for Avanti), coaches are labelled from that alone, and an estimated count is marked with an asterisk.
* **Station Weather:** Weather icons and temperatures for upcoming stops (can be turned off in **Settings → Weather**).
* **Delay Explanations:** Delay and cancellation reasons are shown inline. Stale or repeated reasons are hidden, but you can tap **Show all reasons**.
* **Adaptive Polling:** Checks slow down when departure is far off and speed up near your destination. Tune this in **Settings → Polling**.

### Retro Station Board
Open **More → Station board**, choose any UK station, and get a split-flap style board of departures and arrivals that cycles pages and refreshes every 30 seconds.

### Emergency Routes
For real disruption, not everyday delays:
1. In **Settings → Emergency routes**, set up fallback journeys while things are calm — each is a chain of legs (e.g. "Via Liverpool": Wigan North Western → Liverpool Lime Street → Crewe).
2. Turn on **Settings → Emergency tab** when you want to see it on the Live screen; it's hidden by default.
3. The tab checks every saved route live and shows a full chained plan, or how far it gets before a leg fails, allowing a 5-minute minimum interchange.
4. Routes sort by direction using **Settings → Home and work stations** — routes home first from 12:00, routes to work first before then.
5. Tap **Add to Tracked** on a full plan to follow its trains — it respects the {{TRACKED_MAX}}-train limit and asks before dropping anything.

---

## 4. Knowing Which Train You Caught

Confirmed trains make Delay Repay matching accurate. There are three ways a train gets confirmed.

### On Your Phone ("Is this your train?")
When you're near Crewe or Wigan around a commute time — within **{{CRE_RADIUS}} m** of Crewe or **{{WGN_RADIUS}} m** of Wigan (adjust in **Settings → Geofence**) — the app checks the live boards:
* **Silent Confirmation:** If your usual train is departing or arriving within **{{SILENT_MIN}} minutes**, it's confirmed automatically and a green banner says so. Arrive earlier than that and it waits until the window opens, so an early arrival can't lock in the wrong train.
* **"Is this your train?":** If a different or delayed train is leaving as you arrive, a banner asks. Tap **"Yes, that's me"** to confirm it.

### On Your Watch
The Wear OS companion app detects arriving at either station using the same geofence sizes, even with your phone in your pocket. The matching is done server-side and keeps retrying for up to 90 minutes, so arriving early or a delayed train doesn't cause a miss. Confirmations made this way show **"(via watch)"**.
* Open the app on the same day and the watch's confirmation appears in the usual green banner.
* **Catch-up summary:** If the app wasn't opened for a day or more, it picks up anything the watch confirmed in the last 7 days and shows a summary banner — tap it to see each journey. It stays until you dismiss it, so you can check nothing was matched wrongly.

### Manually
Use **More → Confirm train used** to set or correct the train for any date. A manual entry always wins — it overrides a watch or phone confirmation, and choosing "None" stops any further automatic matching for that direction today.

### Copy for WhatsApp
Once today's evening train is known, the app can put a ready-made message on the clipboard for pasting into WhatsApp — e.g. *"🚆 On the 17:31 (running ~6 min late). Should be into Crewe around 18:15."* The arrival time errs on the late side: it takes the later of the live Crewe estimate and the train's current delay carried through to Crewe, then rounds **up** to the next 5 minutes.
* **Green banner:** tap **Copy for WhatsApp**. The button goes once it's copied.
* **"Yes, that's me"** and **Confirm train used → Save** (today, evening train changed) copy it automatically.
* It's only offered while live times are available and the train hasn't reached Crewe. If a copy fails, the banner's button gives you one more try; after that it's left for you to type.

### Watch Train Alerts
At a time you set per train in **Settings → Trains** ("Watch alert at"), your watch checks how the day's target train is running and buzzes with on time / delayed / cancelled and the platform. Leave a train's time blank for no alert. To report on a different train tomorrow, open the **Watch alert** panel on the Live tab's My Trains view — it defaults to Today in the morning and Tomorrow from midday. Non-travel days get no alerts.

### Morning Drive Check
Just before you leave for the station, your watch checks live traffic on your driving routes and tells you which way to go. Set it up in **Settings → Drive check**.
* **When:** each morning train has its own check time (e.g. 07:35 for the 08:08, 06:55 for the 07:27). The check follows that morning's watch-alert target, so switching tomorrow's train on the Live tab moves the drive check too. Weekends and tagged days (WFH, holiday, etc.) get no check.
* **What you'll see:** **"Go via …"** when another route saves at least your "quicker route" minutes; **"… slow: +N min"** when your usual route is well over normal and nothing is much quicker; **"… clear"** when the usual way is fine. You always get one of these, so no buzz means the check didn't run.
* **"Normal"** is Google's empty-road time plus 5 minutes. The "slow" alert fires when your usual route is over that by at least your "slow route" threshold.
* **Locations:** paste "lat, lng" for home, the station car park, and each route's via points. On a computer, right-click the spot in Google Maps and click the numbers at the top of the menu. Your home location stays on this device and the Worker only — it isn't included in backups, so after restoring onto a new device, enter it again.
* **Save & test now** runs a check straight away (any day, any time) and shows every route's time — use it to make sure each route's via points pick the roads you meant.
* **On demand:** the **Drive to station** row on the Live tab's My Trains view checks traffic whenever you tap it — any day, any time. The watch has the same thing as a **Drive to station** button. A check from the last few minutes is reused rather than asked for again.
* **Morning banner:** open the Live tab between 07:30 and 07:45 on a travel day and the check runs by itself, with the result as a banner at the top. Tap **×** to dismiss it for the rest of that morning.

### Watch Alert Panel
On the Live tab, **Watch alert** is a one-line summary of which trains the watch will report on (amber means you've changed it from the default). Tap it to open the full controls — Today/Tomorrow and a train per direction — and tap again to fold it away. It stays however you left it.

---

## 5. Delay Repay & Claims

The app cross-references your travel days against Historical Service Performance (HSP) records.

### Delay Indicators
* **Orange Dot:** At least one of your usual trains was **15+ minutes** late that day.
* **Red Dot:** The train you were confirmed as catching was 15+ minutes late.
* **Grey Dot:** A delay you chose not to claim (**Not claiming**).

### Delay Repay Badge
Avanti allows 28 days from travel to claim. A badge in the top-right of the Home tab shows the most urgent thing waiting, in this order:
1. **Expired** — a claim ran out: either one you started but never submitted, or a delay you never claimed at all. Tap to acknowledge it.
2. **Chase Avanti** — Avanti said they'd reply within {{RESPONSE_DAYS}} days of the claim being made, and that's passed without it being ticked as paid. Tap to open **Delay repay claims**.
3. **Claim available** — a train you were confirmed on was 15+ minutes late and nothing has been claimed yet. Shows the estimated payout and the days left. Tap to go straight to that day's claim.
4. **Started** — you've opened a claim but haven't entered its AWC reference yet. Counts down the days left to submit it. Tap to open **Delay repay claims** and add the reference.
5. **Awaiting payment** — submitted (reference entered) but not yet ticked as paid. Shows the amount and counts down Avanti's {{RESPONSE_DAYS}}-day reply window, from the day you entered the reference. Tick **Confirmed** once the money arrives and it goes.
6. **Confirm train** — one of your usual trains was late on a day with no confirmed train, so the app can't tell whether you're owed anything. Tap to confirm which train you caught; if it was the late one, the badge becomes **Claim available**.

A small line under the badge counts any other claims still waiting, including ones awaiting payment.

### Not Claiming
If you decide not to claim a delay, open the day and tap **Not claiming** under its Morning or Evening list (it only appears where there's something to claim). The day turns grey, reads **Declined delay repay**, and drops off the badge. It's left out of the ROI dashboard's totals. Changed your mind? **Undo** it in **More → Delay repay claims**.

### Smartcard Pass
Avanti asks for a photo of your ticket and your smartcard number. Add both once in **Settings → Smartcard photo** — the photo is stored privately on this device.

### Submitting & Managing Claims
1. Tap a day with a delay indicator, or open **More → Delay repay claims**.
2. Tap the highlighted delay row. The app estimates your payout per single leg (a Flexi 8 covers 16 single journeys): 15–29 mins pays 25%, 30–59 mins 50%, and 60+ mins 100% of one leg's value.
3. Avanti's Delay Repay site opens, your pass photo downloads, and your smartcard number is copied to the clipboard ready to paste. If **Settings → Claim details file** is on, a **claim-details.txt** summary downloads too.
4. A **Claim details** screen shows the same information in the app.
5. Enter the **AWC reference** in the Delay Repay manager as soon as you've submitted — the badge switches to **Awaiting payment**. Once paid, tick **Confirmed**.

---

## 6. Performance & Money

### Performance History
**More → Performance history** shows how your usual trains ran on every weekday, not just days you travelled, starting with the last 90 days — tap **Load more history** to go further back (about a year). The stats icon at the top shows the most common delay and cancellation reasons and which weekdays tend to run latest, morning and evening.

### ROI Dashboard
**More → ROI dashboard** shows what the commute has cost and clawed back: Delay Repay totals (confirmed, pending and expired), claims recovered against ticket spend over a rolling 12 months, monthly claims, parking spent and saved, and a **What if** projection of how many tickets a different pattern of office days would need over the next 12 months.

### Home Tab Cards
* **Set aside on payday:** Counts the tickets and parking days in your pay period (paid on the 28th, moved earlier for weekends and bank holidays) and totals what to set aside. Use the **‹** and **›** arrows to preview future periods. The same figures can be shared with your Personal Finance app — see **Sharing Estimates with Personal Finance** below.
* **Savings card:** What parking has saved you this ticket period.
* **Spending card:** What you've spent on tickets this year.

Any of these cards can be hidden or shown again in **Settings** (**Payday figure**, **Parking savings figure**, **Spending figure** under **Home screen**). Daily parking cost and day-return price live in **Settings → Costs**.

---

## 7. Logging Purchases & Ticket Advisor

### Logging Tickets
Open the **Buy** tab:
* **Season Ticket:** Starts a new {{USES}}-use / {{PERIOD}}-day cycle from your chosen date and records the cost.
* **Single Ticket:** Logs an individual day-return without disturbing your season ticket cycle.

### Ticket Purchase Advisor
Before you buy, the advisor checks your upcoming days (WFH, holidays and bank holidays included). If you have fewer than {{USES}} travel days planned in the next {{PERIOD}}, it tells you whether day returns would be cheaper.

---

## 8. Calendar Sync & Google Drive Backups

### Google Calendar Reminders
1. Go to **Settings → Calendar sync** to connect.
2. The app keeps a single **"Buy train ticket"** event at 8:00 PM on the evening you next need to buy.
3. If your plans change, the event moves automatically.

### Google Drive Backups
1. Open **More → Backup & restore** and turn on automatic Google Drive backup.
2. When you leave or close the app, it backs up if anything has changed and at least 30 minutes have passed since the last backup. Files go to a \`Ticket Tracker Backups\` folder, keeping the {{BACKUP_KEEP}} most recent.
3. Google's sign-in only lasts about an hour. Tap **Connect automatic sign-in** on Backup & restore once, and your own Worker keeps it renewed from then on, so backups (and Calendar updates) run without a tap. Google may show a "hasn't verified this app" screen the first time — tap **Advanced**, then **Go to Ticket Tracker**.
4. If a backup still can't run — say the connection was removed — and the last backup is over a day old with something changed, a red banner appears. Tap it to back up (or to reconnect, if that's what's needed).
5. You can also export or restore a \`.json\` backup manually at any time.
6. A backup deliberately leaves out a few things that are either secret or tied to this device: the **Worker write secret**, the **drive-check home location** and the **smartcard pass photo**. After restoring onto a new phone (or a new web address), enter the secret and home location again and re-add the photo. Google normally stays connected, because your Worker holds the sign-in — once the secret is entered, check **Automatic sign-in** on Backup & restore, and only tap **Connect automatic sign-in** if it says it needs reconnecting.

### Sharing Estimates with Personal Finance
1. On **More → Backup & restore**, tick **Share estimates with Personal Finance**. It works whether or not automatic backup is on.
2. The app saves your **Set aside on payday** figures — this pay period and the next 12 — to a small \`transport-estimates.json\` file in the same \`Ticket Tracker Backups\` folder. Your Personal Finance app reads it for its "Train fare/Parking" transfer.
3. It checks whenever you open or leave the app, and only rewrites the file when the figures have actually changed. **Last shared** shows when they last changed, not when it last checked.
4. Each period is the same figure the Home card shows: the current period once its payday has passed is fixed, later ones are projections that move as you tag days.
5. **Share now** sends the figures straight away (and signs in to Google if needed). Turning the setting off stops updates; the last file stays in Drive.
6. The file also lists your season tickets — the ones bought in the last 90 days, with the date you bought them and the price paid, and the ones still to buy, on the evening before they start at today's price — so Personal Finance can show each purchase on your card. Single tickets aren't included.
7. The Buy screen's **Bought on** date (today unless you change it) is the purchase date that's shared. Always buy the ticket first, then log it here.

---

## Quick Reference Summary

| Nav / Menu Item | Primary Function |
| :--- | :--- |
| **Home Tab** | Pass counter, {{PERIOD}}-day bar, claim badge, payday/savings/spending cards, holiday countdown, day list. |
| **Live Tab** | Your usual trains, watch alert target, tracked trains, and the optional Emergency tab. |
| **Buy Tab** | Log season or single tickets; purchase advisor. |
| **Calendar Tab** | Monthly grid of notes, travel days, and delay indicators. |
| **More → Station board** | Retro full-screen live board for any UK station. |
| **More → Confirm train used** | Set or correct which train you caught. |
| **More → ROI dashboard** | Claims, ticket spend, parking and office-day projections. |
| **More → Performance history** | How your usual trains have run, plus reason and weekday stats. |
| **More → Delay repay claims** | Manage and confirm claims. |
| **Settings** | One grouped list: Travel (trains, Home and work stations, emergency routes), Costs, Alerts and watch (Drive check, geofence, polling, weather), Home screen figures, Delay repay (smartcard photo, claim details file), Accounts (Google, calendar sync) and Advanced (write secret, debug). |
`;

// Minimal, purpose-built Markdown renderer — covers exactly the subset
// HELP_GUIDE_MD actually uses (##/### headers, bold, bullet/numbered
// lists, tables, links, hr, inline code), not Markdown generally. Text
// content is escaped before any HTML is added, so the source can be
// trusted content (this app's own help text) without needing to treat
// it as arbitrary untrusted input.
function renderHelpMarkdown(md){
  const cleaned = md
    .replace(/\$\\rightarrow\$/g, '→')
    .replace(/\$\\langle\$/g, '‹')
    .replace(/\$\\rangle\$/g, '›');
  const lines = cleaned.split('\n');
  let html = '';
  let inList = null; // 'ul' | 'ol' | null
  function closeList(){ if (inList){ html += `</${inList}>`; inList = null; } }
  function inlineMd(text){
    let t = escapeHtml(text);
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }
  let i = 0;
  while (i < lines.length){
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('|') && lines[i+1] && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(lines[i+1].trim())){
      closeList();
      const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headerCells = splitRow(trimmed);
      html += '<table class="help-table"><thead><tr>' + headerCells.map(c => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')){
        const rowCells = splitRow(lines[i]);
        html += '<tr>' + rowCells.map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>';
        i++;
      }
      html += '</tbody></table>';
      continue;
    }

    if (trimmed === '---'){ closeList(); html += '<hr>'; i++; continue; }
    if (trimmed === ''){ closeList(); i++; continue; }

    let m;
    if ((m = trimmed.match(/^####\s+(.*)$/))){ closeList(); html += `<h4>${inlineMd(m[1])}</h4>`; i++; continue; }
    if ((m = trimmed.match(/^###\s+(.*)$/))){ closeList(); html += `<h4>${inlineMd(m[1])}</h4>`; i++; continue; }
    if ((m = trimmed.match(/^##\s+(.*)$/))){ closeList(); html += `<h3>${inlineMd(m[1])}</h3>`; i++; continue; }
    if ((m = trimmed.match(/^#\s+(.*)$/))){ closeList(); html += `<h2>${inlineMd(m[1])}</h2>`; i++; continue; }

    if ((m = trimmed.match(/^[*-]\s+(.*)$/))){
      if (inList !== 'ul'){ closeList(); html += '<ul>'; inList = 'ul'; }
      html += `<li>${inlineMd(m[1])}</li>`;
      i++; continue;
    }
    if ((m = trimmed.match(/^\d+\.\s+(.*)$/))){
      if (inList !== 'ol'){ closeList(); html += '<ol>'; inList = 'ol'; }
      html += `<li>${inlineMd(m[1])}</li>`;
      i++; continue;
    }

    closeList();
    html += `<p>${inlineMd(trimmed)}</p>`;
    i++;
  }
  closeList();
  return html;
}
// Deliberately NOT listed above — these are easter eggs, and the whole
// point is Wayne forgetting they exist and being surprised. Left as a
// source-only note for future-Claude/Wayne rather than the in-app,
// user-visible backlog: Christmas header (lights + Santa/reindeer/present
// icons, matched by holiday title so it isn't pinned to hardcoded dates,
// see isChristmasBunting), a floating ghost on Halloween, and firework
// bursts on Bonfire Night (see runSeasonalEasterEgg and friends, near the
// bottom of the file, just above the init() IIFE).

// 2026-09-25: fills HELP_GUIDE_MD's {{TOKENS}} from live settings and
// constants at the moment Help opens. An unknown token is left visible
// rather than silently blanked, so a typo shows up on screen.
function buildHelpGuideMd(){
  const values = {
    CRE_RADIUS: geofenceRadiusCrewe,
    WGN_RADIUS: geofenceRadiusWigan,
    SILENT_MIN: SILENT_CONFIRM_MAX_DIFF_MIN,
    TRACKED_MAX: TRACKED_TRAIN_MAX,
    TRACKED_HOURS: Math.round(TRACKED_TRAIN_MAX_AGE_MS / 3600000),
    BACKUP_KEEP: DRIVE_BACKUP_KEEP_COUNT,
    USES: USES_PER_PERIOD,
    PERIOD: PERIOD_LENGTH,
    RESPONSE_DAYS: DELAY_REPAY_RESPONSE_DAYS,
  };
  return HELP_GUIDE_MD.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

function openHelpGuide(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay-nav-safe';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Help</h3>
      <div class="help-content">${renderHelpMarkdown(buildHelpGuideMd())}</div>
      <div class="modal-close" id="help-close-btn" style="margin-top:16px;">Close</div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('help-close-btn').addEventListener('click', () => { if (overlay.isConnected) document.body.removeChild(overlay); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
}
