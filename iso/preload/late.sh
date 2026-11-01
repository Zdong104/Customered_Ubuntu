#!/bin/bash
# Preload late-commands. Runs in the live installer environment after the
# system has been installed to /target (both install modes call it).
#
#  1. Drivers: `ubuntu-drivers install` against the archive (when online) plus
#     the NVIDIA offline pool on this medium, so an NVIDIA machine gets the
#     driver even without network and other hardware still gets its drivers
#     when online. (The installer's own drivers step is off because offline it
#     would pick NVIDIA modules for the ISO's older kernel.)
#  2. ThinkPad P1 Gen 8 hardware tweaks (DMI-gated, no-op elsewhere).
#  3. Fresh machine-id on first boot.
set -u
T=/target
POOL=/cdrom/preload/pool
LOG=$T/var/log/installer/preload-late.log
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
set -x
date

in_target() { curtin in-target --target="$T" -- "$@"; }

has_nvidia=no
for d in /sys/bus/pci/devices/*; do
    [ "$(cat "$d/vendor" 2>/dev/null)" = 0x10de ] || continue
    case "$(cat "$d/class" 2>/dev/null)" in 0x03*) has_nvidia=yes ;; esac
done
echo "nvidia display controller: $has_nvidia"

# --- 1. drivers ------------------------------------------------------------
LIST=$T/etc/apt/sources.list.d/zz-preload-pool.list
if [ -d "$POOL" ]; then
    mkdir -p "$T/mnt/preload-pool"
    mount --bind "$POOL" "$T/mnt/preload-pool"
    echo 'deb [trusted=yes] file:/mnt/preload-pool ./' > "$LIST"
fi
in_target apt-get update || true
in_target env DEBIAN_FRONTEND=noninteractive ubuntu-drivers install || true
if [ "$has_nvidia" = yes ] &&
   ! in_target dpkg-query -W -f '${Status} ${Package}\n' 'nvidia-driver-*' 2>/dev/null | grep -q '^install ok installed'; then
    in_target env DEBIAN_FRONTEND=noninteractive apt-get -y install \
        nvidia-driver-595-open linux-modules-nvidia-595-open-generic-hwe-26.04 || true
fi
rm -f "$LIST"
rm -f "$T"/var/lib/apt/lists/*preload-pool*
if mountpoint -q "$T/mnt/preload-pool"; then umount "$T/mnt/preload-pool"; fi
rmdir "$T/mnt/preload-pool" 2>/dev/null || true

# --- 2. hardware gate ------------------------------------------------------
in_target /usr/local/lib/preload/hw/thinkpad-p1-gen8/apply.sh || true

# --- 3. per-machine identity -----------------------------------------------
: > "$T/etc/machine-id"
date
exit 0
