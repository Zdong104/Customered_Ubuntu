#!/bin/bash
# Customered_Ubuntu one-command installer. On Ubuntu 26.04 Desktop (x86_64):
#
#   wget -qO- https://raw.githubusercontent.com/Zdong104/Customered_Ubuntu/main/bootstrap.sh | sudo bash
#
# (wget, not curl: a stock Ubuntu 26.04 Desktop has no curl.)
#
# Optional extra (off by default): `... | sudo bash -s -- --reset-desktop`
# also resets YOUR desktop settings to the preload defaults right away (only
# the keys preload sets; only for the user who ran sudo).
#
# What it does: checks the machine (changes nothing if a check fails), pins
# the release-signing key below, downloads the newest SSH-signed release tag,
# verifies it, and runs that release's updater, which installs everything and
# keeps it up to date in the background. Safe to re-run: an interrupted
# install resumes where it stopped.
set -euo pipefail
export LC_ALL=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Pinned values; must equal updater/preload.conf and updater/allowed_signers
# (release.sh checks).
REPO_URL=https://github.com/Zdong104/Customered_Ubuntu.git
SIGNERS='preload-release namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINiHNqw240yQzDgnkMLtVxpL+rEWU2oKD48v2fPkZ+PL'

LIB=/var/lib/preload
REPO=$LIB/repo
TAG_RE='^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]{1,3})?$'
NEED_GB_FIRST=25   # packages, vendor apps, snaps, Miniconda, TinyTeX, Vocalinux
NEED_GB_AGAIN=5

