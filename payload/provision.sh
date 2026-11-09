#!/bin/bash
# Provision a preload system. One engine, two modes:
#
#   chroot (default): INSIDE the ISO build chroot (overlay on top of the stock
#          26.04.1 minimal+standard layers), called by build/build-layer.sh.
#          Fails fast; full-upgrade; snaps are seeded by build/snaps.py and
#          drivers/hardware are handled by the installer's late.sh.
#   live  : on an installed system, called by preload-update with the payload
#          of a verified release. No full-upgrade (Ubuntu's own updater does
#          that), no image cleanup, nothing that touches machine identity;
#          a failing optional step is reported and the rest still runs.
#
#   provision.sh [--changed] [STEP...]     default: all steps of the mode
#
#   --changed  run only steps whose input hash differs from the recorded one
#              ($PRELOAD_STATE/steps/STEP). A step's hash covers its own code
#              and its payload inputs, so a release that touches one extension
#              re-runs only "extensions". Download steps hash their
#              sources.conf line, so "latest" URLs are re-fetched when the
#              line (or a pinned tag) changes, not on every update.
#
# Environment: PRELOAD_MODE=chroot|live  PRELOAD_PAYLOAD=dir  PRELOAD_STATE=dir
#   PRELOAD_VERSION=vX     chroot: recorded as the release the image carries
#   PRELOAD_PROGRESS_FD=N  one-line progress messages are also written here
#   PRELOAD_SKIP_STEPS="a b"  testing/debugging: never run these
# Exit status (live): 0 ok, 1 optional step(s) failed, 2 a core step failed.
#
# Steps are idempotent, so an interrupted run is simply repeated. Nothing here
# reads from the build host's /home: everything is in the payload or is
# downloaded.
set -euo pipefail
MODE=${PRELOAD_MODE:-chroot}
P=${PRELOAD_PAYLOAD:-/tmp/preload-payload}
STATE=${PRELOAD_STATE:-/var/lib/preload/state}
BACKUP=$(dirname "$STATE")/backup
# The chroot build stages updater/ and gen-override.py inside the payload; a
# release tree has them next to it.
U=$P/updater; [ -d "$U" ] || U=$P/../updater
GEN=$P/gen-override.py; [ -f "$GEN" ] || GEN=$P/../build/gen-override.py
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 HOME=/root
# A live system may have unattended-upgrades holding the dpkg lock: wait.
APT=(apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold
     -o DPkg::Lock::Timeout=900)
# Live: one broken third-party source of the user must not fail our steps;
# the install that follows decides whether what we need was fetched.
apt_update() {
    if [ "$MODE" = live ]; then
        "${APT[@]}" update || echo "WARNING: apt-get update reported errors; continuing"
    else
        "${APT[@]}" update
    fi
}
if [ "$MODE" = live ]; then
    DL=$(mktemp -d /var/tmp/preload-dl.XXXXXX)
    trap 'rm -rf "$DL"' EXIT
else
    DL=/tmp/preload-dl
    mkdir -p "$DL"
fi
log() { printf '\n==== [provision] %s ====\n' "$*"; }
progress() {
    log "$*"
    if [ -n "${PRELOAD_PROGRESS_FD:-}" ]; then printf '%s\n' "$*" >&"$PRELOAD_PROGRESS_FD"; fi
}
conf() { grep -E "^$1\|" "$P/sources.conf" | cut -d'|' -f2-; }
live() { [ "$MODE" = live ]; }
# Atomic replace: a running script (preload-update itself) keeps its inode.
put() { # mode src dst
    install -m "$1" "$2" "$3.preload-new" && mv -f "$3.preload-new" "$3"
}

