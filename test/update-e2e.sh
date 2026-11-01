#!/bin/bash
# End-to-end test of bootstrap.sh + preload-update in a disposable Ubuntu
# 26.04 container booted with systemd. Needs docker; never touches the host
# system (the container gets its own cgroup namespace and no privileges).
#
#   test/update-e2e.sh [WORKDIR]
#
# Uses the COMMITTED HEAD of this repo, re-keyed with a throwaway test key and
# served from a local file:// remote (PRELOAD_TEST_REMOTE). Heavy download
# steps are skipped (PRELOAD_SKIP_STEPS); the debs step is kept but pointed at
# a dead URL to exercise "optional step failed, rest continues".
#
# Covers: (a) bootstrap on a stock-ish system, (b) unsigned / wrong-key /
# lightweight / replayed tags refused, (c) downgrade refused, (d) a second
# release re-runs only the changed steps, removes a dropped file and restores
# the user's original, (e) notification path without a GUI, the systemd
# timer/service path, per-user sync, and an ISO-style (chroot mode) install
# that later updates live.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$(realpath -m "${1:-$(mktemp -d /var/tmp/preload-e2e.XXXXXX)}")
IMG=preload-upd-test:base
C=preload-e2e
C2=preload-e2e-iso
SKIP="base repos npm miniconda tinytex uvtool vocalinux snaps"
PASS=0 FAILN=0
ok()  { echo "PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $*"; FAILN=$((FAILN + 1)); }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
inc() { docker exec "$C" bash -c "$1"; }
cleanup() { docker rm -f "$C" "$C2" >/dev/null 2>&1 || true; docker rmi "$IMG-iso" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --- test image ------------------------------------------------------------------
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    mkdir -p "$W/img"
    cat > "$W/img/Dockerfile" <<'EOF'
FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus dbus-user-session git openssh-client ca-certificates curl python3 \
    libglib2.0-bin gnome-shell gnome-shell-extension-ubuntu-dock gnome-shell-extension-desktop-icons-ng \
    gnome-shell-extension-ubuntu-tiling-assistant nautilus gnome-settings-daemon libnotify-bin sudo \
    patch logrotate dconf-cli dconf-service gsettings-desktop-schemas yaru-theme-gtk shellcheck \
    desktop-file-utils udev kmod && apt-get clean
RUN useradd -m -s /bin/bash -G sudo friend
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
    docker build -q -t "$IMG" "$W/img"
fi

# --- owner side: test key, re-keyed repo, signed releases -------------------------
mkdir -p "$W"; rm -rf "$W/owner" "$W/remote.git" "$W/keys"; mkdir -p "$W/keys"
ssh-keygen -q -t ed25519 -N '' -C test-release -f "$W/keys/good"
ssh-keygen -q -t ed25519 -N '' -C attacker -f "$W/keys/bad"
echo "preload-release namespaces=\"git\" $(cut -d' ' -f1,2 "$W/keys/good.pub")" > "$W/keys/signers"
git clone -q --no-tags --single-branch "$ROOT" "$W/owner"   # real release tags would collide with test tags
O=(git -C "$W/owner" -c user.name=t -c user.email=t@example.invalid -c gpg.format=ssh)
cp "$W/keys/signers" "$W/owner/updater/allowed_signers"
sed -i '/^DEB|/d' "$W/owner/payload/sources.conf"
echo 'DEB|bogus|https://127.0.0.1:9/nonexistent.deb' >> "$W/owner/payload/sources.conf"
"${O[@]}" commit -qam "test: re-key, dead deb URL"
sign() { "${O[@]}" -c user.signingkey="$W/keys/$1" tag -s -a "$2" -m "$2"; }
sign good v2026.11.01
git clone -q --bare "$W/owner" "$W/remote.git"
push() { "${O[@]}" push -q --force "$W/remote.git" "$@"; }
push --tags

# --- friend's machine ----------------------------------------------------------------
docker rm -f "$C" >/dev/null 2>&1 || true
docker run -d --name "$C" -e container=docker --security-opt writable-cgroups=true \
    --tmpfs /run --tmpfs /run/lock --cgroupns=private --memory=3g --memory-swap=3g --cpus=2 -v "$W:/t:ro" "$IMG" >/dev/null
for _ in $(seq 30); do inc 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"' && break; sleep 1; done
ENV="PRELOAD_TEST_REMOTE=file:///t/remote.git PRELOAD_TEST_SIGNERS=/t/keys/signers PRELOAD_SKIP_STEPS='$SKIP'"
# a file the friend already had, which the payload will overwrite
inc 'mkdir -p /etc/libinput && echo "# friend own quirk" > /etc/libinput/local-overrides.quirks'
# the friend has customised their extension list already
inc "runuser -u friend -- dbus-run-session -- gsettings set org.gnome.shell enabled-extensions \"['ubuntu-dock@ubuntu.com']\""

echo "== (a) bootstrap"
rc=0; inc "cd / && $ENV bash /t/owner/bootstrap.sh" || rc=$?
[ $rc = 1 ] && ok "bootstrap exit 1 (optional debs step failed, rest continued)" || bad "bootstrap exit $rc, expected 1"
check "applied version v2026.11.01" inc 'grep -qx v2026.11.01 /var/lib/preload/state/version'
check "only debs listed as failed" inc 'grep -qx debs /var/lib/preload/state/failed && [ $(wc -l < /var/lib/preload/state/failed) = 1 ]'
check "updater installed" inc 'test -x /usr/local/sbin/preload-update && test -s /etc/preload/allowed_signers'
check "timer enabled+active" inc 'systemctl is-enabled preload-update.timer && systemctl is-active preload-update.timer'
check "user-sync enabled globally" inc 'test -L /etc/systemd/user/default.target.wants/preload-user-sync.service'
check "custom extension installed" inc 'test -f /usr/share/gnome-shell/extensions/hide-minimized@zihan.local/extension.js'
check "workspace-islands installed" inc 'test -f /usr/share/gnome-shell/extensions/workspace-islands@danielbernalo.github.io/metadata.json'
check "dock icon default 42" inc '[ "$(GSETTINGS_BACKEND=memory gsettings get org.gnome.shell.extensions.dash-to-dock dash-max-icon-size)" = 42 ]'
check "rootfs file installed" inc 'test -f /usr/share/applications/vocalinux.desktop'
check "friend quirks backed up" inc 'grep -q "friend own quirk" /var/lib/preload/backup/etc/libinput/local-overrides.quirks'
check "notification path ran without GUI" inc 'grep -q "notified 0 graphical session" /var/log/preload-update.log'
check "--status works unprivileged" inc 'runuser -u friend -- /usr/local/sbin/preload-update --status | grep -q v2026.11.01'
check "release tree is pristine (no .git)" inc '! test -e /var/lib/preload/releases/v2026.11.01/.git'

rc=0; out=$(inc "cd / && $ENV bash /t/owner/bootstrap.sh" 2>&1) || rc=$?
[ $rc = 1 ] && grep -q "retrying failed steps of v2026.11.01: debs" <<< "$out" && grep -q '\[1/1\]' <<< "$out" &&
    ok "re-running the install command resumes (only the failed step re-runs)" || { bad "re-run of bootstrap (rc=$rc)"; echo "$out" | tail -15; }

echo "== per-user sync"
inc 'runuser -u friend -- dbus-run-session -- /usr/local/lib/preload/preload-user-sync'
check "skel file copied to existing user" inc 'test -f ~friend/.xinputrc && test -f ~friend/.config/fcitx5/profile'
check "new extensions enabled for existing user" inc "runuser -u friend -- dbus-run-session -- gsettings get org.gnome.shell enabled-extensions | grep -q \"'ubuntu-dock@ubuntu.com'.*hide-minimized@zihan.local\""
inc "runuser -u friend -- dbus-run-session -- gsettings set org.gnome.shell enabled-extensions \"['ubuntu-dock@ubuntu.com']\"; rm ~friend/.xinputrc"
inc 'runuser -u friend -- dbus-run-session -- /usr/local/lib/preload/preload-user-sync'
check "user's own disable + delete stick (offered once)" inc "! test -e ~friend/.xinputrc && runuser -u friend -- dbus-run-session -- gsettings get org.gnome.shell enabled-extensions | grep -qx \"\\['ubuntu-dock@ubuntu.com'\\]\""

echo "== (b) unsigned / wrong-key / lightweight / replayed tags"
"${O[@]}" commit -q --allow-empty -m "evil 1"; "${O[@]}" tag v2026.11.02                       # lightweight
"${O[@]}" commit -q --allow-empty -m "evil 2"; "${O[@]}" tag -a v2026.11.03 -m unsigned         # annotated, unsigned
"${O[@]}" commit -q --allow-empty -m "evil 3"; sign bad v2026.11.04                             # attacker key
"${O[@]}" update-ref refs/tags/v2026.11.05 "$("${O[@]}" rev-parse v2026.11.01)"                 # old signed tag, new name
push --tags; push HEAD:refs/heads/master
out=$(inc "$ENV preload-update --check" 2>&1 || true); echo "$out" | sed 's/^/   | /'
for t in 02:"not an annotated tag" 03:"not SSH-signed" 04:"signature not valid" 05:"replayed tag"; do
    grep -q "refused v2026.11.${t%%:*}: .*${t#*:}" <<< "$out" && ok "v2026.11.${t%%:*} refused (${t#*:})" || bad "v2026.11.${t%%:*} not refused as '${t#*:}'"
done
grep -q "up to date (v2026.11.01)" <<< "$out" && ok "stays on v2026.11.01" || bad "did not stay on v2026.11.01"
"${O[@]}" reset -q --hard "v2026.11.01^{commit}"

echo "== (d) second release: one extension file, one dconf key, one dropped rootfs file"
echo "// e2e change" >> "$W/owner/payload/extensions/hide-minimized@zihan.local/extension.js"
sed -i 's/^dash-max-icon-size=42/dash-max-icon-size=48/' "$W/owner/payload/dconf/defaults.ini"
"${O[@]}" rm -q payload/rootfs/usr/share/applications/vocalinux.desktop payload/rootfs/etc/libinput/local-overrides.quirks
"${O[@]}" commit -qam "release 2"
sign good v2026.11.10
push --tags
# through the real timer path: the service unit, with the test remote in a drop-in
inc "mkdir -p /etc/systemd/system/preload-update.service.d && printf '[Service]\nEnvironment=PRELOAD_TEST_REMOTE=file:///t/remote.git \"PRELOAD_SKIP_STEPS=$SKIP\"\n' > /etc/systemd/system/preload-update.service.d/test.conf && systemctl daemon-reload"
inc ': > /var/log/preload-update.log'
inc 'systemctl start preload-update.service' || true
check "service ran (Result=exit-code 1 = partial, debs)" inc '[ "$(systemctl show preload-update.service -p ExecMainStatus --value)" = 1 ]'
check "applied version v2026.11.10" inc 'grep -qx v2026.11.10 /var/lib/preload/state/version'
ran=$(inc "grep -oE '\[provision\] \[[0-9]+/[0-9]+\] .*' /var/log/preload-update.log" || true)
echo "$ran" | sed 's/^/   | /'
[ "$(grep -c . <<< "$ran")" = 4 ] && grep -q '\[1/4\] .*微信' <<< "$ran" && grep -q 'GNOME' <<< "$ran" &&
    grep -q 'desktop defaults' <<< "$ran" && grep -q 'system files' <<< "$ran" &&
    ok "re-ran exactly: debs (retry), extensions, dconf, files" || bad "unexpected set of steps re-ran"
check "unchanged steps skipped" inc 'grep -q "unchanged: updater" /var/log/preload-update.log && grep -q "unchanged: services" /var/log/preload-update.log && grep -q "unchanged: hw" /var/log/preload-update.log'
check "workspace-islands not re-fetched for an extension change" inc 'grep -q "islands: 已安装，跳过" /var/log/preload-update.log && ! grep -q "Cloning into" /var/log/preload-update.log'
check "extension file updated" inc 'tail -1 /usr/share/gnome-shell/extensions/hide-minimized@zihan.local/extension.js | grep -q "e2e change"'
check "dock icon default now 48" inc '[ "$(GSETTINGS_BACKEND=memory gsettings get org.gnome.shell.extensions.dash-to-dock dash-max-icon-size)" = 48 ]'
check "dropped file removed" inc '! test -e /usr/share/applications/vocalinux.desktop'
check "friend's original file restored" inc 'grep -q "friend own quirk" /etc/libinput/local-overrides.quirks'
check "journal has the run" inc 'journalctl -u preload-update.service --no-pager | grep -q "v2026.11.10"'
check "service ran inside its memory cap" inc '[ "$(systemctl show preload-update.service -p MemoryMax --value)" = 4294967296 ]'

echo "== (c) downgrade"
"${O[@]}" commit -q --allow-empty -m "older"; sign good v2026.11.09; push --tags
out=$(inc "$ENV preload-update --now" 2>&1 || true); echo "$out" | sed 's/^/   | /'
check "still v2026.11.10 after a newer-signed older version" inc 'grep -qx v2026.11.10 /var/lib/preload/state/version && ! grep -q v2026.11.09 /var/lib/preload/state/history'
check "--rollback-info works" inc 'preload-update --rollback-info | grep -q "never go backwards"'

echo "== (f) first install on a machine that already has the apps: everything adopted, nothing fetched"
inc 'set -e
     for m in @anthropic-ai/claude-code @openai/codex node-gyp nw-gyp; do
         mkdir -p /usr/local/lib/node_modules/$m; echo "{}" > /usr/local/lib/node_modules/$m/package.json; done
     mkdir -p /opt/miniconda3/bin /opt/TinyTeX /opt/uv/tools/harbor
     printf "#!/bin/sh\n" > /opt/miniconda3/bin/conda; printf "#!/bin/sh\n" > /usr/local/bin/tlmgr
     chmod +x /opt/miniconda3/bin/conda /usr/local/bin/tlmgr
     d=/opt/vocalinux/venv/lib/python3.14/site-packages/vocalinux-0.dist-info; mkdir -p $d /opt/vocalinux/venv/bin
     ln -sf /usr/bin/python3 /opt/vocalinux/venv/bin/python
     IFS="|" read -r repo tag <<< "$(sed -n "s/^VOCALINUX|//p" /var/lib/preload/current/payload/sources.conf)"
     printf "{\"url\": \"%s\", \"vcs_info\": {\"vcs\": \"git\", \"requested_revision\": \"%s\"}}\n" "$repo" "$tag" > $d/direct_url.json
     mv /var/lib/preload/state /var/lib/preload/state.saved; : > /var/log/preload-update.log'
t0=$SECONDS
out=$(inc "PRELOAD_TEST_REMOTE=file:///t/remote.git PRELOAD_SKIP_STEPS='base repos snaps' preload-update --now" 2>&1 || true)
dt=$((SECONDS - t0)); echo "$out" | sed 's/^/   | /'
for k in npm miniconda tinytex uvtool vocalinux islands; do
    grep -q "$k: 已安装，跳过 / already installed, skipped" <<< "$out" && ok "$k adopted (already installed, skipped)" || bad "$k not skipped"
done
[ $dt -lt 120 ] && ok "full first-install run on a populated machine took ${dt}s" || bad "populated full run took ${dt}s"
check "nothing was downloaded for adopted items" inc '! grep -qE "Cloning into|Downloading|npm (warn|notice)" /var/log/preload-update.log'
check "notification text asks for re-login after extension changes" inc 'grep -qx extensions /var/lib/preload/state/ran'
inc 'rm -rf /var/lib/preload/state && mv /var/lib/preload/state.saved /var/lib/preload/state'
docker rm -f "$C" >/dev/null 2>&1 || true   # one heavy thing at a time

echo "== (e) ISO-style install (chroot mode at v2026.11.01), then a live update"
docker rm -f "$C2" >/dev/null 2>&1 || true
rm -rf "$W/v1"; mkdir -p "$W/v1"; git -C "$W/owner" archive v2026.11.01 | tar -x -C "$W/v1"
docker run --name "$C2" --memory=3g --memory-swap=3g --cpus=2 -v "$W:/t:ro" "$IMG" bash -c '
    set -e; mkdir -p /tmp/preload-payload
    cp -a /t/v1/payload/. /tmp/preload-payload/; cp /t/v1/build/gen-override.py /tmp/preload-payload/
    cp -a /t/v1/updater /tmp/preload-payload/updater
    PRELOAD_VERSION=v2026.11.01 bash /tmp/preload-payload/provision.sh extensions dconf files services remove updater
    rm -rf /tmp/preload-payload' > "$W/chroot.log" 2>&1 && ok "chroot-mode provisioning (ISO build path)" || { bad "chroot-mode provisioning"; tail -20 "$W/chroot.log"; }
docker commit "$C2" "$IMG-iso" >/dev/null; docker rm -f "$C2" >/dev/null
docker run -d --name "$C2" -e container=docker --security-opt writable-cgroups=true \
    --tmpfs /run --tmpfs /run/lock --cgroupns=private --memory=3g --memory-swap=3g --cpus=2 -v "$W:/t:ro" "$IMG-iso" /sbin/init >/dev/null
for _ in $(seq 30); do docker exec "$C2" bash -c 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"' && break; sleep 1; done
check "image marks its release v2026.11.01" docker exec "$C2" grep -qx v2026.11.01 /var/lib/preload/state/version
check "timer enabled in image" docker exec "$C2" systemctl is-enabled preload-update.timer
docker exec "$C2" bash -c "$ENV preload-update --now" > "$W/iso-update.log" 2>&1 || true
sed 's/^/   | /' "$W/iso-update.log"
check "ISO install updated to v2026.11.10" docker exec "$C2" grep -qx v2026.11.10 /var/lib/preload/state/version
check "ISO install: updater/services unchanged, not re-run" docker exec "$C2" bash -c 'grep -q "unchanged: updater" /var/log/preload-update.log && grep -q "unchanged: services" /var/log/preload-update.log'
check "ISO install: dropped file removed" docker exec "$C2" bash -c '! test -e /usr/share/applications/vocalinux.desktop'

echo
echo "e2e: $PASS passed, $FAILN failed   (workdir $W)"
[ $FAILN = 0 ]
