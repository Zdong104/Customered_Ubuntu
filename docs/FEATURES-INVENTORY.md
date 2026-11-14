# Features inventory

One entry per feature this package adds to (or changes in) a stock Ubuntu 26.04 Desktop.
Each entry says what it does compared with stock Ubuntu, how to use it, and where it lives in
the repository (paths are relative to the repository root).

Notes that apply to every GNOME Shell extension below:

- Extensions are installed system-wide and enabled once per user. If you turn one off in the
  Extensions app, it stays off.
- On Wayland, a new or updated extension only takes effect after you log out and back in.
- Extension shortcuts are the defaults shipped with the package; you can change most of them
  with `gsettings` or the Extensions app.

Contents:

1. [GNOME Shell extensions (new)](#1-gnome-shell-extensions-new)
2. [GNOME Shell extensions (existing / updated)](#2-gnome-shell-extensions-existing--updated)
3. [Input method](#3-input-method)
4. [Stability Guard](#4-stability-guard)
5. [Other system and desktop features](#5-other-system-and-desktop-features)

---

## 1. GNOME Shell extensions (new)

### Dock Pull Window

Stock GNOME switches you to another workspace when you click a dock icon whose window lives there.
With this extension, a normal (non-maximized) window is brought to the workspace you are on instead,
and a minimized one is restored there too. Maximized, full-screen and Split View windows, and clicks
made while you are in a full-screen space, keep the stock behaviour (you are switched to them). On a
secondary monitor the window joins that monitor's visible workspace.

**How to use:** click a dock icon, press `Super+1`…`Super+9`, or pick a window from the dock icon's
window spread or "All Windows" menu. Alt+Tab and overview clicks are unchanged.

**Source:** `payload/extensions/dock-pull-window@zihan.local/`

### Emoji Picker

Adds a macOS-style emoji picker, which stock GNOME does not have at the shell level. It opens near
the text cursor (or centred on the focused window's monitor), supports English and Chinese keyword
search, and remembers recently used emoji. The chosen emoji is pasted into the app you were typing in
through the clipboard, and your previous clipboard is put back afterwards. Emoji are drawn with the
standard Noto Color Emoji font (no Apple emoji font is shipped).

**How to use:** `Super+.` or `Ctrl+Super+Space` opens/closes it. Type to search, arrow keys to move,
`Enter` to insert, `1`–`9` to pick from the highlighted row, `Tab` or `Ctrl+Left/Right` to change
category, `Esc` to close. Terminals automatically get `Ctrl+Shift+V` instead of `Ctrl+V`.

**Source:** `payload/extensions/emoji-picker@zihan.local/` (keybinding and options in
`schemas/org.gnome.shell.extensions.emoji-picker.gschema.xml`)

### IME Cursor Scale

Fixes the pinyin candidate bar appearing in the wrong place (often at half the coordinates, on another
monitor) when typing into GNOME Shell's own text fields, such as the overview search box or the emoji
picker, with display scaling on. It scales the reported cursor position so the bar appears right under
the cursor, and keeps the bar visible above the overview and the emoji picker.

**How to use:** automatic.

**Source:** `payload/extensions/ime-cursor-scale@zihan.local/`

### Notification Banners

Stock GNOME can leave a banner on screen until you next touch the keyboard or mouse, never times out
"critical" banners (such as Chrome/Teams messages), queues old banners to show one after another, and
holds back all banners while any window is full screen. With this extension every banner closes after
at most 5 seconds (unless you hover it), a new banner replaces the one on screen instead of queuing,
and stale queued banners are dropped. Under full screen, only banners from the app in front of you are
suppressed; banners from other apps still appear. Do Not Disturb still holds everything.

**How to use:** automatic.

**Source:** `payload/extensions/notification-banners@zihan.local/`

### Recent Clipboard Paths

In stock Files, copying an item in the "Recent" view puts an internal `recent:///…` address on the
clipboard, which other apps cannot use. This extension rewrites the clipboard to the real file: pasting
as text gives the normal path, and pasting into a file manager pastes the actual file. It includes a
small compiled helper (a C GIOModule) because GNOME Shell's JavaScript cannot offer several clipboard
formats at once.

**How to use:** automatic. Copy (`Ctrl+C`) in Files' Recent view, then paste anywhere.

**Source:** `payload/extensions/recent-clipboard-paths@zihan.local/` (C helper source in `src/`,
prebuilt `libmultisource.so`)

### Shortcut Cheatsheet

Adds a macOS-style shortcut overlay. Holding the Super key alone shows a sheet of useful shortcuts
(window tiling, workspaces, screenshots, freeze recovery, and this package's own additions); releasing
it hides the sheet without opening the overview. A quick Super tap still opens the overview as usual.

**How to use:** hold `Super` for about 0.8 s. Pressing another key while holding Super cancels the
sheet and runs that shortcut. Edit `~/.config/shortcut-cheatsheet/shortcuts.json` (created with
defaults the first time the sheet is shown) to add or change entries; changes show the next time the
sheet opens.

**Source:** `payload/extensions/shortcut-cheatsheet@zihan.local/` (default list in `defaults.js`)

### Quick Answers (Smart Search)

Adds Spotlight-style instant answers at the top of the overview search, which stock GNOME does not
have. It converts units (`36F`, `70mph`, `6'7`, `3斤`), time zones (`3pm PST`, `time in Tokyo`), date
math (`days until Dec 25`), Unix timestamps, currencies (ECB rates), and hex/binary/colour values, and
offers lookups that open the browser (weather, `define <word>`, parcel tracking numbers, flight
numbers). It stays silent on anything it does not recognize. It ships without any API key: the inline
flight-status card needs your own free AeroDataBox (RapidAPI) key, and a guided setup dialog appears
the first time you search a flight number; without a key, flight searches still offer links to web
flight trackers.

**How to use:** press `Super` and type. `Enter` copies the top answer, or opens the page for lookups.
Optional settings (weather city, currency targets) go in `~/.config/smart-search/config.json`; see
`config.example.json`. The flight key goes in `~/.config/smart-search/aerodatabox.key` (the setup
dialog writes it for you).

**Source:** `payload/extensions/smart-search@zihan.local/` (setup guide in its `README.md`)

---

## 2. GNOME Shell extensions (existing / updated)

### Workspace Manage

Adds macOS Mission Control-style workspace management to the overview: drag thumbnails to reorder,
"+" to add a workspace, hover "×" to remove one (its windows move to the neighbouring workspace). It
works on the primary monitor and on secondary monitors, and thumbnails can be dragged between
monitors. Each monitor starts with one workspace, and workspaces you add persist even when empty. When
you unplug an external monitor, each of its workspaces becomes its own workspace on the laptop screen
instead of everything piling into the current one.

**How to use:** open the overview (`Super`) and use the thumbnail strip at the top.

**Source:** `payload/extensions/workspace-manage@zihan.local/`

### Maximize to Own Workspace (with Split View)

A maximized or full-screen window automatically gets a workspace of its own, and returns to its
previous workspace when un-maximized, much like macOS full-screen spaces; this also works on secondary
monitors. Split View: in the overview, drag a window onto the left or right half of a full-screen
space's thumbnail and the two windows share that space side by side. The pair ends when either window
is closed, minimized, moved away or re-maximized.

**How to use:** maximize a window (double-click its title bar or `Super+Up`). For Split View, open the
overview, drag a window onto the highlighted half of a full-screen thumbnail; drag the divider to
resize both.

**Source:** `payload/extensions/maximize-own-workspace@zihan.local/` (Split View in `split.js`)

### Workspace Islands (upstream)

Gives each secondary monitor its own independent set of workspaces; stock GNOME only has workspaces on
the primary monitor. This is an upstream extension fetched at a pinned version during install.

**How to use:** `Super+Alt+Left/Right` for the previous/next workspace on the current monitor,
`Super+Alt+1`…`4` to jump to workspace N on that monitor.

**Source:** fetched by `payload/provision.sh` (`step_extensions`) from the `ISLANDS` line in
`payload/sources.conf`

### Title Bar Below Top Bar

Never lets a window's title bar sit hidden under the GNOME top bar (common with Chrome web apps under
XWayland), so every window can still be grabbed and moved. When dragging, a window only crosses onto a
monitor above when the pointer itself crosses.

**How to use:** automatic.

**Source:** `payload/extensions/titlebar-below-panel@zihan.local/`

### Hide Minimized

Leaves minimized windows out of the overview and the Alt+Tab switcher, which stock GNOME still shows
there.

**How to use:** restore minimized windows from the dock (the dock's window spread still lists them) or
with `Super+Tab`.

**Source:** `payload/extensions/hide-minimized@zihan.local/`

### Thumbnail Wallpaper

Draws the desktop wallpaper behind the workspace thumbnails at the top of the overview, instead of
stock GNOME's plain grey.

**How to use:** automatic.

**Source:** `payload/extensions/thumbnail-wallpaper@zihan.local/`

### DND Hides Critical

With Do Not Disturb on, stock GNOME still shows "critical" banners (Chrome web apps such as Teams send
these). This extension hides those too; they still go to the notification list.

**How to use:** turn on Do Not Disturb in the notification/calendar menu (`Super+V`).

**Source:** `payload/extensions/dnd-hides-critical@zihan.local/`

### Raise Browser

When another app (WeChat, Files, etc.) opens a link, Chrome is brought to the front with the new tab.
On Wayland stock GNOME leaves Chrome behind the current window.

**How to use:** automatic.

**Source:** `payload/extensions/raise-browser@zihan.local/`

### No Sticky Windows (No Sticky Claude)

Some apps (the Claude desktop app, Chrome and other Chromium/Electron apps) can set themselves to
"Always on Visible Workspace", which makes them appear on every workspace and in every overview
thumbnail. This extension undoes that whenever it happens, so each window stays on one workspace.

**How to use:** automatic.

**Source:** `payload/extensions/no-sticky-claude@zihan.local/`

### Cursor Tracker

Exposes the mouse pointer position over D-Bus, for screen-automation and recording tools that cannot
read it on Wayland. It has no visible effect.

**How to use:** automatic (used by tools, not by you directly).

**Source:** `payload/extensions/cursor-tracker@cua/`

---

## 3. Input method

### fcitx5 pinyin as the default input method

Installs fcitx5 with pinyin and cloud pinyin, Chinese/English language packs and CJK fonts, and makes
fcitx5 the input method for every toolkit (GTK, Qt, XWayland, Electron). Pinyin is added as a second
input method: the US keyboard stays first, so typing starts in English.

On stock Ubuntu GNOME, fcitx5 never starts even when installed: im-config's autostart does nothing when
ibus is present, and GNOME starts ibus-daemon instead. The package starts fcitx5 at login for every
user and keeps ibus-daemon from starting while fcitx5 is the configured input method; GNOME Shell then
talks to fcitx5 through fcitx5's IBus frontend, so pinyin also works in the overview search.

**How to use:** `Ctrl+Space` switches between English and pinyin.

**Source:** `payload/rootfs/etc/skel/.config/fcitx5/` (`profile`, `config`, `conf/*.conf`),
`payload/rootfs/etc/environment.d/90-preload-fcitx5.conf`, `payload/rootfs/etc/skel/.xinputrc`,
`payload/rootfs/etc/xdg/autostart/org.fcitx.Fcitx5.desktop` (start at login),
`payload/rootfs/usr/lib/systemd/user/org.freedesktop.IBus.session.GNOME.service.d/90-preload-fcitx5.conf`
(no ibus-daemon), `payload/provision.sh` (`step_files`), packages in `payload/packages.txt`

### macOS-style candidate themes

Replaces the stock fcitx5 candidate bar look (dark bar with the GNOME accent colour) with macOS-style
themes: a rounded panel with a soft shadow and a blue highlight, in a light and a dark variant that
follow the system dark mode.

**How to use:** automatic. Themes are `mac-light` / `mac-dark`, selectable in fcitx5's Configure tool
under Classic User Interface. The themes are installed system-wide for every user; the setting that
selects them comes from `/etc/skel`, so it is the default for a user who does not already have their
own fcitx5 settings. Accounts that got the stock-theme settings from an earlier release are switched to
the mac themes once by the per-user sync, unless they picked another theme themselves. The generator
script is `tools/make_mac_themes.py` (repository only).

**Source:** `payload/rootfs/usr/share/fcitx5/themes/` (`mac-light/`, `mac-dark/`),
`payload/rootfs/etc/skel/.config/fcitx5/conf/classicui.conf`, migration in `updater/preload-user-sync`

### Cloud pinyin without flicker

With stock settings, long pinyin input makes the candidate bar blink on every key, because the cloud
candidate in slot 2 shows a loading placeholder and then changes size. The cloud candidate is moved to
the last slot of the page (`CloudPinyinIndex=9`) and its loading animation is turned off, so the local
candidates stay still.

**How to use:** automatic. Pick the cloud candidate with `9`. `Ctrl+Alt+Shift+C` toggles cloud pinyin.

**Source:** `payload/rootfs/etc/skel/.config/fcitx5/conf/pinyin.conf`

### Candidate window position in Chrome, Claude and Electron apps

On Wayland, fcitx5 places the candidate window in the wrong spot in Chrome, the Claude desktop app and
other Electron apps when monitors use different scaling. These apps are launched under XWayland
instead, where the window lands at the cursor. Launchers are re-patched automatically after package
upgrades, and Chrome web-app (PWA) launchers are re-patched whenever Chrome regenerates them.

**How to use:** automatic.

**Source:** `payload/rootfs/usr/local/lib/preload/reapply.sh`, `payload/rootfs/etc/apt/apt.conf.d/99preload-reapply`,
`payload/rootfs/usr/local/bin/chrome-pwa-x11-patch`, `payload/rootfs/usr/lib/systemd/user/chrome-pwa-x11.{path,service}`,
`payload/rootfs/etc/xdg/autostart/google-chrome-x11.desktop`

---

## 4. Stability Guard

### Desktop black-box logger

A background user service that records desktop events stock Ubuntu does not log in one place: screen
lock/unlock, display power, monitors connected or disconnected, suspend/resume, lid, GNOME Shell
restarts, and extensions being switched off. After each event it takes short snapshots and collects
related journal errors and anomalies (for example a window stuck on every workspace). A report command
summarizes what went wrong and after which event.

**How to use:** runs automatically after login. Run `desktop-blackbox-report` (options: `--since 7d`,
`--last N`, `--json`) to see the summary. The log is kept in `~/.local/state/desktop-blackbox/`.

**Source:** `/usr/local/bin/desktop-blackbox`, `/usr/local/bin/desktop-blackbox-report` and the user
unit `desktop-blackbox.service`, shipped under `payload/rootfs/usr/local/bin/` and
`payload/rootfs/usr/lib/systemd/user/`

### Logout-hang recorder

GNOME Shell can hang on logout and get force-killed, which can make GNOME switch off all user
extensions at the next login. This small service checks the journal shortly after each login, records
any such incident, and sends a notification (urgent if extensions were switched off) so you know why
your extensions look "gone".

**How to use:** automatic. Incidents are listed in `~/.local/state/shell-logout-hangs.log` and in
`desktop-blackbox-report`. If extensions were switched off, turn them back on in the Extensions app.

**Source:** `/usr/local/bin/shell-logout-hang-log` and the user unit `shell-logout-hang-log.service`,
shipped under `payload/rootfs/usr/local/bin/` and `payload/rootfs/usr/lib/systemd/user/`

### Fixes built into the extensions

These have no controls of their own; they make the extensions above survive situations that broke
them before.

- **Lock-screen survival.** Stock GNOME turns extensions off while the screen is locked and back on at
  unlock, which re-sorted workspaces after many unlocks. Workspace Manage, Maximize to Own Workspace
  and DND Hides Critical declare `session-modes` so they stay on through the lock screen.
  *Source:* `metadata.json` of those extensions.
- **Monitor-undock guards.** Workspace Manage and Thumbnail Wallpaper no longer act on stale monitor
  data while a dock or external monitor is being unplugged, and Workspace Manage rebuilds a
  disconnected monitor's workspaces on the remaining screen. *Source:*
  `payload/extensions/workspace-manage@zihan.local/undock.js` (plus guards in `primary.js`,
  `cross.js`, `islands.js`), `payload/extensions/thumbnail-wallpaper@zihan.local/extension.js`.
- **Grab-abort crash guard.** Works around an open GNOME/Mutter bug (mutter#5121) where clicking as a
  popup closes and an app switches workspace at the same moment crashes the whole shell.
  *Source:* `payload/extensions/maximize-own-workspace@zihan.local/extension.js` (`flushImplicitGrab`).
- **Desktop icons exemption.** After docking, the desktop-icons (DING) windows were treated as normal
  windows, moved to other workspaces and hidden, so desktop icons disappeared. They are now exempt.
  *Source:* `maximize-own-workspace@zihan.local/extension.js`, `workspace-manage@zihan.local/islands.js`.
- **Sticky-window fix.** Windows that make themselves visible on every workspace are reset (see No
  Sticky Windows above); the black-box logger flags any that slip through.
- **Emoji picker clipboard cap.** The emoji picker never saves or restores a clipboard larger than
  64 MB and copies the clipboard data it restores, so a huge or invalid clipboard cannot exhaust
  memory. *Source:* `payload/extensions/emoji-picker@zihan.local/extension.js` (`SNAPSHOT_MAX_BYTES`).

---

## 5. Other system and desktop features

### Applications and tools
Installs a curated set of apps (Chrome, Firefox as the Mozilla .deb rather than the snap, VS Code,
Claude and ChatGPT desktop, WeChat, Zoom, Slack, Discord, Blender, FreeCAD, Inkscape, virtualization
with QEMU/libvirt, Docker, and more) from vendor repositories, .deb downloads and snaps.
**How to use:** from the app grid. **Source:** `payload/packages.txt`, `payload/sources.conf`,
`payload/apt-sources/`, `payload/keys/`, `payload/rootfs/etc/apt/preferences.d/`

### Developer toolchains
Build tools, Node.js, Python, Java, Claude Code and Codex CLIs (global npm), TinyTeX with XeLaTeX, and
the `harbor` uv tool. **How to use:** from a terminal. **Source:** `payload/packages.txt`,
`payload/sources.conf` (`NPM`, `TINYTEX`, `UVTOOL`), `payload/provision.sh`

### Miniconda (shared)
System-wide Miniconda in `/opt/miniconda3`, available in every user's shell but not auto-activated;
your own environments go in `~/.conda`. **How to use:** `conda activate`. **Source:**
`payload/sources.conf` (`MINICONDA`), `payload/provision.sh` (`step_miniconda`, `step_files`)

### Vocalinux voice typing
Local, offline speech-to-text (whisper.cpp, GPU-accelerated through Vulkan when available) that starts
in the background at login and types into any app. Text is inserted with `ydotool` (clipboard paste),
because the default method drops Chinese text on Wayland. **How to use:** via its tray icon and
hotkey (default set in the shipped config: Left Alt, push-to-talk); the model downloads on first use.
**Source:** `payload/sources.conf` (`VOCALINUX`), `payload/rootfs/usr/local/bin/vocalinux*`,
`payload/rootfs/etc/skel/.config/vocalinux/config.json`, `payload/rootfs/etc/xdg/autostart/vocalinux.desktop`,
`payload/rootfs/etc/udev/rules.d/99-uinput.rules`, `payload/rootfs/etc/modules-load.d/uinput.conf`

### Touchpad palm rejection with Vocalinux
Vocalinux re-emits the internal keyboard through a virtual device, which stopped "disable touchpad
while typing" from working. A libinput quirk marks that virtual keyboard as internal so palm taps are
ignored again. **How to use:** automatic. **Source:** `payload/rootfs/etc/libinput/local-overrides.quirks`

### LocalSend
AirDrop-like file sharing on the local network, started hidden in the tray at login.
**How to use:** tray icon, or right-click files in Files and choose "Send with LocalSend".
**Source:** `payload/sources.conf` (snap), `payload/rootfs/etc/xdg/autostart/localsend.desktop`,
`payload/rootfs/usr/share/nautilus-python/extensions/localsend-send.py`

### Files: recent folders
Stock Files shows only files in "Recent"; recently used folders now appear there too and can be opened
or dropped onto. **How to use:** automatic. **Source:** `payload/rootfs/usr/local/bin/recent-folders`,
`payload/rootfs/usr/lib/systemd/user/recent-folders.service`

### Files: thumbnails in Recent
Files cannot generate thumbnails for items in the Recent view; a small service generates them for the
real files so Recent shows previews. **How to use:** automatic. **Source:**
`payload/rootfs/usr/local/bin/recent-thumbnails`, `payload/rootfs/usr/lib/systemd/user/recent-thumbnails.service`

### Files: images to PDF
A right-click item for selected images ("Convert to PDF" / "Combine Images into PDF") that merges them
into one PDF in file-name order. **How to use:** select images, right-click. **Source:**
`payload/rootfs/usr/share/nautilus-python/extensions/view-images-to-pdf.py`

### Desktop icons (DING) patch
Space bar on a desktop file opens a quick preview (Sushi), and desktop icons stay on the primary
monitor. Re-applied automatically after package upgrades. **How to use:** select a desktop icon and
press `Space`. **Source:** `payload/rootfs/usr/local/lib/preload/ding-local.patch`,
`payload/rootfs/usr/local/lib/preload/reapply.sh`

### Desktop defaults
Dark theme, battery percentage, hot corner, one static workspace to start, workspaces on the primary
monitor only, dock size and favourites, tiling assistant colours, tap-to-click, no automatic screen
blank or suspend, break reminders, no automatic error reports. These are defaults only: settings you
change yourself always win. **How to use:** automatic. **Source:** `payload/dconf/defaults.ini`
(compiled to `/usr/share/glib-2.0/schemas/90_preload.gschema.override`)

### Magic SysRq recovery
Enables Magic SysRq so a frozen desktop can be recovered from the keyboard instead of the power button.
**How to use:** hold `Alt+PrtSc` and press `F` to kill the biggest memory user, or type `R E I S U B`
slowly for a safe reboot. **Source:** `payload/rootfs/etc/sysctl.d/90-sysrq.conf`

### User groups
All users join `input` (needed by Vocalinux); administrators also join `adm`, `kvm`, `libvirt` and
`docker`. Note that `docker` membership is equivalent to root. **How to use:** automatic, effective at
next login. **Source:** `payload/rootfs/usr/local/sbin/preload-user-groups`,
`payload/rootfs/etc/systemd/system/preload-user-groups.{path,service}`

### Per-user sync for existing accounts
Accounts that existed before installation get the package's default user files and extensions once,
at login, without overwriting anything they already have; anything you delete or disable stays that
way. **How to use:** automatic. **Source:** `updater/preload-user-sync`, `updater/preload-user-sync.service`

### NVIDIA driver
Installs Ubuntu's recommended NVIDIA driver when an NVIDIA GPU is present and no driver is installed.
**How to use:** automatic. **Source:** `payload/provision.sh` (`has_nvidia`, `step_hw`)

### ThinkPad P1 Gen 8 hardware fixes
Applied only on that model: fixes for the internal panel going black or flickering (PSR off, automatic
panel relight), Thunderbolt 5 external displays, NVIDIA on-demand mode, and audio service auto-restart.
**How to use:** automatic; `Super+Shift+D` re-lights the internal panel manually. **Source:**
`payload/rootfs/usr/local/lib/preload/hw/thinkpad-p1-gen8/`

### Signed automatic updates
A background updater checks for new releases after boot and daily, installs only what changed, and
notifies you when done. It runs only SSH-signed release tags verified against a pinned key (no
branches, no downgrades, HTTPS only), and skips metered connections and low battery.
**How to use:** automatic; `preload-update --status`, `sudo preload-update --now`,
`sudo preload-update --disable`. **Source:** `updater/` (`preload-update`, `preload-update.{service,timer}`,
`allowed_signers`), `bootstrap.sh`

### Installer image (ISO)
A bootable installer for new machines is built from the same payload. **How to use:** see
`docs/ISO.md`. **Source:** `iso/`, `docs/ISO.md`

### First-boot setup
On machines installed from the image, SSH host keys are generated on first boot (OpenSSH is installed
but left disabled). **How to use:** automatic. **Source:** `payload/rootfs/usr/local/sbin/preload-firstboot`,
`payload/rootfs/etc/systemd/system/preload-firstboot.service`
