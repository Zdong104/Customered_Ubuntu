# Building the preload ISO

Besides the one-command install (see the README), the same payload builds a
bootable USB/ISO that installs Ubuntu 26.04.1 Desktop with all of this
already in place, for a brand-new machine. It carries the software and desktop
customizations but **none of the owner's data or identity**: the first
account, password, hostname, language, keyboard and timezone are set on first
boot by GNOME Initial Setup (OOBE). Machines installed from the ISO also get
the auto-updater, and start out at the release the image was built from.

How it works: the stock Ubuntu ISO and installer are kept. One extra casper
layer, `minimal.standard.preload.squashfs`, is stacked on the stock
`minimal` + `minimal.standard` layers, and `install-sources.yaml` points the
installer at it. Canonical's OEM ISOs use the same structure. GRUB boots the
installer with an autoinstall cloud-config from the medium
(`ds=nocloud;s=/cdrom/preload/...`).

## Boot menu

| Entry | What happens |
|---|---|
| Install Ubuntu (preload) - create your account on first boot | Installer asks only for the disk (interactive storage; nothing is wiped without confirmation). No user is created (`user-data: users: {}`); GNOME Initial Setup creates the first user, with a hostname field, on first boot. |
| Install Ubuntu (preload) - classic installer, create account now | Normal installer pages (language, keyboard, network, disk, account, timezone). Use this if the first-boot path misbehaves. |
| ... safe graphics | First entry with `nomodeset`. |

Installs fully **offline**. With network it also gets updates and extra drivers.

## Layout

```
payload/                 single source of truth for the ISO AND for live updates (reviewed whitelist)
  provision.sh           the engine; chroot mode (ISO build) or live mode (preload-update)
  packages.txt           Ubuntu archive packages
  remove.txt             packages every machine purges (the only way packages are removed)
  sources.conf           third-party repos/keys, vendor .debs, npm, toolchains, snaps
  apt-sources/ keys/     vendor apt source files + the two vendor keys not downloadable by URL
  extensions/            the owner's own GNOME Shell extensions + cursor-tracker@cua
  dconf/defaults.ini     whitelisted desktop defaults -> 90_preload.gschema.override
  rootfs/                files copied verbatim to / (scripts, units, udev, skel, autostart, hw gate)
updater/                 preload-update, its units, preload-user-sync, pinned signer key, repo URL
bootstrap.sh release.sh  friend installer / owner release tagging
build/
  lib.sh                 capped-scope re-exec + MemAvailable wait used by all scripts
  build-layer.sh         mount/provision/snaps/pool/cleanup/squash (run as root)
  snaps.py               add snaps (+ bases/content providers) to the seed, drop firefox/thunderbird
  gen-override.py        defaults.ini -> gschema override (plain + ":ubuntu" groups)
  make-iso.sh            stock ISO + layer -> out/preload-26.04.1-DATE.iso (boot records replayed)
iso/
  grub.cfg  install-sources.yaml.in
  preload/{oobe,interactive}/user-data   autoinstall configs
  preload/late.sh        drivers (online ubuntu-drivers + offline NVIDIA pool), P1 Gen 8 gate, machine-id
capture/capture.sh       READ-ONLY report of what changed on the owner's machine vs the payload
test/leakscan.sh         identity/secret/forbidden-path scan of the layer, the ISO, or the git repo
test/update-e2e.sh       bootstrap + signed-update test in a disposable systemd container
test/vm.sh               UEFI + Secure Boot + TPM libvirt VM for testing
work/ out/               build trees and output (git-ignored)
```

## Rebuild

Point `STOCK_ISO` at the stock `ubuntu-26.04.1-desktop-amd64.iso` (default:
`work/ubuntu-26.04.1-desktop-amd64.iso`, a symlink is fine).

Every script re-executes itself inside a transient systemd scope
(`MemoryMax=8G MemoryHigh=7G MemorySwapMax=2G CPUWeight=40 IOWeight=40`, `nice 15`,
`ionice idle`, see `build/lib.sh`), and waits before each heavy step until
`MemAvailable` is at least 4 GiB (polls every 60 s, gives up after 30 min).
Override with `CAP_MEM_MAX`, `CAP_MEM_HIGH`, `CAP_SWAP_MAX`, `MIN_AVAIL_GB` and
`MEM_WAIT_MIN`. mksquashfs runs with `-mem 1500M -processors 4`. The overlay is
mounted through `/run/preload-build`, so snap-preseed never records a home path.

```
sudo build/build-layer.sh all          # ~2-4 h; network needed; logs: work/logs/
sudo build/make-iso.sh                 # -> out/preload-26.04.1-YYYYMMDD.iso
sudo test/leakscan.sh work/out/minimal.standard.preload.squashfs
sudo test/leakscan.sh out/preload-26.04.1-YYYYMMDD.iso
sudo build/build-layer.sh umount
```

Build from a clean checkout of a release tag (`git checkout vYYYY.MM.DD`) so the
image records that release as applied; otherwise it records `v0` and the first
online update applies the newest release (only the steps whose inputs differ).

To start from scratch: `sudo build/build-layer.sh umount && sudo rm -rf work/layer work/out work/pool work/snaps`.
Single steps can be re-run, e.g. `sudo build/build-layer.sh provision extensions dconf files`.
Write the ISO to a USB stick (32 GB or more) with `dd`, or with GNOME Disks "Restore Disk Image".

To refresh from the owner's machine: run `capture/capture.sh`, review the diff,
then edit the payload files **by hand**. Nothing is ever copied wholesale from `/home`.

The leak scan needs the owner's private patterns file
(`~/.config/preload/leak-patterns.sh`, template in `test/leak-patterns.example.sh`).

## Differences between an ISO install and a one-command install

| | ISO | one-command install |
|---|---|---|
| Kernel/packages | fully upgraded at build time | Ubuntu's own updater keeps them current |
| Snaps | seeded in the image (offline) | `snap install` |
| NVIDIA | installer's late.sh (online ubuntu-drivers + offline pool) | `ubuntu-drivers install`, only on NVIDIA hardware without a driver |
| ThinkPad P1 Gen 8 | late.sh runs the DMI-gated `apply.sh` | the `hw` step runs the same script |
| openssh-server | installed, disabled, no host keys | installed; disabled if it was not there before |
| Updates | preload-update timer enabled in the image | same |
