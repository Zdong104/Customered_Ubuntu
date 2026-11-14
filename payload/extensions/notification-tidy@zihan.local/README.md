# notification-tidy@zihan.local

GNOME Shell 50 extension. It does two things to notifications in the tray
(the ones Ubuntu Dock counts for its app badges).

## A. Clear an app's notifications once you have looked at it

Ubuntu Dock badges an app icon with the notifications still in that app's tray
source. WeChat never withdraws its notifications, so its badge never clears.

An app counts as "seen" when its window has the keyboard focus, the screen is
not locked, and there was keyboard or mouse input in the last 6 s:

| Trigger | Check |
|---|---|
| Focus moves to the app | still focused 1 s later |
| A notification arrives while the app is focused | still focused 6 s later, input in the last 6 s |
| You come back after at least 6 s idle while the app is focused | still focused 1 s later |

Then every non-resident notification in that app's sources is destroyed with
reason DISMISSED, so the app receives `NotificationClosed` reason 2. Resident
notifications are not removed; they are only marked acknowledged, which also
takes them out of the dock count. Notifications without an app are never
touched.

## B. File Chrome PWA notifications under the PWA

Chrome sends every site's notification as `appName "Google Chrome"`,
`desktop-entry google-chrome`, so Teams and Outlook messages are shown and
counted as Google Chrome. The only per-site signal is the first line of the
body, which Chrome fills with the site's host (for example
`teams.microsoft.com`).

For a new notification (not an update to an existing one) from Chrome whose
first body line is a host in the table, the notification is filed under the
PWA's app (`chrome-<app id>-Default.desktop`): the PWA's name and icon, its
dock badge, and its "clear when seen" (A). A host matches a table key when it
equals the key or is a subdomain of it, and the longest matching key wins.
Nothing changes if the PWA's .desktop file is not installed. Clicking still
goes to Chrome, which opens the right tab or app. Updates (`replaces_id`) stay
where they were first filed.

Built-in table:

| Hosts | PWA |
|---|---|
| teams.microsoft.com, teams.cloud.microsoft, teams.live.com | Teams (`chrome-cifhbcnohmdccbgoicgdjpfamggdegmo-Default.desktop`) |
| outlook.office.com, outlook.office365.com, outlook.cloud.microsoft, outlook.live.com | Outlook (`chrome-eoficlgicibekocmfdomjbfnjmehnhcd-Default.desktop`) |
| chat.google.com | Google Chat (`chrome-pommaclcbfghclhalboakcipcmmndhcj-Default.desktop`) |
| remotedesktop.google.com | Chrome Remote Desktop (`chrome-cmkncekebbebpfilplodngbpllndjkfo-Default.desktop`) |

### pwa-map.json

`~/.config/notification-tidy/pwa-map.json` adds to or overrides the built-in
table. It is a JSON object (no comments) mapping a host to a desktop id. The
`.desktop` suffix is optional. A value of `null` removes a built-in entry. The
file is re-read when it changes, with no restart needed. If it cannot be
parsed, the built-in table is used and a warning goes to the journal.

```json
{
  "app.slack.com": "chrome-abcdefghijklmnopabcdefghijklmnop-Default.desktop",
  "microsoft.com": "chrome-cifhbcnohmdccbgoicgdjpfamggdegmo-Default",
  "remotedesktop.google.com": null
}
```

To find a PWA's id, list `~/.local/share/applications/chrome-*-Default.desktop`.
The id is the 32 letters after `chrome-`.

Chrome shortens hosts longer than 28 characters to the registrable domain
(for example `microsoft.com`). Such a short host only matches if you add it
yourself, as in the second line above.

## Journal

```
journalctl --user -f | grep '\[notif-tidy\]'
```

Warnings (an unreadable `pwa-map.json`, a missing notification daemon) are
always logged. The per-event lines below are written only when `DEBUG` is set
to `true` at the top of `impl-1.js` (it is `false` as shipped):

- `[notif-tidy] cleared N for <app id>`
- `[notif-tidy] routed google-chrome → <desktop id> (<host>)`

Message content is never logged.

## Layout and reloading

`extension.js` imports the highest-numbered `impl-N.js`. To try a change
without logging out, copy it to `impl-(N+1).js`, edit, then run
`gnome-extensions disable notification-tidy@zihan.local; sleep 2; gnome-extensions enable notification-tidy@zihan.local`.
ES modules are cached per file name, so editing an `impl-N.js` that is already
loaded has no effect until the next login.

It does not touch `MessageTray._updateState`, which
notification-banners@zihan.local and dnd-hides-critical@zihan.local wrap.
On disable it restores `NotifyAsync` and removes every signal handler, idle
watch and timeout it added.
