# Restock Monitor — Design

Date: 2026-09-16
Status: approved, not yet implemented
Builds on: `2026-09-16-delivery-mode-design.md`

## Goal

Watch a list of products across the four supported retailers without anyone
pressing a button, and send a Telegram message the moment one becomes
deliverable to the user's postal code. Today every lookup is started by hand
from the popup, so catching a short restock means sitting at the keyboard
refreshing. The immediate need is a PlayStation 5 Pro, which sells out in
minutes, but the feature is a general watchlist.

## Decisions (from brainstorming)

- **Telegram, not desktop notifications.** The user needs to hear about a
  restock while away from the machine. No `notifications` permission is added.
- **Inside the extension, driven by `chrome.alarms`.** Every request must come
  from a real tab on the retailer's domain, carrying the user's cookies and
  walmart.ca's PerimeterX clearance. The user's Chrome is always open, so an
  external process driving a second browser would add moving parts and buy
  nothing.
- **A watchlist, not one hardcoded product.** Each entry is one retailer and one
  product. Adding an entry reuses the URL the popup already parses.
- **Delivery to the user's postal code is the only trigger.** It is what the
  user can actually buy, and it is the cheapest check. Pickup watching is out of
  scope.

## Constraints

- MV3 service workers are killed when idle. `chrome.alarms` wakes them, and its
  minimum period is one minute. Chrome may stretch alarms further when the
  machine is idle or on battery, so the cadence is best-effort, not real-time.
- walmart.ca rate-limits `nearByNodes` at roughly 25 calls in a few minutes per
  IP, with a penalty box that grows on repeat offences. A delivery lookup costs
  one such call, so the monitor must pace itself and must never compete with a
  search the user started by hand.
- walmart.ca can demand its "press and hold" bot check at any time. A monitor
  that silently stops answering is worse than no monitor, so this state has to
  reach the user.
- The existing pickup and delivery paths must not change behaviour. They are the
  tested, shipped paths.

## What already exists and is reused

All four adapters answer the same message, verified by the delivery-mode work:

```
{ type: "lookup", retailer, itemId, postalCode, mode: "delivery" }
  -> { ok: true, item: { ..., delivery: { status, quantity, eta, seller? } }, stores, complete }
```

The monitor sends exactly this message and reads `item.delivery.status`. No new
retailer code is written, and no new endpoint is discovered. `deliveryText` in
`src/lib/delivery.js` already formats the human-readable line, so the Telegram
message reuses it rather than inventing new wording.

`background.js` already owns `forward(...)`, which finds or opens a tab on the
retailer's host, verifies the content script answers, and retries once if the
site reloads the tab underneath it. The monitor calls the same function.

## Architecture

```
chrome.alarms ("watchTick", every 1 minute)
     v
background.js  onAlarm -> watch.tick()
     v
src/lib/watch.js          pure logic, deps injected (matches src/lib/job.js)
  - reads watches + settings from chrome.storage.local
  - picks the entries whose nextCheckAt has passed
  - forward({ type: "lookup", ..., mode: "delivery" })  ->  content script
  - compares the new status with the stored one
  - schedules the next check, with jitter and error backoff
  - hands messages to the notifier
     v
src/lib/telegram.js       sendMessage(token, chatId, text, { fetch })
     v
api.telegram.org
```

`src/lib/watch.js` takes `{ forward, storage, getJob, notify, now, random }` the
same way `createJobs` takes `{ forward, storage, now }`. Every rule below is
therefore testable without a browser, a network, or a clock.

## Data

Both keys live in `chrome.storage.local`, not `storage.session`, so the
watchlist survives a browser restart. The foreground job keeps using
`storage.session` and is untouched.