# Resolve "github:owner/repo:SUFFIX" to the latest release asset URL whose
# name contains SUFFIX; plain URLs are returned unchanged.
resolve_url() {
    local spec=$1
    if [[ $spec == github:* ]]; then
        local rest=${spec#github:} repo suffix
        repo=${rest%%:*}; suffix=${rest#*:}
        curl -fsSL "https://api.github.com/repos/$repo/releases/latest" |
            python3 -c 'import json,sys
s=sys.argv[1]
for a in json.load(sys.stdin)["assets"]:
    if s in a["name"] and not a["name"].endswith((".sig",".sha256",".asc")):
        print(a["browser_download_url"]); break' "$suffix"
    else
        echo "$spec"
    fi
}

# Live: a file we are about to replace that was already there (the user's or
# the distro's) is saved once under /var/lib/preload/backup, and restored if a
# later release stops shipping it.
backup_once() { # path-relative-to-/ [file-we-will-install]
    live || return 0
    [ -e "/$1" ] || return 0
    [ -e "$BACKUP/$1" ] && return 0
    grep -qxF "$1" "$STATE/manifest/files" 2>/dev/null && return 0
    [ -n "${2:-}" ] && cmp -s "/$1" "$2" && return 0
    install -d "$BACKUP/$(dirname "$1")"; cp -a "/$1" "$BACKUP/$1"
}

pkg_installed() { dpkg-query -W -f '${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
skipped() { progress "      $1: 已安装，跳过 / already installed, skipped"; }

# Items (a vendor .deb, a snap, Vocalinux at a tag, ...) that are already on the
# machine are adopted, not reinstalled: an item is skipped when it is present
# and its sources.conf line is the one we last installed it from, or we never
# installed it (the user had it already). A changed line always reinstalls it.
item_mark() { install -d -m 0755 "$STATE/items"; printf '%s\n' "$2" > "$STATE/items/$1"; }
want_item() { # key line present-check... -> 0 when the item must be (re)installed
    local key=$1 line=$2 rec
    shift 2
    rec=$(cat "$STATE/items/$key" 2>/dev/null || true)
    if { [ -z "$rec" ] || [ "$rec" = "$line" ]; } && "$@" >/dev/null 2>&1; then
        item_mark "$key" "$line"; skipped "$key"; return 1
    fi
    return 0
}

step_base() {
    mapfile -t pkgs < <(grep -vE '^\s*(#|$)' "$P/packages.txt" | tr ' ' '\n' | grep -v '^$')
    if ! live; then
        apt_update
        "${APT[@]}" full-upgrade
        "${APT[@]}" install "${pkgs[@]}"
        base_units
        # Transitional snap-wrapper debs we do not want (the owner uses
        # Mozilla's Firefox .deb, and no Thunderbird). Image only: on a live
        # system packages are removed only through remove.txt.
        mapfile -t tb < <(dpkg-query -W -f '${Package}\n' 'thunderbird*' 2>/dev/null || true)
        [ ${#tb[@]} -gt 0 ] && "${APT[@]}" purge "${tb[@]}" || true
        return 0
    fi
    # Live: one bad package must not keep the other few hundred out.
    local bad=() p
    # openssh-server comes "installed but off", as in the image: a server we
    # add must not start listening on someone's laptop (one that was already
    # there is left as it is). Marked first, so an interrupted run still does it.
    install -d -m 0755 "$STATE/items"
    dpkg-query -W -f '${Status}' openssh-server 2>/dev/null | grep -q 'install ok installed' ||
        [ -e "$STATE/items/sshd-off" ] || echo pending > "$STATE/items/sshd-off"
    # only what is missing: apt is not even started when nothing is
    local missing=()
    for p in "${pkgs[@]}"; do pkg_installed "$p" || missing+=("$p"); done
    if [ ${#missing[@]} -eq 0 ]; then
        skipped "${#pkgs[@]} packages"
    else
        echo "installing ${#missing[@]} of ${#pkgs[@]} packages: ${missing[*]}"
        apt_update
        if ! "${APT[@]}" install "${missing[@]}"; then
            echo "batch install failed; retrying package by package"
            for p in "${missing[@]}"; do "${APT[@]}" install "$p" || bad+=("$p"); done
        fi
    fi
    base_units
    if grep -qx pending "$STATE/items/sshd-off" 2>/dev/null; then
        systemctl disable --now ssh.service ssh.socket 2>/dev/null || true
        echo "done" > "$STATE/items/sshd-off"
    fi
    [ ${#bad[@]} -eq 0 ] || { echo "FAILED packages: ${bad[*]}"; return 1; }
}

# Units shipped by packages from packages.txt (enabled here, not in "services",
# so they are enabled whenever the package install finally succeeds).
base_units() {
    systemctl --global enable ydotool.service 2>/dev/null || echo "ydotool.service not available"
    # docker/libvirt stay enabled as packaged (no images, no VMs, default network only)
    systemctl enable docker.service libvirtd.service 2>/dev/null || true
}

# Live: a source file under another name that points at one of our vendor URIs
# (a vendor postinst's own copy, or the user's earlier manual setup) makes apt
# fail on conflicting Signed-By values. Back it up and drop it; every other
# source of the user is left alone.
drop_dup_sources() {
    local ours f uri
    # plus the URI Chrome's own postinst used before chrome-stable
    ours=$( { grep -hoE 'https?://[^ ]+' "$P"/apt-sources/*; echo https://dl.google.com/linux/chrome/deb; } |
            sed 's#/*$##' | sort -u)
    for f in /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
        [ -f "$f" ] || continue
        [ -e "$P/apt-sources/$(basename "$f")" ] && continue
        while IFS= read -r uri; do
            if grep -qxF "${uri%/}" <<< "$ours"; then
                backup_once "${f#/}"; echo "removing duplicate vendor source $f"; rm -f "$f"; break
            fi
        done < <(grep -vE '^\s*#' "$f" | grep -oE 'https?://[^ ]+' || true)
    done
}

step_repos() {
    install -d -m 0755 /etc/apt/keyrings
    while IFS='|' read -r name keyurl keyring; do
        if [[ $keyurl == local:* ]]; then
            install -m 0644 "$P/keys/${keyurl#local:}" "$keyring"
        else
            curl -fsSL --retry 3 "$keyurl" -o "$DL/$name.key"
            if [[ $keyring == *.gpg ]] && grep -q 'BEGIN PGP PUBLIC KEY' "$DL/$name.key"; then
                gpg --dearmor < "$DL/$name.key" > "$DL/$name.gpg"
                install -m 0644 "$DL/$name.gpg" "$keyring"
            else
                install -m 0644 "$DL/$name.key" "$keyring"
            fi
            chmod 0644 "$keyring"
        fi
    done < <(conf REPO)
    live && drop_dup_sources
    for f in "$P"/apt-sources/*; do install -m 0644 "$f" /etc/apt/sources.list.d/; done
    # Mozilla pinning (Firefox .deb from Mozilla, never the Ubuntu snap wrapper)
    install -m 0644 "$P/rootfs/etc/apt/preferences.d/mozilla" "$P/rootfs/etc/apt/preferences.d/no-firefox-snap" /etc/apt/preferences.d/
    # Chrome's postinst would add a duplicate source and cron job; tell it not to.
    printf 'repo_add_once="false"\nrepo_reenable_on_distupgrade="false"\n' > /etc/default/google-chrome
    read -r -a p3 <<< "$(conf APT3P)"
    if live; then
        # Installed ones are kept current by their vendor repos; Ubuntu's
        # snap-wrapper "firefox" deb does not count as installed.
        local missing=() p
        for p in "${p3[@]}"; do
            pkg_installed "$p" && ! { [ "$p" = firefox ] && dpkg-query -W -f '${Version}' firefox | grep -q snap; } ||
                missing+=("$p")
        done
        if [ ${#missing[@]} -eq 0 ]; then skipped "${p3[*]}"; return 0; fi
        p3=("${missing[@]}")
    fi
    apt_update
    # Mozilla's firefox (no epoch) "downgrades" Ubuntu's 1:1snap1 snap wrapper
    "${APT[@]}" install --allow-downgrades "${p3[@]}"
    # Some vendor postinsts drop their own .list/.sources next to ours.
    if live; then
        drop_dup_sources
    else
        for f in /etc/apt/sources.list.d/*; do
            b=$(basename "$f")
            [ -e "$P/apt-sources/$b" ] && continue
            case "$b" in ubuntu.sources|cdrom.sources*) continue ;; esac
            echo "removing duplicate vendor source $f"; rm -f "$f"
        done
    fi
    apt_update
}

step_debs() {
    local bad=() name spec url
    while IFS='|' read -r name spec; do
        # NAME is the package name; once installed, updates come from the
        # vendor's own apt repo or in-app updater, not from re-downloading.
        want_item "deb-$name" "$spec" pkg_installed "$name" || continue
        url=$(resolve_url "$spec" || true)
        if [ -n "$url" ] && curl -fL --retry 3 -o "$DL/$name.deb" "$url" &&
           "${APT[@]}" install "$DL/$name.deb"; then
            item_mark "deb-$name" "$spec"
            continue
        fi
        echo "FAILED: $name ($spec)"
        live || exit 1
        bad+=("$name")
    done < <(conf DEB)
    [ ${#bad[@]} -eq 0 ] || { echo "FAILED debs: ${bad[*]}"; return 1; }
}

npm_present() {
    local m
    for m in "$@"; do [ -f "/usr/local/lib/node_modules/$m/package.json" ] || return 1; done
}

step_npm() {
    read -r -a mods <<< "$(conf NPM)"
    want_item npm "$(conf NPM)" npm_present "${mods[@]}" || return 0
    npm install -g --prefix /usr/local --no-fund --no-audit "${mods[@]}"
    npm cache clean --force
    rm -rf /root/.npm
    item_mark npm "$(conf NPM)"
}

step_miniconda() {
    if want_item miniconda "$(conf MINICONDA)" test -x /opt/miniconda3/bin/conda; then
        curl -fL --retry 3 -o "$DL/miniconda.sh" "$(conf MINICONDA)"
        bash "$DL/miniconda.sh" -b -u -p /opt/miniconda3
        /opt/miniconda3/bin/conda clean -afy || true
        chmod -R a+rX /opt/miniconda3
        item_mark miniconda "$(conf MINICONDA)"
    fi
    live || rm -rf /root/.conda /root/.condarc
    # Let any user use conda; envs/pkgs go to ~/.conda because base is root-owned.
    cat > /opt/miniconda3/.condarc <<'EOF'
auto_activate_base: false
envs_dirs:
  - ~/.conda/envs
pkgs_dirs:
  - ~/.conda/pkgs
EOF
    chmod 0644 /opt/miniconda3/.condarc
}

step_tinytex() {
    want_item tinytex "$(conf TINYTEX)" test -x /usr/local/bin/tlmgr -a -d /opt/TinyTeX || return 0
    url=$(resolve_url "$(conf TINYTEX)")
    curl -fL --retry 3 -o "$DL/tinytex.tar.xz" "$url"
    rm -rf /opt/TinyTeX /opt/.TinyTeX
    tar -C /opt -xJf "$DL/tinytex.tar.xz"
    [ -d /opt/.TinyTeX ] && mv /opt/.TinyTeX /opt/TinyTeX
    tl=$(ls -d /opt/TinyTeX/bin/*/ | head -1)
    "$tl/tlmgr" option sys_bin /usr/local/bin
    "$tl/tlmgr" path add
    "$tl/tlmgr" postaction install script xetex 2>/dev/null || true
    chmod -R a+rX /opt/TinyTeX
    item_mark tinytex "$(conf TINYTEX)"
}

uv_present() {
    local t
    for t in "$@"; do [ -d "/opt/uv/tools/$t" ] || return 1; done
}

step_uvtool() {
    read -r -a tools <<< "$(conf UVTOOL)"
    want_item uvtool "$(conf UVTOOL)" uv_present "${tools[@]}" || return 0
    local uvbin=$DL/uv
    if [ ! -x "$uvbin/uv" ]; then
        url=$(resolve_url "github:astral-sh/uv:uv-x86_64-unknown-linux-gnu.tar.gz")
        mkdir -p "$uvbin"
        curl -fL --retry 3 "$url" | tar -xz -C "$uvbin" --strip-components=1
    fi
    export UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin \
           UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_CACHE_DIR=$DL/uv-cache
    for t in "${tools[@]}"; do "$uvbin/uv" tool install --force "$t"; done
    chmod -R a+rX /opt/uv
    item_mark uvtool "$(conf UVTOOL)"
}

# Vocalinux built from REPO at TAG? (we rewrite its direct_url.json to say so)
vocalinux_at() {
    local f
    [ -x /opt/vocalinux/venv/bin/python ] || return 1
    for f in /opt/vocalinux/venv/lib/python3*/site-packages/vocalinux-*.dist-info/direct_url.json; do
        grep -qF "\"url\": \"$1\"" "$f" && grep -qF "\"requested_revision\": \"$2\"" "$f" && return 0
    done
    return 1
}

step_vocalinux() {
    IFS='|' read -r repo tag <<< "$(conf VOCALINUX)"
    want_item vocalinux "$repo|$tag" vocalinux_at "$repo" "$tag" || return 0
    local src=$DL/vocalinux
    [ -d "$src" ] || git clone --depth 1 --branch "$tag" "$repo" "$src"
    install -d /opt/vocalinux
    # Run the upstream installer non-interactively against a throwaway HOME so
    # nothing per-user lands in the image; system deps are already installed.
    local vh=$DL/vhome
    # The installer refuses to run as root, so run it as "nobody" (no account
    # is added to the image) and hand /opt/vocalinux back to root afterwards.
    rm -rf "$vh" /opt/vocalinux/venv; mkdir -p "$vh/tmp"
    chown -R 65534:65534 "$vh" "$src" /opt/vocalinux
    chmod 755 "$DL"
    ( cd "$src" && setpriv --reuid=65534 --regid=65534 --clear-groups \
        env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        HOME="$vh" XDG_DATA_HOME="$vh/.local/share" XDG_CONFIG_HOME="$vh/.config" \
        XDG_STATE_HOME="$vh/.local/state" XDG_CACHE_HOME="$vh/.cache" TMPDIR="$vh/tmp" \
        LANG=C.UTF-8 CMAKE_BUILD_PARALLEL_LEVEL=2 \
        bash ./install.sh --auto --engine=whisper_cpp --skip-models --skip-system-deps \
            --venv-dir=/opt/vocalinux/venv </dev/null )
    chown -R root:root /opt/vocalinux "$src"
    # Rebuild whisper.cpp with the Vulkan backend (the installer chose CPU
    # because a chroot has no GPU). ggml falls back to CPU at runtime when no
    # Vulkan device exists, so this is safe on every machine.
    local req=$DL/pywhispercpp.txt
    python3 - "$src/requirements/runtime.txt" "$req" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
blocks = re.split(r"\n(?=\S)", text)
out = [b for b in blocks if re.match(r"pywhispercpp==", b)]
assert out, "pywhispercpp pin not found"
open(sys.argv[2], "w").write(out[0].strip() + "\n")
PY
    # --no-build-isolation: the build tools (cmake, ninja, ...) are in the venv
    # shellcheck disable=SC2016  # $ORIGIN is for the linker, not the shell
    PATH=/opt/vocalinux/venv/bin:$PATH \
    CMAKE_ARGS='-DCMAKE_INSTALL_RPATH=$ORIGIN -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON' \
    GGML_VULKAN=1 CMAKE_BUILD_PARALLEL_LEVEL=2 \
        /opt/vocalinux/venv/bin/python -m pip install --require-hashes --no-deps \
        --no-build-isolation --force-reinstall --no-binary pywhispercpp --no-cache-dir -r "$req"
    ls /opt/vocalinux/venv/lib/python3*/site-packages/ | grep -q 'libggml-vulkan' ||
        echo "WARNING: Vulkan backend library not found; Vocalinux will run whisper.cpp on CPU"
    # Icons + licence; drop the source tree and the throwaway home.
    install -d /usr/share/icons/hicolor/scalable/apps
    cp "$src"/resources/icons/scalable/*.svg /usr/share/icons/hicolor/scalable/apps/ 2>/dev/null || true
    install -m 0644 "$src/LICENSE" /opt/vocalinux/LICENSE
    gtk-update-icon-cache -q -f /usr/share/icons/hicolor 2>/dev/null || true
    rm -rf "$vh"
    live || rm -rf /root/.cache/pip
    # pip records the local checkout path; point it at the upstream tag instead.
    for f in /opt/vocalinux/venv/lib/python3*/site-packages/vocalinux-*.dist-info/direct_url.json; do
        [ -f "$f" ] && printf '{"url": "%s", "vcs_info": {"vcs": "git", "requested_revision": "%s"}}\n' "$repo" "$tag" > "$f"
    done
    chmod -R a+rX /opt/vocalinux
    item_mark vocalinux "$repo|$tag"
}

# Live only: in the image, snaps are seeded by build/snaps.py.
step_snaps() {
    live || { echo "snaps are seeded by build/snaps.py"; return 0; }
    command -v snap >/dev/null || { echo "snapd is not installed"; return 1; }
    local bad=() name ch tracking out s
    while IFS='|' read -r name ch; do
        # snapd refreshes installed snaps itself; a snap the user already had
        # keeps its channel unless our line for it changes later
        want_item "snap-$name" "$ch" snap list "$name" || continue
        tracking=$(snap list "$name" 2>/dev/null | awk 'NR==2{print $4}' || true)
        if [ -n "$tracking" ]; then
            if [ "$tracking" = "$ch" ] || snap refresh --channel="$ch" "$name"; then
                item_mark "snap-$name" "$ch"
            else
                bad+=("$name")
            fi
            continue
        fi
        # confinement is only known to the store: retry with --classic if asked
        if out=$(snap install --channel="$ch" "$name" 2>&1) ||
           { grep -qi classic <<< "$out" && snap install --classic --channel="$ch" "$name"; }; then
            item_mark "snap-$name" "$ch"
        else
            echo "$out"; bad+=("$name")
        fi
    done < <(conf SNAP)
    # Drop the Firefox/Thunderbird snaps only once Mozilla's .deb Firefox is
    # installed, and never while a user has data in the snap's home dir.
    if dpkg-query -W -f '${Status} ${Version}\n' firefox 2>/dev/null | grep -q '^install ok installed [^ ]*$' &&
       ! dpkg-query -W -f '${Version}' firefox | grep -q snap; then
        read -r -a drop <<< "$(conf SNAPDROP)"
        for s in "${drop[@]}"; do
            snap list "$s" >/dev/null 2>&1 || continue
            if compgen -G "/home/*/snap/$s" >/dev/null; then
                echo "keeping snap $s: a user has data in ~/snap/$s"; continue
            fi
            snap remove "$s" || true
        done
    fi
    [ ${#bad[@]} -eq 0 ] || { echo "FAILED snaps: ${bad[*]}"; return 1; }
}

# Our extensions: the payload's own plus workspace-islands from upstream.
ISLANDS_UUID=workspace-islands@danielbernalo.github.io
step_extensions() {
    local E=/usr/share/gnome-shell/extensions S=/usr/share/glib-2.0/schemas M=$STATE/manifest
    install -d -m 0755 "$E" "$M"
    local new=() u d x
    for d in "$P"/extensions/*/; do
        u=$(basename "$d"); new+=("$u")
        rm -rf "${E:?}/$u.preload-new"; cp -r "$d" "$E/$u.preload-new"
        rm -rf "${E:?}/$u"; mv "$E/$u.preload-new" "$E/$u"
    done
    # workspace-islands comes from upstream at a pinned tag: fetched only when
    # missing or when the tag changes, not whenever one of our extensions does
    IFS='|' read -r repo tag <<< "$(conf ISLANDS)"
    if want_item islands "$repo|$tag" test -f "$E/$ISLANDS_UUID/metadata.json"; then
        local isl=$DL/islands
        [ -d "$isl" ] || git clone --depth 1 --branch "$tag" "$repo" "$isl"
        rm -rf "${E:?}/$ISLANDS_UUID"; cp -r "$isl/src" "$E/$ISLANDS_UUID"; cp "$isl/LICENSE" "$E/$ISLANDS_UUID/"
        item_mark islands "$repo|$tag"
    fi
    new+=("$ISLANDS_UUID")
    # Extensions an earlier release shipped and this one does not: remove them
    # and their schemas. Only names from our own manifest are ever touched.
    if [ -f "$M/extensions" ]; then
        while IFS= read -r u; do
            [ -n "$u" ] || continue
            printf '%s\n' "${new[@]}" | grep -qxF "$u" && continue
            echo "removing extension no longer shipped: $u"
            for x in "$E/$u"/schemas/*.gschema.xml; do [ -e "$x" ] && rm -f "$S/$(basename "$x")"; done
            rm -rf "${E:?}/$u"
        done < "$M/extensions"
    fi
    for u in "${new[@]}"; do
        rm -f "$E/$u"/schemas/gschemas.compiled
        for x in "$E/$u"/schemas/*.gschema.xml; do [ -e "$x" ] && install -m 0644 "$x" "$S/"; done
        if [ -d "$E/$u/schemas" ]; then glib-compile-schemas "$E/$u/schemas" 2>/dev/null || true; fi
        chmod -R a+rX "$E/$u"
    done
    printf '%s\n' "${new[@]}" > "$M/extensions"
    glib-compile-schemas "$S" || true
}

# Desktop defaults: a gschema override, i.e. defaults only. A user's own
# changes always win; preload-update never writes anyone's dconf.
step_dconf() {
    local S=/usr/share/glib-2.0/schemas
    python3 "$GEN" "$P/dconf/defaults.ini" > "$DL/90_preload.gschema.override"
    put 0644 "$DL/90_preload.gschema.override" "$S/90_preload.gschema.override"
    if live; then
        # A machine may lack a package whose schema we set a default for; strict
        # mode would then reject the whole override, so fall back to what dpkg's
        # own trigger does (unknown keys are ignored with a warning).
        glib-compile-schemas --strict "$S" || glib-compile-schemas "$S"
    else
        glib-compile-schemas --strict "$S"
    fi
}

step_files() {
    local M=$STATE/manifest list=$DL/files.new f mode
    install -d -m 0755 "$M"
    # rootfs/ holds only reviewed files; copy with root ownership.
    ( cd "$P/rootfs" && find . -mindepth 1 -type d -print0 ) | while IFS= read -r -d '' d; do
        d=${d#./}; [ -d "/$d" ] || install -d -m 0755 "/$d"
    done
    ( cd "$P/rootfs" && find . -type f -printf '%P\n' | LC_ALL=C sort ) > "$list"
    while IFS= read -r f; do
        mode=0644
        [ -x "$P/rootfs/$f" ] && mode=0755
        backup_once "$f" "$P/rootfs/$f"
        put "$mode" "$P/rootfs/$f" "/$f"
    done < "$list"
    # Files an earlier release installed and this one does not ship: remove
    # them, restoring what was there before preload, if anything.
    if [ -f "$M/files" ]; then
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            grep -qxF "$f" "$list" && continue
            if [ -e "$BACKUP/$f" ]; then
                echo "restoring /$f from before preload"; cp -a "$BACKUP/$f" "/$f"; rm -f "$BACKUP/$f"
            else
                echo "removing file no longer shipped: /$f"; rm -f "/$f"
            fi
        done < "$M/files"
    fi
    install -m 0644 "$list" "$M/files"
    # skel: config files are user-writable; nothing executable
    chmod -R u+rwX,go+rX,go-w /etc/skel/.config
    # Input method: fcitx5 for every new user
    grep -q '^XMODIFIERS' /etc/environment || cat >> /etc/environment <<'EOF'
XMODIFIERS=@im=fcitx
GTK_IM_MODULE=fcitx
QT_IM_MODULE=fcitx
EOF
    if [ -f /etc/default/im-config ]; then
        sed -i -E 's/^IM_CONFIG_DEFAULT_MODE=.*/IM_CONFIG_DEFAULT_MODE=fcitx5/' /etc/default/im-config
    fi
    # conda available (not auto-activated) in every user's interactive bash;
    # system-wide, so users who existed before the install get it too
    grep -q 'preload: conda' /etc/bash.bashrc || cat >> /etc/bash.bashrc <<'EOF'

# preload: conda (system Miniconda in /opt/miniconda3; run `conda activate` to use base)
if [ -f /opt/miniconda3/etc/profile.d/conda.sh ]; then
    . /opt/miniconda3/etc/profile.d/conda.sh
fi
EOF
    /usr/local/lib/preload/reapply.sh
    if live; then
        systemctl daemon-reload || true
        udevadm control --reload 2>/dev/null || true
        modprobe uinput 2>/dev/null || true
        sysctl -q -p /etc/sysctl.d/90-sysrq.conf 2>/dev/null || true
    fi
}

step_services() {
    if live; then systemctl daemon-reload; fi
    systemctl enable preload-user-groups.path preload-user-groups.service preload-firstboot.service
    systemctl --global enable recent-folders.service recent-thumbnails.service \
        chrome-pwa-x11.path chrome-pwa-x11.service
    if live; then
        # existing accounts get the app groups now (effective at next login)
        systemctl start preload-user-groups.path || true
        /usr/local/sbin/preload-user-groups || true
        return 0
    fi
    # Image: openssh-server installed, not enabled, no host keys. Never on a
    # live system, where the user may rely on ssh.
    systemctl disable ssh.service ssh.socket 2>/dev/null || true
    rm -f /etc/ssh/ssh_host_*
}

has_nvidia() {
    local d
    for d in /sys/bus/pci/devices/*; do
        [ "$(cat "$d/vendor" 2>/dev/null)" = 0x10de ] || continue
        case "$(cat "$d/class" 2>/dev/null)" in 0x03*) return 0 ;; esac
    done
    return 1
}

# Live only (the installer's late.sh does this for ISO installs): NVIDIA driver
# on NVIDIA hardware without one, and the DMI-gated ThinkPad P1 Gen 8 tweaks.
step_hw() {
    live || { echo "hardware is handled by the installer's late.sh"; return 0; }
    if has_nvidia; then
        if grep -q '^nvidia ' /proc/modules ||
           dpkg-query -W -f '${Status}\n' 'nvidia-driver-*' 2>/dev/null | grep -q '^install ok installed'; then
            echo "an NVIDIA driver is already installed/in use; leaving it alone"
        else
            "${APT[@]}" install ubuntu-drivers-common
            ubuntu-drivers install
            touch /var/run/reboot-required
        fi
    else
        echo "no NVIDIA display controller"
    fi
    /usr/local/lib/preload/hw/thinkpad-p1-gen8/apply.sh
}

# Packages are never removed automatically, except ones listed in remove.txt.
step_remove() {
    local p rm=()
    [ -f "$P/remove.txt" ] || return 0
    while read -r p; do
        dpkg-query -W -f '${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' && rm+=("$p")
    done < <(grep -vE '^\s*(#|$)' "$P/remove.txt" | tr ' ' '\n' | grep -v '^$' || true)
    [ ${#rm[@]} -eq 0 ] || "${APT[@]}" purge "${rm[@]}"
}

# The updater itself: CLI, units, pinned release-signing key, repository URL.
# A key rotation is a release signed by the old key that ships the new
# allowed_signers.
step_updater() {
    install -d -m 0755 /etc/preload /usr/local/lib/preload /var/lib/preload "$STATE"
    put 0755 "$U/preload-update" /usr/local/sbin/preload-update
    put 0755 "$U/preload-user-sync" /usr/local/lib/preload/preload-user-sync
    put 0644 "$U/preload-update.service" /etc/systemd/system/preload-update.service
    put 0644 "$U/preload-update.timer" /etc/systemd/system/preload-update.timer
    put 0644 "$U/preload-user-sync.service" /usr/lib/systemd/user/preload-user-sync.service
    put 0644 "$U/preload.conf" /etc/preload/preload.conf
    put 0644 "$U/allowed_signers" /etc/preload/allowed_signers
    put 0644 "$U/logrotate" /etc/logrotate.d/preload-update
    systemctl --global enable preload-user-sync.service
    if live; then
        systemctl daemon-reload
        systemctl enable --now preload-update.timer
    else
        systemctl enable preload-update.timer
        # an ISO install starts out at the release the image was built from
        echo "${PRELOAD_VERSION:-v0}" > "$STATE/version"
    fi
}

step_nvidia_pool() {
    local pool=/tmp/preload-pool
    rm -rf "$pool"; mkdir -p "$pool/partial"
    "${APT[@]}" -o Dir::Cache::archives="$pool" install --download-only \
        nvidia-driver-595-open linux-modules-nvidia-595-open-generic-hwe-26.04
    rm -rf "$pool/partial" "$pool/lock"
    ( cd "$pool" && dpkg-scanpackages --multiversion . /dev/null > Packages && gzip -9k Packages )
    ls "$pool" | wc -l
}

step_cleanup() {
    if live; then echo "cleanup is for the image only" >&2; return 1; fi
    "${APT[@]}" autoremove --purge
    apt-get clean
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin
    rm -rf "$DL" /root/.cache /root/.npm /root/.config /root/.local /root/.wget-hsts \
        /root/.bash_history /root/.python_history /root/.gnupg
    rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
    find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -delete
    find /var/log -type f -exec truncate -s 0 {} +
    rm -f /var/lib/dbus/machine-id
    : > /etc/machine-id
    rm -f /etc/ssh/ssh_host_*
    find /usr/share/gnome-shell/extensions /usr/local /opt -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
}

# --- step metadata ------------------------------------------------------------
step_title() {
    case $1 in
        updater)    echo "安装自动更新服务 / auto-updater" ;;
        base)       echo "安装系统软件包：开发工具、中文输入法、字体、虚拟化 / Ubuntu packages" ;;
        repos)      echo "安装 Chrome / VS Code / Firefox / Claude / ChatGPT" ;;
        debs)       echo "安装 微信 / Zoom / cc-switch" ;;
        npm)        echo "安装 Claude Code / Codex 命令行 / CLIs" ;;
        miniconda)  echo "安装 Miniconda" ;;
        tinytex)    echo "安装 TinyTeX (LaTeX)" ;;
        uvtool)     echo "安装 uv 工具 / uv tools (harbor)" ;;
        vocalinux)  echo "安装 Vocalinux 语音输入（需编译，较慢）/ voice input (compiles, slow)" ;;
        snaps)      echo "安装 Snap 应用：Blender、Slack、Discord、LocalSend ... / snaps" ;;
        extensions) echo "安装 GNOME 扩展 / GNOME extensions" ;;
        dconf)      echo "应用桌面默认设置 / desktop defaults" ;;
        files)      echo "安装系统文件与配置 / system files" ;;
        services)   echo "启用服务 / services" ;;
        hw)         echo "硬件检测：NVIDIA 驱动、ThinkPad P1 Gen 8 / hardware" ;;
        remove)     echo "移除已弃用的软件包 / retired packages" ;;
        *)          echo "$1" ;;
    esac
}

# Payload inputs of a step: paths relative to the payload, "conf:KEY" for
# sources.conf lines, "@name" for files outside the payload.
step_inputs() {
    case $1 in
        base)       echo packages.txt ;;
        repos)      echo conf:REPO conf:APT3P apt-sources keys rootfs/etc/apt/preferences.d ;;
        debs)       echo conf:DEB ;;
        npm)        echo conf:NPM ;;
        miniconda)  echo conf:MINICONDA ;;
        tinytex)    echo conf:TINYTEX ;;
        uvtool)     echo conf:UVTOOL ;;
        vocalinux)  echo conf:VOCALINUX ;;
        snaps)      echo conf:SNAP conf:SNAPDROP ;;
        extensions) echo extensions conf:ISLANDS ;;
        dconf)      echo dconf @gen-override ;;
        files)      echo rootfs ;;
        services)   echo rootfs/etc/systemd rootfs/usr/lib/systemd ;;
        hw)         echo rootfs/usr/local/lib/preload/hw ;;
        remove)     echo remove.txt ;;
        updater)    echo @updater ;;
    esac
}

hash_path() { # label path: name, executable bit and content of every file
    local f
    if [ -d "$2" ]; then
        ( cd "$2" && find . -type f -printf '%P\n' | LC_ALL=C sort | while IFS= read -r f; do
              printf '%s %s %s\n' "$1/$f" "$([ -x "$f" ] && echo x || echo -)" "$(sha256sum < "$f" | cut -c1-64)"
          done )
    elif [ -f "$2" ]; then
        printf '%s %s %s\n' "$1" "$([ -x "$2" ] && echo x || echo -)" "$(sha256sum < "$2" | cut -c1-64)"
    else
        echo "$1 absent"
    fi
}

step_hash() {
    local i
    {
        declare -f "step_$1"
        for i in $(step_inputs "$1"); do
            case $i in
                conf:*)        echo "$i"; conf "${i#conf:}" || true ;;
                @gen-override) hash_path gen-override.py "$GEN" ;;
                @updater)      hash_path updater "$U" ;;
                *)             hash_path "$i" "$P/$i" ;;
            esac
        done
    } | sha256sum | cut -c1-64
}

# --- main ---------------------------------------------------------------------
CHROOT_ALL=(base repos debs npm miniconda tinytex uvtool vocalinux extensions dconf files services remove updater)
# updater first: a fixed updater or a rotated key lands even if a later step fails
LIVE_ALL=(updater base repos debs npm miniconda tinytex uvtool vocalinux snaps extensions dconf files services hw remove)
# A failure of one of these is a failed update, not a partial one.
CORE=" updater repos extensions dconf files services "

CHANGED=0
if [ "${1:-}" = --changed ]; then CHANGED=1; shift; fi
steps=("$@")
if [ ${#steps[@]} -eq 0 ]; then
    if live; then steps=("${LIVE_ALL[@]}"); else steps=("${CHROOT_ALL[@]}"); fi
fi
install -d -m 0755 "$STATE" "$STATE/steps"

due=()
for s in "${steps[@]}"; do
    declare -F "step_$s" >/dev/null || { echo "unknown step: $s" >&2; exit 2; }
    case " ${PRELOAD_SKIP_STEPS:-} " in *" $s "*) echo "skipping $s (PRELOAD_SKIP_STEPS)"; continue ;; esac
    if [ $CHANGED = 1 ] && [ "$(cat "$STATE/steps/$s" 2>/dev/null)" = "$(step_hash "$s")" ]; then
        echo "unchanged: $s"; continue
    fi
    due+=("$s")
done

failed=() ran=() core_failed=0 n=0
for s in "${due[@]}"; do
    n=$((n + 1))
    progress "[$n/${#due[@]}] $(step_title "$s") ..."
    h=$(step_hash "$s")   # the inputs this run applies
    if ! live; then        # image build: fail fast
        "step_$s"
        echo "$h" > "$STATE/steps/$s"
        continue
    fi
    t0=$SECONDS
    set +e
    ( set -e; "step_$s" )
    rc=$?
    set -e
    if [ $rc = 0 ]; then
        echo "$h" > "$STATE/steps/$s"
        el=$((SECONDS - t0))
        if [ $el -lt 120 ]; then el="${el} s"; else el="$((el / 60)) min"; fi
        progress "      完成 / done ($el)"
        ran+=("$s")
    else
        rm -f "$STATE/steps/$s"
        failed+=("$s")
        [[ $CORE == *" $s "* ]] && core_failed=1
        progress "      失败 / FAILED: $s (exit $rc)"
    fi
done
if live; then
    printf '%s\n' "${failed[@]}" | grep -v '^$' > "$STATE/failed" || true
    # what this run changed, for preload-update's notification
    printf '%s\n' "${ran[@]}" | grep -v '^$' > "$STATE/ran" || true
fi
log "done: ${due[*]:-nothing to do}${failed[*]:+; failed: ${failed[*]}}"
[ $core_failed = 0 ] || exit 2
[ ${#failed[@]} -eq 0 ] || exit 1
exit 0
