# Shortcut Cheatsheet

Hold the `Super` key for a moment and a sheet of useful keyboard shortcuts appears. Let go and it
disappears. The list is a plain JSON file you can edit, so you can add your own shortcuts and notes.

![The Shortcut Cheatsheet overlay titled "Keyboard Shortcuts", in three columns: When the system freezes, Added by this setup, Windows, Workspaces & apps, and System. Each row shows key caps next to a short description, and the top right reads "release Super to close · edit ~/.config/shortcut-cheatsheet/shortcuts.json".](../images/shortcut-cheatsheet.png)

## Why (vs stock Ubuntu)

On stock Ubuntu the full list of shortcuts is buried in Settings > Keyboard, and nothing shows you
the shortcuts at a glance. Many of the most useful ones, such as how to recover from a frozen
desktop, are not listed anywhere on screen. The cheatsheet works like holding the Command key in
macOS apps: a quick reference that is always one key away and gets out of the way the moment you let
go. A quick tap of `Super` still opens the Activities overview as before.

The default sheet covers:

- **When the system freezes**: killing the process using the most memory, switching to a text
  console and back, a safe emergency reboot, and taking shortcuts back from an app that grabbed them
- **Added by this setup**: the [Emoji Picker](emoji-picker.md), per-monitor
  [workspace](workspaces.md) switching, the cheatsheet itself, and
  [Quick Answers](quick-answers.md) in the overview search
- **Windows**, **Workspaces & apps**, and **System**: tiling, moving windows between monitors and
  workspaces, dock apps, screenshots, screen recording, notifications, display layout, and locking
  the screen

Every entry is a shortcut that Ubuntu 26.04 or this setup actually provides.

## How to use

| Action | Result |
| --- | --- |
| Hold `Super` alone, without moving the mouse, for about 0.8 seconds | The sheet appears |
| Release `Super` | The sheet closes; the overview does not open |
| Press another key while holding `Super` | The sheet closes and that shortcut runs as usual |
| Click or scroll while holding `Super` | The sheet closes and the click or scroll goes through |
| Tap `Super` quickly | The Activities overview opens, as on stock Ubuntu |

Notes:

- The sheet appears only if nothing else happens while you hold `Super`: no other key, no click, and
  no mouse movement. Once it is showing, you can move the mouse freely.
- It works on the desktop and in the Activities overview, but not on the lock screen.
- The sheet never takes keyboard focus, so it cannot get in the way of the app you are using.
- It appears centred on the active monitor and shrinks if it does not fit. It uses two columns on
  screens narrower than 1300 logical pixels and three on wider ones.
- It follows the system style: it is dark when Settings > Appearance is set to Dark.

## Settings

Everything lives in `~/.config/shortcut-cheatsheet/shortcuts.json`. The file is created with the
default list the first time you hold `Super`, and it is read again every time the sheet appears, so
saved changes show up on the next hold without logging out.

The file contains:

| Field | Meaning |
| --- | --- |
| `hold_ms` | How long `Super` must be held, in milliseconds (default `800`, minimum `200`) |
| `columns` | Number of columns; `0` chooses automatically |
| `sections` | A list of sections, each with a `title` and a list of `items` |
| `_help` | A short reminder of the format; ignored by the sheet |

Each item has:

- `keys`: the key combination, written as text (see below)
- `desc`: the description
- `zh`: optional second line under the description, for example a translation

How `keys` is written:

| Write | Meaning | Example |
| --- | --- | --- |
| `+` | Keys pressed together | `Ctrl+Alt+F3` |
| `then` (with spaces) | One step after another | `Alt+PrtSc then REISUB` |
| ` / ` (with spaces) | Alternatives | `Super+← / →` |
| Spaces without `+` | Keys typed one after another | `R E I S U B` |
| `hold`, `press`, `tap` | Shown as plain words, not as keys | `Hold Super` |

Common key names are shown in a tidier form: `Left`, `Right`, `Up` and `Down` become arrows,
`Control` becomes `Ctrl`, `Escape` becomes `Esc`, `PageUp` becomes `PgUp`, and so on.

### Adding your own entries

The cheatsheet only displays shortcuts; it does not create them. To add a new shortcut, first set it
up in Settings > Keyboard > View and Customize Shortcuts > Custom Shortcuts, then list it in the
file. For example, to add a section of your own, put a new entry in the `sections` list:

```json
{
  "title": "My shortcuts",
  "items": [
    {"keys": "Super+T", "desc": "Open a terminal"},
    {"keys": "Super+E / Ctrl+Alt+E", "desc": "Open Files", "zh": "打开文件"}
  ]
}
```

Remember the comma between sections, and save the file. Hold `Super` to check the result.

To go back to the default list, for example after an update adds new entries, rename or delete the
file. A fresh copy with the current defaults is written the next time you hold `Super`.

## Troubleshooting

**The sheet does not appear.**
Hold `Super` completely still: any other key, click or mouse movement before the sheet appears cancels
it, and so does holding `Shift`, `Ctrl` or `Alt` at the same time. Check that the extension is
enabled with `gnome-extensions info shortcut-cheatsheet@zihan.local`.

**The overview opened instead.**
`Super` was released before the sheet appeared, which counts as a tap. Hold a little longer, or lower
`hold_ms`.

**A red error line appears at the top of the sheet.**
The file has a mistake, such as a missing comma or quote, or `sections` is not a list. Until it is
fixed the sheet shows the default list. To find the error, run:

```sh
python3 -m json.tool ~/.config/shortcut-cheatsheet/shortcuts.json
```

**My changes do not show up.**
Make sure the file is saved; changes apply the next time the sheet appears. A section with no items
is not shown.

**The text is too small.**
The sheet shrinks to fit the screen. Remove entries you do not need, or try a different `columns`
value.

## See also

- [emoji-picker.md](emoji-picker.md): the Emoji Picker (`Super+.`)
- [workspaces.md](workspaces.md): per-monitor workspaces
- [quick-answers.md](quick-answers.md): instant answers in the overview search
- [Feature inventory](../FEATURES-INVENTORY.md)
- [Project README](../../README.md)
