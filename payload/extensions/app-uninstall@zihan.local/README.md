# App Uninstall (app-uninstall@zihan.local)

GNOME Shell 50 extension for Ubuntu 26.04. It adds **Uninstall** (or **Remove from
App List** for the user's own launchers) to an app icon's menu. The menu opens on a
right click, on press-and-hold (a held mouse button works too) or with the Menu key.
It works in:

- the app grid, its folders, overview search results and the stock dash (`AppMenu`)
- the Ubuntu Dock / Dash to Dock (`DockAppIconMenu`, hooked through the live dock module)

## Files

| file | role |
|---|---|
| `extension.js` | menu hooks, confirmation flow, removal safety checks, notifications |
| `dialog.js` | the confirmation `ModalDialog` (Cancel is the default; Enter and Escape cancel) |
| `backends.js` | PackageKit (deb), snapd REST (snap), `flatpak`, Trash (local); GIO-only and fully async |
| `classify.py` | classifies every desktop entry; run off the main loop with `python3 -I` |
| `protected-apps.txt` | backstop list (see below) |

## What is protected (no menu item)

`classify.py` derives the protected set from data, not from a list typed by hand:

- **debs**: it starts from the Ubuntu seed metapackages (`ubuntu-minimal`,
  `ubuntu-standard`, `ubuntu-desktop-minimal`) plus every Essential package and every
  package with Priority required or important. From there it follows the installed
  Depends, Pre-Depends and Recommends, as apt does, to get the closure. Alternatives
  resolve as apt resolves them, so a browser the user added does not get swept in
  through `Provides: www-browser`. Every protected app reports the chain that pulled
  it in, e.g. `nautilus <- ubuntu-desktop-minimal`.
- **snaps**: the installer seed (`/var/lib/snapd/seed/seed.yaml`) and every snap whose
  type is not `app`. Snaps that the preload image added to the stock seed (listed in
  `/var/lib/preload/seed-added-snaps`, written by the image build) are ordinary apps,
  not part of Ubuntu, so they do get the item.
- entries that are NoDisplay or Hidden, and entries that no package manager owns
  (`/usr/local`, `.run` installers).
- **backstop**: `protected-apps.txt` here and `~/.config/app-uninstall/protected-apps.txt`.
  Each line is a desktop id, `deb:<pkg>` or `snap:<name>`. Both files only add to the
  protected set and can never un-protect anything. The shipped file protects
  `software-properties-gtk` (Additional Drivers, Software & Updates): Ubuntu 26.04 no
  longer seeds it, but it manages drivers and software sources.

`/var/log/installer` is readable by root only, so it is not used.

## Safety gate at removal time

- **deb**: PackageKit first simulates `RemovePackages(allow_deps=true)`. The removal
  is refused when it would take any protected package, any package matching the
  critical pattern (`ubuntu-desktop*`, `gnome-shell`, gdm, systemd, kernel and NVIDIA
  driver packages, …), when it would install or upgrade anything, or when it would take
  more than 15 packages. The real call removes exactly the simulated package ids with
  `allow_deps=false, autoremove=false`, so nothing beyond what the dialog listed can go.
  It never purges. Authorization goes through polkit's standard dialog
  (`org.freedesktop.packagekit.package-remove`).
- **snap**: snapd `POST /v2/snaps/<name> {"action":"remove"}` with
  `X-Allow-Interaction: true` (polkit), never `--purge`. snapd has no dry run, so the
  check is that the snap exists, is an app snap, and is not seeded.
- **flatpak**: `flatpak uninstall --user|--system -y <app>`. Data is kept and unused
  runtimes are not cleaned up.
- **local** (Chrome web apps, AppImage launchers, Wine or Steam shortcuts, hand-made
  launchers): the `.desktop` file goes to the Trash. An AppImage goes too, but only
  when it is a user-owned `*.AppImage` inside `$HOME` that the launcher's Exec runs.
- If a user-local launcher overrides a packaged app, the app is classified by its
  package. After a successful uninstall, the override goes to the Trash as well.

## Testing

    python3 -I classify.py --table      # what gets the item, and why (read-only)

`APP_UNINSTALL_DRY_RUN=1` in the shell's environment turns deb removals into PackageKit
simulations of the exact final call and skips snap and flatpak removals.
