#!/bin/bash
# Build the preload casper layer (minimal.standard.preload.squashfs) on top of
# the stock Ubuntu 26.04.1 desktop ISO's install layers.
#
#   sudo build/build-layer.sh all                 # everything below, in order
#   sudo build/build-layer.sh mount               # loop-mount ISO + layers, overlay, chroot binds
#   sudo build/build-layer.sh provision [STEP..]  # run payload/provision.sh in the chroot
#   sudo build/build-layer.sh snaps               # add snaps to the seed + re-preseed
#   sudo build/build-layer.sh pool                # NVIDIA offline pool -> work/pool
#   sudo build/build-layer.sh cleanup             # provision.sh cleanup step
#   sudo build/build-layer.sh squash              # umount binds, mksquashfs upper -> work/out
#   sudo build/build-layer.sh umount              # tear everything down
#
# Work tree (on disk, not tmpfs): work/{iso,sq/*,layer/{upper,ovlwork,root},snaps,pool,out}
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$ROOT/work
ISO=${STOCK_ISO:-$ROOT/work/ubuntu-26.04.1-desktop-amd64.iso}   # or a symlink there
L=$W/layer
# The overlay is mounted through a neutral path so that nothing that records
# mount paths (snap-preseed writes the overlay upperdir into apparmor profiles
# and system-key) ever sees the build host's home directory.
BR=/run/preload-build
R=$BR/root
LAYER=minimal.standard.preload
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
. "$ROOT/build/lib.sh"
run_capped_self "$@"     # whole build runs in a MemoryMax-capped scope

ismnt() { mountpoint -q "$1"; }
log() { printf '\n#### [build-layer] %s  (%s)\n' "$*" "$(date '+%F %T')"; }

do_mount() {
    log mount
    mkdir -p "$W/iso" "$W/sq/minimal" "$W/sq/standard" "$L/upper" "$L/ovlwork" "$R"
    ismnt "$W/iso" || mount -o loop,ro "$ISO" "$W/iso"
    ismnt "$W/sq/minimal" || mount -o loop,ro "$W/iso/casper/minimal.squashfs" "$W/sq/minimal"
    ismnt "$W/sq/standard" || mount -o loop,ro "$W/iso/casper/minimal.standard.squashfs" "$W/sq/standard"
    mkdir -p "$BR" "$L/lower-minimal" "$L/lower-standard"
    ismnt "$BR" || mount --bind "$L" "$BR"
    ismnt "$BR/lower-minimal" || mount -o loop,ro "$W/iso/casper/minimal.squashfs" "$BR/lower-minimal"
    ismnt "$BR/lower-standard" || mount -o loop,ro "$W/iso/casper/minimal.standard.squashfs" "$BR/lower-standard"
    ismnt "$R" || mount -t overlay overlay \
        -o "lowerdir=$BR/lower-standard:$BR/lower-minimal,upperdir=$BR/upper,workdir=$BR/ovlwork,redirect_dir=off,metacopy=off,index=off,xino=off" "$R"
    bind_chroot
}

bind_chroot() {
    ismnt "$R/proc" || mount -t proc proc "$R/proc"
    ismnt "$R/sys" || mount -t sysfs sysfs "$R/sys"
    ismnt "$R/sys/kernel/security" || mount -t securityfs securityfs "$R/sys/kernel/security"
    ismnt "$R/dev" || mount --bind /dev "$R/dev"
    ismnt "$R/dev/pts" || mount -t devpts -o newinstance,ptmxmode=0666 devpts "$R/dev/pts"
    if ! ismnt "$R/run"; then
        mount -t tmpfs -o size=256m,mode=0755 tmpfs "$R/run"
        mkdir -p "$R/run/systemd/resolve" "$R/run/lock"
        # host stub resolver is reachable from the chroot (same netns)
        grep -E '^(nameserver|options|search)' /etc/resolv.conf > "$R/run/systemd/resolve/stub-resolv.conf"
    fi
    # The ISO's own pool is not available at build time: hide cdrom.sources
    # without touching the layer.
    if [ -e "$R/etc/apt/sources.list.d/cdrom.sources" ] && ! ismnt "$R/etc/apt/sources.list.d/cdrom.sources"; then
        mount --bind /dev/null "$R/etc/apt/sources.list.d/cdrom.sources"
    fi
    # no daemons may start inside the chroot
    if [ ! -e "$R/usr/sbin/policy-rc.d" ]; then
        printf '#!/bin/sh\nexit 101\n' > "$R/usr/sbin/policy-rc.d"; chmod 755 "$R/usr/sbin/policy-rc.d"
    fi
}

unbind_chroot() {
    rm -f "$R/usr/sbin/policy-rc.d"
    for m in etc/apt/sources.list.d/cdrom.sources run dev/pts dev sys/kernel/security sys proc; do
        ismnt "$R/$m" && umount -l "$R/$m" || true
    done
}