```
Watch {
  id: string,                 // `${retailer}:${itemId}`, so re-adding is idempotent
  retailer: "walmart" | "bestbuy" | "staples" | "shoppers",
  itemId: string,
  input: string,              // the URL the user pasted, shown until a name is known
  name: string | null,        // filled from item.name after the first successful check
  url: string | null,         // filled from item.url after the first successful check
  priceString: string | null,
  postalCode: string,         // the destination this entry asks about
  status: "available" | "out_of_stock" | "unknown" | null,  // last observed, null before the first check
  notifiedStatus: "available" | "out_of_stock" | "unknown" | null,  // the status the user has been told about
  deliveryText: string | null,// the retailer's own wording at the last check
  lastCheckedAt: number | null,
  nextCheckAt: number,
  failures: number,           // consecutive errors, drives the backoff
  lastError: { code, message } | null,
  alertedError: boolean,      // an error message has already gone out for this streak
  notifiedAt: number | null,  // when the last restock alert was sent, for display only
  paused: boolean,
  createdAt: number,
}

Settings {
  enabled: boolean,           // master switch, default false until Telegram is configured
  telegram: { token: string, chatId: string } | null,
  intervalMinutes: number,    // base cadence for new entries, default 5
}
```

## Scheduling

- One alarm, `watchTick`, with `periodInMinutes: 1`. Worker startup checks with
  `chrome.alarms.get` and creates it only when it is missing. Re-creating it
  unconditionally would be wrong: `chrome.alarms.create` with the same name
  replaces the alarm, and replacing it resets the first fire to a minute from
  now. An MV3 worker cold-starts on every message, so a user who opens the popup
  every 45 seconds would push the tick out indefinitely and the monitor would
  never run, with no error and no signal.
- A tick does nothing when `settings.enabled` is false, when `settings.telegram`
  is unset, or when `getJob()` reports a job in phase `lookup` or `searching`.
  The last rule keeps the monitor out of the way of a search the user started,
  which matters because both share walmart's rate limit.
- Due entries are those with `paused === false` and `nextCheckAt <= now`,
  checked oldest-due first.
- At most `MAX_CHECKS_PER_TICK = 3` entries are checked in one tick. A larger
  watchlist simply spreads over the following minutes. This caps the burst that
  any single wake-up can produce.
- After a check, `nextCheckAt = now + interval * jitter`, where `interval` is the
  entry's base interval and `jitter` is drawn from 0.75 to 1.25. The jitter stops
  the call pattern from becoming a fixed fingerprint and stops several entries
  from locking into the same tick forever.
- After a failure, the interval for that entry is
  `min(base * 2 ** failures, 60 minutes)` before jitter. A success sets
  `failures` back to zero.

Three walmart entries at the five-minute default produce at most three calls per
five minutes, against a limit of roughly 25 in that window. That leaves most of
the budget for searches the user starts by hand. The options page shows the
resulting rate so a long watchlist cannot quietly cross the line.

## Notification rules

The point of these rules is that the user hears about every restock and about
every silent failure, and is not otherwise bothered.

- **Restock.** Send when the observed status is `available` and `notifiedStatus`
  is anything else. A `null` `notifiedStatus` counts, so adding a watch for
  something already in stock tells the user right away. `notifiedStatus` is only
  moved to `available` after Telegram accepts the message, which is what makes a
  failed send retry on the next tick instead of being lost. While the status
  stays `available` and the user has been told, nothing more is sent. If it goes
  out of stock, `notifiedStatus` follows it down, so the next return sends again.
- **Failure.** When `failures` reaches 3 and `alertedError` is false, send one
  message naming the error and set `alertedError`. Nothing more is sent for that
  streak. A `verification` error says in plain words to open the retailer and
  complete the press-and-hold check, because that is the action that fixes it.
- **Recovery.** When a check succeeds while `alertedError` is true, send one
  short message saying checks are working again, and clear the flag. This is what
  makes silence trustworthy: silence now means "running and nothing has changed".
- A send that fails is logged and does not throw. The tick still records the new
  observed status, so a Telegram outage cannot wedge the monitor, and because
  `notifiedStatus` is only advanced on success, the alert goes out on the next
  tick instead of being dropped.

Message body for a restock, built from fields the adapters already return:

```
🟢 In stock — PlayStation®5 Pro Console
Walmart · $827.00
Ships from DealWiz: In stock · arrives Sep 21
https://www.walmart.ca/en/ip/PlayStation-5-Pro-Console/1SZQHN3LOSE0
```

## Telegram

`src/lib/telegram.js` exports one function:

