# Customered_Ubuntu

One command turns an **Ubuntu 26.04 Desktop** (x86_64, GNOME) into the owner's setup: everyday apps, developer tools,
Chinese input (fcitx5 Pinyin), a set of GNOME desktop extensions and default settings. After that, whenever the
owner improves the configuration, your machine **updates itself in the background** and shows a notification when it
is done. No personal data of the owner is included.

## Install

1. Open a terminal (`Ctrl+Alt+T`).
2. Paste this command, press Enter and type your login password: `wget -qO- https://raw.githubusercontent.com/Zdong104/Customered_Ubuntu/main/bootstrap.sh | sudo bash`
3. When it says the installation is complete, log out and back in once (and restart once more if it says a restart is needed).

The first install takes about 30-60 minutes and needs a network connection; you can keep using the computer meanwhile.
If it gets interrupted, run the same command again: it continues where it stopped.
Software that is already installed (Chrome, VS Code, WeChat, Zoom, Miniconda, TinyTeX, snap apps, ...) is reported as
"already installed, skipped" and not downloaded again.
If a single download fails (for example a vendor's download URL is temporarily unavailable), the installation does not
stop: the failed items are listed at the end and retried automatically in the background.

Optional: end the command with `| sudo bash -s -- --reset-desktop` to immediately reset **your own** desktop
appearance to the owner's (only the options listed under "Desktop defaults" below). Without this flag, every setting
you have already changed is kept.

Before installing, it checks: Ubuntu 26.04, x86_64, GNOME desktop, at least 25 GB free on the system disk, and that
GitHub is reachable. If any check fails it explains why and changes nothing on the machine. A battery below 30% only
produces a reminder to plug in.

## What you get

### Apps

| Category | Contents |
|---|---|
| Browsers / AI | Google Chrome, Firefox (Mozilla's official .deb, not the snap), Claude desktop, ChatGPT desktop |
| Communication | WeChat, Zoom, Slack, Discord |
| Editing / office | VS Code, ONLYOFFICE Desktop Editors (with the ProCharts presentation plugin), img2pdf, Showtime video player, Remmina remote desktop |
| Other snaps | Cheese camera, nvtop (GPU monitor), astral-uv, View, LocalSend (local-network file transfer similar to AirDrop; runs in the tray after login) |
| Virtualization / containers | QEMU + libvirt + virt-manager (with UEFI/OVMF and swtpm TPM emulation), Docker |
| Media / drivers | Common codecs (ubuntu-restricted-addons), Intel hardware video decoding |
| Tools | tmux, 7zip, zstd, clipboard tools, etc. |

### Development environment

- Toolchain: build-essential, cmake, autotools, pkg-config, git, Node.js + npm, Python 3 (pip/venv/dev), Java (OpenJDK 25), Vulkan tools and a set of common development headers.
- Command-line AI tools: **Claude Code** and **Codex** (global npm, under `/usr/local`).
- **Miniconda**: installed in `/opt/miniconda3`, available to all users, not auto-activated by default (run `conda activate` when needed); your own environments live in `~/.conda`.
- **TinyTeX** (including XeLaTeX, so Chinese documents compile out of the box), commands in `/usr/local/bin`.
- The **uv** tool `harbor`.

### Chinese input

- **fcitx5 Pinyin** (with cloud Pinyin), Chinese and English language packs, Noto CJK and AR PL (Arphic) fonts; new and existing users both default to fcitx5 after login (`Ctrl+Space` to switch).
- Fixes the **mispositioned candidate window** in Chrome / Claude desktop under Wayland by launching them under XWayland (re-applied automatically after every package upgrade).
  Launchers of Chrome web apps (PWAs, e.g. Outlook / Teams on the web) get the same treatment, and are switched back automatically whenever Chrome regenerates them.

### Voice input: Vocalinux

- Local, offline speech-to-text (whisper.cpp, with Vulkan GPU acceleration and automatic CPU fallback), started in the background after login; the model is downloaded on first use.
- Includes a touchpad palm-rejection fix: Vocalinux grabs the built-in keyboard, which breaks "disable touchpad while typing"; a libinput quirk repairs it.
- Text injection defaults to `ydotool` (clipboard paste), because the default "auto" method drops Chinese text under Wayland. An existing user's configuration is switched automatically at the next login as long as it still says "auto".

### GNOME extensions

| Extension | What it does |
|---|---|
| Workspace Manage | Manage workspaces like macOS Mission Control: drag thumbnails in the overview to reorder, "+" to add one, and a "×" appears at a thumbnail's top-right on hover to delete it (its windows move to the neighbouring workspace); works on the primary and secondary screens, and thumbnails can be dragged between the two. When an external monitor is unplugged, each workspace of the secondary screen becomes its own workspace on the primary screen instead of all being crowded into the current one. |
| Maximize to Own Workspace | A maximized or full-screen window gets its own workspace and is merged back when un-maximized; works on secondary screens too. **Split View**: in the overview, drag a window onto the left or right half of a full-screen workspace thumbnail and the two windows each take half (primary and secondary screens). |
| Workspace Islands | The secondary screen gets its own independent set of workspaces (stock GNOME only has workspaces on the primary screen). |
| Hide Minimized | Minimized windows no longer appear in the overview and Alt+Tab; restore them from the Dock or Super+Tab (they are still shown when clicking a Dock icon expands all windows of that app). |
| Title Bar Below Top Bar | A window's title bar is never hidden behind the top bar (common with Chrome web apps under XWayland); while dragging, the window only moves to the screen above once the pointer crosses the top bar. |
| No Sticky Claude | The Claude desktop window stays on a single workspace instead of "showing on all workspaces". |
| Raise Browser | Brings Chrome to the front when you click a link in WeChat and similar apps (it does not by default under Wayland). |
| Thumbnail Wallpaper | The workspace thumbnails at the top of the overview show the wallpaper instead of plain gray. |
| DND Hides Critical | With Do Not Disturb on, even "critical" notification banners (for example web Teams messages) are not shown; notifications still go to the notification list. |
| Cursor Tracker | Exposes the pointer position over D-Bus for screen-automation tools. |
| Desktop icons (DING) patches | Press Space on a desktop file for a quick Sushi preview; desktop icons are shown only on the primary screen. The patches are re-applied automatically after system upgrades. |
| Ubuntu built-ins | Dock, Tiling Assistant, desktop icons, etc. stay enabled. |

Each extension is enabled for you only once: if you switch one off in the Extensions app, it stays off.

### File manager (Files)

- **Recent folders** appear under "Recent" (GNOME only shows files by default); open them directly or drag files into them.
- Files under "Recent" show correct **thumbnails**.
- Context menu **"Send with LocalSend"**: sends the selected files or folders to nearby devices.
- Context menu **"Convert to PDF / Combine Images into PDF"** (when images are selected): combines them into one PDF in file-name order using View.
- Defaults: list view, zip as the default compression format, path bar in file chooser dialogs, folders sorted first.

### Desktop defaults

These are only **defaults**: settings you change yourself always win, and automatic updates never overwrite them.

- Dark mode (Yaru-dark), battery percentage shown, hot corner on, wallpaper "Twin brothers".
- A fixed single workspace (add more with Workspace Manage), workspaces switch on the primary screen only; Alt+Tab shows windows from all workspaces.
- Dock icon size 42; favorites: Files, Chrome, VS Code, Claude, Settings, WeChat, App Center, Terminal, Text Editor, View.
- Tiling Assistant: orange focus hint, and the tiling popup shows windows from all workspaces.
- Tap to click, two-finger scrolling, touchpad disabled for 1.5 s while typing; slightly faster mouse/touchpad speed.
- Power: no automatic screen blanking, dimming or suspend, on AC or battery; power-saver mode is not forced at low battery.
- Eye-care reminder: a 5-minute break reminder every 30 minutes. Night Light color temperature 3330K (whether it is on is up to you).
- Error reports are not sent automatically.

### Hardware

- **NVIDIA GPUs**: if no driver is installed yet, the driver Ubuntu recommends is installed automatically (an existing driver is left alone).
- **ThinkPad P1 Gen 8** (detected by model; other computers are unaffected): fixes for the internal display going black or flickering (PSR disabled, panel automatically re-lit, `Super+Shift+D` for a manual fix), Thunderbolt 5 external displays, NVIDIA PRIME on-demand mode, and automatic restart of PipeWire audio after a crash.

### Freeze recovery

Magic SysRq is enabled (`kernel.sysrq = 240`): when the desktop is completely frozen, hold `Alt+PrtSc` and press `E I S U B` in turn to reboot safely (terminate processes, sync disks, remount read-only, reboot) without holding the power button.

### Groups

To make voice input and virtualization work out of the box, all users join the `input` group; administrators (sudo group) additionally join `adm kvm libvirt docker`.
Note: the `docker` group is equivalent to root, and the `input` group can read keyboard input.

## Automatic updates

- A background check runs 15 minutes after every boot and once a day (randomly delayed by up to 2 hours); it is skipped on battery below 30% or on a metered connection (phone hotspot).
- It runs at low priority (4 GB memory cap) without disturbing normal use, and only installs what is missing or changed, so already installed items are not reinstalled; typically a few seconds to a few minutes.
- If GNOME extensions or desktop settings changed, the notification asks you to log out and back in for them to take effect (under Wayland, extensions are loaded only at login).
- When finished it shows a notification such as "Desktop configuration updated to vX"; failed items are retried automatically later.
- It only **adds or updates** things: packages are never removed automatically (unless explicitly listed in `payload/remove.txt`);
  configuration files the owner no longer ships are deleted, and if a file of the same name existed on your machine before, your original version is restored.
- System upgrades themselves (kernel, packages) remain the job of Ubuntu's own Software Updater.

Useful commands:

```
preload-update --status          # current version, last update result, next check time
sudo preload-update --now        # check and update right now
sudo preload-update --check      # only check whether a new release exists
preload-update --rollback-info   # update history, and how to undo
```

### Security

The updater runs code from the repository as root, so it accepts only releases signed with the owner's **signing key**:

- Only annotated tags named `vYYYY.MM.DD[.N]` are accepted, verified with `git verify-tag` against an SSH signature; the public key is pinned at install time in
  `/etc/preload/allowed_signers` (and also embedded in `bootstrap.sh`). Branches and unsigned or third-party-signed commits are never executed.
- The signed name inside the tag object must match the tag name, so an old signed tag cannot be replayed under a new name; versions only go up, never down.
- Every run executes a clean copy (`git archive`) of the tagged commit, downloaded over HTTPS only.
- To rotate the key: sign a release that contains the new public key with the old key.

In other words, even if the GitHub repository is tampered with, your machine will not run the change unless the private signing key has leaked. See `preload-update --status`.

## What is not included

No personal data of the owner: no documents, browser profiles, chat history, keys/SSH/GPG, Wi-Fi passwords, printers, virtual machine or container images,
conda environments, tokens or AI-tool logins, and no account is created and your hostname is not changed. A leak scan runs automatically before every release.

## Stopping updates / uninstalling

```
sudo preload-update --disable      # stop automatic updates (everything installed is kept)
sudo systemctl enable --now preload-update.timer   # turn them back on
sudo preload-update --uninstall    # remove the updater itself (installed software and settings are kept)
```

Installed software can be removed as usual with App Center, `sudo apt remove` or `sudo snap remove`; extensions can be switched off in the Extensions app;
to restore stock Ubuntu desktop defaults, delete `/usr/share/glib-2.0/schemas/90_preload.gschema.override` and run
`sudo glib-compile-schemas /usr/share/glib-2.0/schemas`.

## For the owner: releasing

```
# edit payload/ (or updater/), commit, then:
./release.sh -m "what changed"       # clean tree, leak scan, next vYYYY.MM.DD[.N], SSH-signed tag, verified
git push origin HEAD:main && git push origin vYYYY.MM.DD     # printed by release.sh; nothing ships before this
```

- The signing key is `~/.ssh/preload-release` (ed25519, created without a passphrase). Add one with
  `ssh-keygen -p -f ~/.ssh/preload-release`; release.sh then asks for it. Keep an offline backup: without it,
  installed machines cannot be updated (each would need `sudo rm /etc/preload/allowed_signers` and a re-run
  of the install command with a new key).
- Key rotation: add the new public key to `updater/allowed_signers` and `bootstrap.sh`, release signed with the
  old key, then sign with the new key and drop the old line in a later release.
- The leak scan needs the private patterns file `~/.config/preload/leak-patterns.sh`
  (template: `test/leak-patterns.example.sh`). `test/leakscan.sh --history` scans every commit.
- Each step of `payload/provision.sh` re-runs on a machine only when its inputs change (its own code, its
  payload files, or its `sources.conf` line); "latest" download URLs are refetched only when their line changes.
- Tests: `test/update-e2e.sh` (bootstrap, refused tags, downgrade, incremental update, ISO-style install, in a
  disposable systemd container; needs docker).
- The bootable ISO for new machines is built from the same payload: see [docs/ISO.md](docs/ISO.md).