stage_payload() {
    rm -rf "$R/tmp/preload-payload"
    mkdir -p "$R/tmp/preload-payload"
    cp -a "$ROOT/payload/." "$R/tmp/preload-payload/"
    cp "$ROOT/build/gen-override.py" "$R/tmp/preload-payload/"
    cp -a "$ROOT/updater" "$R/tmp/preload-payload/updater"
    chown -R root:root "$R/tmp/preload-payload"
}

# The release this image carries: the signed tag at HEAD of a clean tree, else
# v0 (then the first online update applies the newest release in full).
image_version() {
    local t
    t=$(git -C "$ROOT" -c safe.directory="$ROOT" describe --tags --exact-match --match 'v*' HEAD 2>/dev/null) &&
        [ -z "$(git -C "$ROOT" -c safe.directory="$ROOT" status --porcelain 2>/dev/null)" ] && { echo "$t"; return; }
    echo v0
}

# The owner's identity regex (kept outside the public repo) for gen-override.py.
ident_re() {
    local f
    f=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/.config/preload/leak-patterns.sh
    [ -r "${PRELOAD_LEAK_PATTERNS:-$f}" ] && ( . "${PRELOAD_LEAK_PATTERNS:-$f}"; echo "${IDENT:-}" )
}

run_provision() { # steps...
    chroot "$R" /usr/bin/env PRELOAD_VERSION="$(image_version)" PRELOAD_IDENT_RE="$(ident_re || true)" \
        /bin/bash /tmp/preload-payload/provision.sh "$@"
}

do_provision() {
    wait_mem
    log "provision $*"
    bind_chroot
    stage_payload
    run_provision "$@"
}

do_snaps() {
    wait_mem
    log snaps
    bind_chroot
    stage_payload
    [ "${SKIP_SEED:-0}" = 1 ] || python3 "$ROOT/build/snaps.py" "$ROOT/payload/sources.conf" "$R" "$W/snaps"
    # Re-preseed so first boot is fast; fall back to a non-preseeded seed.
    /usr/lib/snapd/snap-preseed --reset "$(realpath "$R")" || true
    if ! /usr/lib/snapd/snap-preseed "$(realpath "$R")"; then
        echo "WARNING: snap-preseed failed; seed stays valid but is seeded at first boot" >&2
        /usr/lib/snapd/snap-preseed --reset "$(realpath "$R")" || true
    fi
}

do_pool() {
    wait_mem
    log "nvidia pool"
    bind_chroot
    stage_payload
    run_provision nvidia_pool
    rm -rf "$W/pool"; mkdir -p "$W/pool"
    cp -a "$R/tmp/preload-pool/." "$W/pool/"
    rm -rf "$R/tmp/preload-pool"
}

do_cleanup() {
    wait_mem
    log cleanup
    bind_chroot
    stage_payload
    run_provision cleanup
    rm -rf "$R/tmp/preload-payload"
}

do_squash() {
    wait_mem
    log squash
    unbind_chroot
    sync
    mkdir -p "$W/out"
    rm -f "$W/out/$LAYER.squashfs"
    # Same compression as the stock layers. -mem/-processors keep RAM use low.
    # overlay bookkeeping xattrs (origin/impure) are dropped; opaque markers are kept
    mksquashfs "$L/upper" "$W/out/$LAYER.squashfs" -comp xz -b 131072 -xattrs \
        -xattrs-exclude '^trusted\.overlay\.(origin|impure)$' \
        -noappend -processors "${SQUASH_CPUS:-4}" -mem "${SQUASH_MEM:-1500M}" -no-progress
    # Installed size of the full stack (minimal + standard + preload), for install-sources.yaml
    du -sbx --apparent-size "$R" | cut -f1 > "$W/out/$LAYER.size"
    # Manifest of the merged system
    chroot "$R" dpkg-query -W -f '${Package}\t${Version}\n' > "$W/out/$LAYER.manifest"
    ls -la "$W/out"
}

do_umount() {
    log umount
    unbind_chroot
    for m in "$R" "$BR/lower-standard" "$BR/lower-minimal" "$BR" "$W/sq/standard" "$W/sq/minimal" "$W/sq/live" "$W/snapx" "$W/iso"; do
        ismnt "$m" && umount "$m" || true
    done
}

cmd=${1:-all}; shift || true
case $cmd in
    mount) do_mount ;;
    provision) do_mount; do_provision "$@" ;;
    snaps) do_mount; do_snaps ;;
    pool) do_mount; do_pool ;;
    cleanup) do_mount; do_cleanup ;;
    squash) do_mount; do_squash ;;
    umount) do_umount ;;
    all) do_mount; do_provision; do_snaps; do_pool; do_cleanup; do_squash ;;
    *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
log "finished $cmd"
