#!/bin/bash
# Customered_Ubuntu one-command installer. On Ubuntu 26.04 Desktop (x86_64):
#
#   curl -fsSL https://raw.githubusercontent.com/Zdong104/Customered_Ubuntu/main/bootstrap.sh | sudo bash
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
fail() { printf '\n错误 / ERROR: %s\n' "$1" >&2; [ -n "${2:-}" ] && printf '%s\n' "$2" >&2; exit 1; }

preflight() {
    info "== 检查电脑 / Checking this computer"
    . /etc/os-release 2>/dev/null || true
    [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 26.04 ] ||
        fail "只支持 Ubuntu 26.04，这台电脑是 ${PRETTY_NAME:-unknown}。" \
             "Only Ubuntu 26.04 is supported (this is ${PRETTY_NAME:-unknown})."
    [ "$(dpkg --print-architecture)" = amd64 ] ||
        fail "只支持 x86_64 (amd64) 电脑。" "Only x86_64 (amd64) machines are supported."
    dpkg-query -W -f '${Status}' gnome-shell 2>/dev/null | grep -q 'install ok installed' ||
        fail "需要 Ubuntu 桌面版（GNOME），这台电脑没有安装 GNOME。" \
             "This needs Ubuntu Desktop (GNOME); gnome-shell is not installed."
    local need=$NEED_GB_FIRST avail
    [ -s "$LIB/state/version" ] && need=$NEED_GB_AGAIN
    avail=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
    [ "$avail" -ge "$need" ] ||
        fail "磁盘空间不足：需要约 ${need} GB，系统盘只剩 ${avail} GB。" \
             "Not enough disk space: about ${need} GB needed, ${avail} GB free on /."
    if [ -z "${PRELOAD_TEST_REMOTE:-}" ]; then
        curl -fsS --max-time 20 -o /dev/null https://github.com ||
            fail "连不上 GitHub，请检查网络后重试。" "Cannot reach github.com; check the network and try again."
    fi
    local b
    for b in /sys/class/power_supply/*; do
        [ "$(cat "$b/type" 2>/dev/null)" = Battery ] || continue
        if [ "$(cat "$b/status" 2>/dev/null)" = Discharging ] && [ "$(cat "$b/capacity" 2>/dev/null || echo 100)" -lt 30 ]; then
            info "注意：电量低于 30%，建议接上电源。/ Note: battery below 30%, please plug in."
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
    info "== 重置 $user 的桌面设置为默认 / Resetting $user's desktop settings to the preload defaults"
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
    exec </dev/null   # the script itself may be arriving on stdin (curl | bash)
    local reset=0 a
    for a in "$@"; do
        case $a in
            --reset-desktop) reset=1 ;;
            *) fail "unknown option: $a" ;;
        esac
    done
    [ "$(id -u)" = 0 ] || fail "请在命令前加 sudo 运行。" "Please run it with sudo (see README)."
    info "Customered_Ubuntu 安装程序 / installer"
    preflight
    info ""
    info "将安装软件和桌面配置，首次约需 30–60 分钟，需要联网，期间可以继续用电脑。"
    info "Installing apps and desktop settings: about 30-60 minutes the first time, needs network."
    info "If it gets interrupted, just run the same command again: it continues where it stopped."
    info ""
    local t0=$SECONDS

    info "== 准备 / Preparing (git, ssh-keygen)"
    if ! command -v git >/dev/null || ! command -v ssh-keygen >/dev/null; then
        apt-get -o DPkg::Lock::Timeout=900 update -qq
        DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=900 install -y -qq \
            git openssh-client ca-certificates >/dev/null
    fi
    install -d -m 0755 /etc/preload "$LIB"
    # Keep files a verified release installed earlier (they may carry a newer
    # key or URL); otherwise pin what this script carries.
    [ -s /etc/preload/allowed_signers ] || printf '%s\n' "$SIGNERS" > /etc/preload/allowed_signers
    [ -s /etc/preload/preload.conf ] || printf 'REPO_URL=%s\n' "$REPO_URL" > /etc/preload/preload.conf
    if [ -n "${PRELOAD_TEST_SIGNERS:-}" ]; then cp "$PRELOAD_TEST_SIGNERS" /etc/preload/allowed_signers; fi

    info "== 下载并验证签名 / Downloading and verifying the signed release"
    [ -f "$REPO/HEAD" ] || g init -q --bare
    g config remote.origin.url "${PRELOAD_TEST_REMOTE:-$REPO_URL}"
    g fetch -q --no-tags --prune --force origin '+refs/tags/v*:refs/tags/v*' ||
        fail "下载失败，请检查网络后重新运行。" "Download failed; check the network and run the command again."
    local tag="" t
    while IFS= read -r t; do
        if verified "$t"; then tag=$t; break; fi
        info "   跳过未通过验证的版本 / skipping unverified tag $t"
    done < <(g tag -l 'v*' | grep -E "$TAG_RE" | sort -rV)
    [ -n "$tag" ] || fail "没有找到签名有效的版本。" "No release with a valid signature was found."
    local tree
    tree=$(mktemp -d /var/tmp/preload-bootstrap.XXXXXX)
    trap 'rm -rf "$tree"' EXIT
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
        0) info "安装完成（用时 ${min} 分钟）/ Installation complete (${min} min)" ;;
        1) info "安装基本完成（用时 ${min} 分钟），个别项目失败，会在后台自动重试："
           info "Installed (${min} min); these items failed and will be retried automatically:"
           info "   $(paste -sd' ' "$LIB/state/failed" 2>/dev/null)" ;;
        *) info "安装没有完成。请重新运行同一条命令，会从中断处继续。"
           info "Installation did not finish. Run the same command again to continue."
           info "日志 / log: /var/log/preload-update.log"
           info "=================================================================="
           exit "$rc" ;;
    esac
    info ""
    info "下一步 / Next:"
    info "  1. 注销并重新登录一次（右上角菜单 -> 注销）。/ Log out and back in once."
    if [ -e /var/run/reboot-required ]; then
        info "  2. 然后重启一次电脑（安装了驱动或内核参数）。/ Then restart once (drivers / kernel options changed)."
    fi
    info "以后的更新会在后台自动安装，完成后会有通知。/ Future updates install automatically in the background."
    info "查看状态 / status: preload-update --status"
    info "=================================================================="
}

main "$@"; exit $?
