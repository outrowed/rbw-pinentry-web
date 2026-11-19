# Browser Notifications

The inbox can raise a desktop notification when a new pinentry request arrives,
so an approval is noticed while the operator is working somewhere else. This
document records the design decisions behind that feature: what triggers a
notification, what it may contain, and why the defaults are quiet.

## Why opt-in

Browsers only grant notification permission from a user gesture, so a page
cannot silently start notifying. The inbox treats that constraint as the
intended behaviour rather than an obstacle: alerts are a deliberate choice, not
a default. A visit that begins by asking for notification permission before the
operator understands the page is a bad introduction, and a granted permission is
awkward to reverse.

The toggle in the Pending requests header is the only path to enabling alerts.
It is rendered only when the browser exposes the Notification API, so an
unsupported browser shows no dead control.

The choice is stored in `localStorage` under `rbw-web-pinentry:alerts` as `on`.
Absence of the key means off, which keeps the default explicit and lets a user
clear the preference by removing the entry. On load the stored preference is
honoured only if the browser still reports `granted`; a revoked permission
silently downgrades to off rather than leaving a toggle that claims to work.

Storage is wrapped in `try`/`catch` throughout. Private modes and restrictive
policies can make `localStorage` throw, and a notification preference is never
worth breaking the page over: the fallback is off for the session.

## When a notification fires

Three conditions must all hold.

1. **Permission is granted and the operator has alerts on.**
2. **The request is genuinely new.** The page keeps a set of session IDs it has
   already accounted for and announces only IDs outside that set.
3. **The inbox is not already in front of the operator.** A visible, focused tab
   means the request card appeared on screen at the same moment; a desktop
   notification would duplicate it and train the operator to ignore alerts.

The visibility rule is deliberate: the point of the feature is to reach someone
who is looking elsewhere. A tab that is visible but unfocused still notifies,
because the operator's attention belongs to another window.

### The first snapshot is not news

On the first successful load the page seeds the known-ID set from whatever is
already pending and announces nothing. Requests that were waiting before the
page opened are visible in the list immediately; announcing them would produce a
burst of notifications for things the operator is already looking at.

This is why loading state is tracked separately from the request list. The list
starts empty before the first fetch resolves, so seeding on the initial render
would record an empty set and then treat the entire first snapshot as new.
Seeding waits for a successful load instead.

### One notification per request

The notification `tag` is the request's session ID. The browser replaces a
notification with the same tag rather than stacking duplicates. Since a request
ID is unique and resolved requests do not return, one request produces at most
one live notification.

Requests that were announced while hidden do not re-announce when the tab
becomes visible, and a second snapshot containing the same request stays quiet:
the known-ID set is updated on every arriving snapshot, not only when an
announcement happens.

Turning alerts on does not replay the existing list either. Enabling only starts
watching from that moment, so an operator who switches alerts on while several
requests are pending gets silence until something new arrives. Notifying for the
backlog would punish the moment of opt-in.

## What a notification says

Notifications carry the prompt kind, the prompt subject, the client, the source,
and a truncated request ID:

```
Vault unlock requested
Master Password - rbw-agent / web-pinentry on openclaw (#b0d566cd)
```

The body never contains a secret. The daemon holds entered values only in RAM
for the waiting client and never sends them to the browser, so there is nothing
secret for a notification to leak by construction. What it can expose is
metadata: that an unlock is happening, from which machine. That is the same
metadata already visible in the inbox, and it is the minimum needed to make a
decision about whether to go and answer.

Fields are trimmed, with fallbacks for each part, so an incomplete request still
produces a readable sentence instead of a message with blank gaps. The ID is cut
to eight characters: enough to correlate with the card on screen, too short to
be mistaken for a credential.

Clicking a notification focuses the window and closes the notification, which is
the only action available. Notifications never approve, deny, or prefill
anything; the operator still has to act in the inbox.

## Trust boundary

The notification feature adds no authority. It reads the same request list the
page already renders and calls a browser API. Every security property of the
inbox is unchanged:

- The list still requires the authenticated identity supplied by the reverse
  proxy, so a notification can only describe requests the page was allowed to
  see.
- Approving still requires a user action in the inbox against a specific request
  ID.
- The daemon's internal endpoints remain unreachable through the public route.

Nothing about notifications is persisted beyond the on/off preference. No
request content, ID, or history is written to storage.

## Deliberate limitations

- **A closed tab receives nothing.** This uses the page `Notification`
  constructor, not a service worker, so alerts stop when the page is gone. A
  push-based design would need a service worker, a subscription endpoint, and
  server-side delivery, plus a decision about storing subscriptions, which
  conflicts with the memory-only model. That is a different feature, not a
  missing detail of this one.
- **No notification when the tab is focused.** By design, as described above.
  The inbox is the notification at that point.
- **No sound, vibration, or per-kind filtering.** The filter bar governs the
  list, not alerts. Adding per-kind alert rules would mean persisting a
  preference structure rather than a single flag.
- **Permission denial is not recoverable in-page.** Once a browser records a
  denial, only the site settings can reverse it, so the inbox explains that
  instead of offering a retry that cannot succeed.

## Testing

The decision logic lives in `src/client/ui/notifications.ts` as pure functions so
it can be tested without a DOM:

| Function | Contract |
| --- | --- |
| `selectNewRequests` | Returns requests whose IDs are not already known, preserving arrival order |
| `describeRequest` | Builds the title and body, trimming fields and falling back for empty ones, truncating the ID |
| `shouldAnnounce` | Encodes the permission, enabled, visibility, and focus rules |

`tests/notifications.test.ts` covers those contracts, including that a full
session ID never appears in the body. The React wiring in `App.tsx` - seeding,
the known-ID set, and the toggle - is exercised by hand in a browser, since the
project has no DOM test environment.

When changing this feature, verify in a real browser rather than only in tests:
the permission prompt, activation, a request arriving while hidden, and a
request arriving while focused. The behaviour that matters most, staying quiet
at the wrong moment, is the part that unit tests cannot observe.