info() { printf '%s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$1" >&2; [ -n "${2:-}" ] && printf '%s\n' "$2" >&2; exit 1; }

preflight() {
    info "== Checking this computer"
    . /etc/os-release 2>/dev/null || true
    [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 26.04 ] ||
        fail "Only Ubuntu 26.04 is supported (this is ${PRETTY_NAME:-unknown})."
    [ "$(dpkg --print-architecture)" = amd64 ] ||
        fail "Only x86_64 (amd64) machines are supported."
    dpkg-query -W -f '${Status}' gnome-shell 2>/dev/null | grep -q 'install ok installed' ||
        fail "This needs Ubuntu Desktop (GNOME); gnome-shell is not installed."
    local need=$NEED_GB_FIRST avail
    [ -s "$LIB/state/version" ] && need=$NEED_GB_AGAIN
    avail=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
    [ "$avail" -ge "$need" ] ||
        fail "Not enough disk space: about ${need} GB needed, ${avail} GB free on /."
    if [ -z "${PRELOAD_TEST_REMOTE:-}" ]; then
        wget -q --spider --timeout=20 --tries=2 https://github.com ||
            fail "Cannot reach github.com; check the network and try again."
    fi
    local b
    for b in /sys/class/power_supply/*; do
        [ "$(cat "$b/type" 2>/dev/null)" = Battery ] || continue
        if [ "$(cat "$b/status" 2>/dev/null)" = Discharging ] && [ "$(cat "$b/capacity" 2>/dev/null || echo 100)" -lt 30 ]; then
            info "Note: battery below 30%, please plug in."
        fi
    done
    info "   Ubuntu 26.04 x86_64 GNOME, ${avail} GB free, network OK"
}

# git with no user/system config, https only, signatures against the pinned key
g() {
    env -u GIT_DIR HOME="$LIB" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
        GIT_ALLOW_PROTOCOL="${PRELOAD_TEST_REMOTE:+file:}https" \
        git --git-dir="$REPO" -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=/etc/preload/allowed_signers "$@"
}

# Same rules as preload-update: annotated, SSH-signed by the pinned key, and
# the signed object's own name equals the tag name.
verified() {
    local t=$1 obj hdr
    [ "$(g cat-file -t "refs/tags/$t" 2>/dev/null)" = tag ] || return 1
    obj=$(g cat-file tag "refs/tags/$t")
    hdr=$(sed '/^$/q' <<< "$obj")
    [ "$(sed -n 's/^type //p' <<< "$hdr")" = commit ] || return 1
    [ "$(sed -n 's/^tag //p' <<< "$hdr")" = "$t" ] || return 1
    grep -qx -- '-----BEGIN SSH SIGNATURE-----' <<< "$obj" || return 1
    g verify-tag "refs/tags/$t" >/dev/null 2>&1
}

reset_desktop() { # for the user who ran sudo only
    local user=${SUDO_USER:-} uid ini=$LIB/current/payload/dconf/defaults.ini
    if [ -z "$user" ] || [ "$user" = root ] || [ ! -f "$ini" ]; then
        info "--reset-desktop: no sudo user / no defaults found, skipped"; return 0
    fi
    uid=$(id -u "$user")
    info "== Resetting $user's desktop settings to the preload defaults"
    awk '/^\[/{gsub(/[][]/,""); s=$0; next} /^[A-Za-z0-9-]+=/{split($0,a,"="); print s, a[1]}' "$ini" |
    while read -r schema key; do
        if [ -S "/run/user/$uid/bus" ]; then
            runuser -u "$user" -- env DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
                gsettings reset "$schema" "$key" 2>/dev/null || true
        else
            runuser -u "$user" -- dbus-run-session -- gsettings reset "$schema" "$key" 2>/dev/null || true
        fi
    done
}

main() {
    exec </dev/null   # the script itself may be arriving on stdin (wget | bash)
    local reset=0 a
    for a in "$@"; do
        case $a in
            --reset-desktop) reset=1 ;;
            *) fail "unknown option: $a" ;;
        esac
    done
    [ "$(id -u)" = 0 ] || fail "Please run it with sudo (see README)."
    info "Customered_Ubuntu installer"
    preflight
    info ""
    info "Installing apps and desktop settings: about 30-60 minutes the first time, needs network."
    info "If it gets interrupted, just run the same command again: it continues where it stopped."
    info ""
    local t0=$SECONDS

    info "== Preparing (git, curl, ssh-keygen)"
    # stock Desktop lacks git and curl (the engine downloads with curl)
    if ! command -v git >/dev/null || ! command -v curl >/dev/null || ! command -v ssh-keygen >/dev/null; then
        apt-get -o DPkg::Lock::Timeout=900 update -qq
        DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=900 install -y -qq \
            git curl openssh-client ca-certificates >/dev/null
    fi
    install -d -m 0755 /etc/preload "$LIB"
    # Keep files a verified release installed earlier (they may carry a newer
    # key or URL); otherwise pin what this script carries.
    [ -s /etc/preload/allowed_signers ] || printf '%s\n' "$SIGNERS" > /etc/preload/allowed_signers
    [ -s /etc/preload/preload.conf ] || printf 'REPO_URL=%s\n' "$REPO_URL" > /etc/preload/preload.conf
    if [ -n "${PRELOAD_TEST_SIGNERS:-}" ]; then cp "$PRELOAD_TEST_SIGNERS" /etc/preload/allowed_signers; fi

    info "== Downloading and verifying the signed release"
    [ -f "$REPO/HEAD" ] || g init -q --bare
    g config remote.origin.url "${PRELOAD_TEST_REMOTE:-$REPO_URL}"
    g fetch -q --no-tags --prune --force origin '+refs/tags/v*:refs/tags/v*' ||
        fail "Download failed; check the network and run the command again."
    local tag="" t
    while IFS= read -r t; do
        if verified "$t"; then tag=$t; break; fi
        info "   skipping unverified tag $t"
    done < <(g tag -l 'v*' | grep -E "$TAG_RE" | sort -rV)
    [ -n "$tag" ] || fail "No release with a valid signature was found."
    tree=$(mktemp -d /var/tmp/preload-bootstrap.XXXXXX)
    trap 'rm -rf "${tree:-}"' EXIT   # global: the trap runs after main returns
    g archive --format=tar "refs/tags/$tag^{commit}" | tar -x -C "$tree" --no-same-owner
    info "   $tag OK ($(g rev-parse --short "refs/tags/$tag^{commit}"))"
    info ""

    # The verified release's own updater does the rest (and installs itself).
    local rc=0
    bash "$tree/updater/preload-update" --now || rc=$?
    [ $rc -le 1 ] && [ $reset = 1 ] && reset_desktop

    local min=$(( (SECONDS - t0 + 59) / 60 ))
    info ""
    info "=================================================================="
    case $rc in
        0) info "Installation complete (${min} min)" ;;
        1) info "Installed (${min} min); these items failed and will be retried automatically:"
           info "   $(paste -sd' ' "$LIB/state/failed" 2>/dev/null)" ;;
        *) info "Installation did not finish. Run the same command again to continue."
           info "log: /var/log/preload-update.log"
           info "=================================================================="
           exit "$rc" ;;
    esac
    info ""
    info "Next:"
    info "  1. Log out and back in once (top-right menu -> Log Out)."
    if [ -e /var/run/reboot-required ]; then
        info "  2. Then restart once (drivers / kernel options changed)."
    fi
    info "Future updates install automatically in the background."
    info "status: preload-update --status"
    info "=================================================================="
    return "$rc"   # 0 complete; 1 complete except optional items (retried in the background)
}

main "$@"; exit $?
