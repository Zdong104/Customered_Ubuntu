# Changelog

Installed machines pick up each release automatically (see
[Automatic updates](../README.md#automatic-updates)). Run `preload-update --status` to see which
version you have. GNOME Shell extensions take effect after you log out and back in.

## v2026.11.13

### New

- **[Quick Answers](features/quick-answers.md)** in the overview search: units, temperature, time
  zones, date math, Unix timestamps, currency, colours and number bases, weather, definitions, parcel
  tracking links and flight numbers. It ships without a key; the flight-status card can use your own
  free AeroDataBox key.
- **[Emoji Picker](features/emoji-picker.md)** on `Super+.` or `Ctrl+Super+Space`, with English and
  Chinese search, `1`–`9` picking and a recently used list. It uses Noto Color Emoji.
- **[Shortcut Cheatsheet](features/shortcut-cheatsheet.md)**: hold `Super` to see every shortcut;
  add your own in `~/.config/shortcut-cheatsheet/shortcuts.json`.
- **[Stability Guard](features/stability-guard.md)**: a local black-box log of desktop events with
  the `desktop-blackbox-report` command, and a recorder that tells you when a hung logout switched
  your extensions off. Nothing leaves your computer.
- **[Dock Pull Window](features/workspaces.md#dock-pull-window)**: a dock click (or `Super+1`…`9`)
  brings a normal window to your current workspace instead of switching workspaces.
- **[Notification Banners](features/notifications.md#notification-banners)**: banners close after
  at most 5 seconds and no longer queue up; in full screen, only the app in front has its banners
  held back.
- **Tidy notifications**: an app's notifications and its dock badge clear once you have looked at
  the app, and notifications from Chrome web apps (Teams, Outlook, Google Chat and others) are filed
  under the web app instead of "Google Chrome".
- **[Real paths from Recent](features/files.md#real-paths-when-copying-from-recent)**: copying an
  item in Files' Recent view pastes its real path instead of a `recent:///` address.
- **Uninstall from the app menu**: right-click (or press and hold) an app in the app grid or the dock
  and choose Uninstall. Works for debs, snaps, Flatpaks and your own launchers; apps that are part
  of a minimal Ubuntu install are protected, and removals that would take part of the system with them are refused.
- **Mac-style line navigation**: `Ctrl+←` / `Ctrl+→` jump to the start or end of the line, and
  `Ctrl+Shift+←` / `Ctrl+Shift+→` select to it. `Ctrl+Home` / `Ctrl+End` are unchanged.
- **[macOS-style pinyin themes](features/pinyin-input.md#macos-style-themes-that-follow-light-and-dark)**:
  light and dark candidate bars, and cloud pinyin that no longer makes the bar blink.
- **IME Cursor Scale**: the pinyin candidate bar now appears at the right place in GNOME Shell's own
  text fields on monitors with a different scale.
- **[ONLYOFFICE Desktop Editors with ProCharts](features/procharts.md)**: installed from
  ONLYOFFICE's repository so it updates with the system, with the ProCharts business-chart plugin for
  presentations available to every user.

### Improved

- Workspace Manage, Maximize to Own Workspace, No Sticky Windows, Title Bar Below Top Bar, Thumbnail
  Wallpaper and DND Hides Critical are more robust on the lock screen, when monitors are unplugged,
  and against a GNOME Shell crash during window grabs. No Sticky Windows now also covers Chrome and
  Electron apps.
- The install package is English-only.

### Fixed

- **fcitx5 now starts at login on fresh installs.** Previously GNOME started IBus instead, so pinyin
  and the new themes did not work for new users. Existing users who still had the old default theme
  are switched to the macOS-style theme once; any other theme choice is kept.
- **WeChat uses the system pinyin candidate bar** instead of drawing its own blinking popup, and
  still sends desktop notifications. Known limitation: if WeChat is started some other way than from
  the dock or app grid (for example by a login item WeChat creates itself), it shows its own popup
  again. See [Chinese input](features/pinyin-input.md#wechat).
- **"Combine Images into PDF" and "Send with LocalSend"** now also appear for items in Files' Recent
  view.
- The Emoji Picker no longer fills the system log with font warnings.

### No longer installed

Blender, FreeCAD, Inkscape, PDF Arranger, iCloud for Linux and cc-switch are no longer installed on
new machines. **Machines that already have them keep them**: nothing is uninstalled, and they keep
receiving updates through apt, snap or their own updater as before. The Files "Combine Images into
PDF" item uses View, not PDF Arranger, so it is unaffected.

## v2026.11.09

Earlier releases are not itemised here. See the [feature inventory](FEATURES-INVENTORY.md) for
everything included up to this release.