```
sendMessage({ token, chatId, text }, { fetch })
  POST https://api.telegram.org/bot<token>/sendMessage
  body { chat_id, text, disable_web_page_preview: false }
  -> { ok: true } | { ok: false, error }
```

`fetch` is injected so tests never touch the network. A non-200 response or a
body with `ok: false` is returned as a failure with Telegram's own description,
which is what the options page shows when the user presses "Send test message".

The token is stored in `chrome.storage.local`. Other extensions cannot read it,
but anyone with access to the Chrome profile on disk can. This is written on the
options page next to the field so the user is not surprised.

## User interface

**Popup.** One button, "Watch for restock", next to the existing search button.
It is enabled when the pasted input parses to a retailer and product and a postal
code is present. Pressing it sends `addWatch` with the parsed retailer, item id,
pasted input and postal code, then reports "Watching" or the reason it could not.
Nothing else in the popup changes.

**Options page.** A new `options/options.html`, opened from the extension menu
and from a link in the popup.

- Telegram token and chat id, with a "Send test message" button that reports the
  real result, and the note about where the token is stored.
- A master enable switch and the default interval.
- The watchlist: name or pasted URL, retailer, last known status, when it was
  last checked, and when the next check is due. Each row has pause and remove.
  A row with an error streak shows the error and the count.

## Background message types

Added to `handle()` in `background.js`, all from extension pages only, which the
existing sender check already enforces:

```
getWatchState                  -> { ok: true, watches, settings }
addWatch { retailer, itemId, input, postalCode }  -> { ok: true, watch }
removeWatch { id }             -> { ok: true }
pauseWatch { id, paused }      -> { ok: true, watch }
setWatchSettings { settings }  -> { ok: true, settings }
testTelegram                   -> { ok: true } | { ok: false, error }
```

`addWatch` is idempotent on `id`, so adding the same product twice updates the
postal code rather than creating a duplicate.

## Error handling

The wire shape and error codes are unchanged. The monitor treats every `ok:
false` response as a failure for backoff purposes and stores `{ code, message }`
on the entry. `verification` and `rate_limited` get their own wording in the
Telegram message because each has a different fix: solve the bot check, or wait.
A `no_tab` failure means Chrome could not open a tab on the retailer, which is
reported with the same machinery.

## Testing

**Unit,** all in the style of `test/job.test.js`, with injected clock, storage,
forward and notifier:

- Due selection: only unpaused entries past `nextCheckAt`, oldest first, capped
  at three per tick.
- Skipping: a tick does nothing while a foreground job is in `lookup` or
  `searching`, while `enabled` is false, and while Telegram is unconfigured.
- Jitter: the next check always lands within 0.75 and 1.25 of the base interval,
  driven by an injected random.
- Backoff: grows by powers of two per consecutive failure, caps at 60 minutes,
  and resets to the base interval on the first success.
- Restock rules: `null` to available notifies, available to available does not,
  available to out of stock does not, out of stock back to available notifies
  again.
- Send retry: when Telegram rejects the restock message, the observed status is
  still stored, and the next tick sends it again while the item stays available.
- Failure rules: nothing at one and two failures, exactly one message at three,
  nothing at four, and one recovery message on the next success.
- Resilience: a notifier that throws does not stop the status from being stored
  and does not break the tick.
- `test/telegram.test.js`: the URL contains the token, the body carries chat id
  and text, a non-200 and an `ok: false` body both come back as failures with
  Telegram's description.
- `test/background.test.js` gains the new message types and the alarm wiring
  against the existing fake chrome.

**End-to-end.** `tools/e2e-popup.mjs` gains a scenario that adds a watch, runs
one tick with a stubbed notifier, and asserts the recorded status matches what a
plain delivery lookup returns for the same product. The Telegram call is stubbed;
no test sends a real message.

## Out of scope

Pickup watching, matching one product across retailers automatically (the user
adds one URL per retailer, because the four sites share no product identifier),
buying or adding to cart, more than one postal code per entry, desktop
notifications and other notification channels, running while Chrome is closed,
and any attempt to defeat or pre-empt a bot check.
