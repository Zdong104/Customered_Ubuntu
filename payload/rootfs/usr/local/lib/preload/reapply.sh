#!/bin/sh
# Re-apply preload tweaks that live in package-owned files and are therefore
# overwritten by package upgrades. Run as root from the apt hook
# /etc/apt/apt.conf.d/99preload-reapply (and once at image build time).
#
#  1. DING patch (sushi Previewer2 preview + desktop icons on the primary
#     monitor) into /usr/share/gnome-shell/extensions/ding@rastersoft.com.
#  2. XWayland launcher overrides in /usr/local/share/applications for Chrome
#     and Claude Desktop (--ozone-platform=x11), so fcitx5's candidate window is
#     positioned correctly. /usr/local/share precedes /usr/share in XDG_DATA_DIRS.
#     They are regenerated from the current package .desktop files every time.
#     WeChat gets a Wayland text-input-v3 launcher (system fcitx5 candidates
#     and working notifications), regenerated the same way.
#  3. ONLYOFFICE plugins shipped by preload (ProCharts) into ONLYOFFICE's
#     system plugin folder under /opt/onlyoffice.

L=/usr/local/lib/preload

# --- 1. DING ---------------------------------------------------------------
D=/usr/share/gnome-shell/extensions/ding@rastersoft.com
PATCH=$L/ding-local.patch
if [ -f "$PATCH" ] && [ -d "$D" ]; then
    (
        cd "$D" || exit 0
        if patch -p1 -R --dry-run -s -f < "$PATCH" >/dev/null 2>&1; then
            : # already applied
        elif patch -p1 -N --dry-run -s -f < "$PATCH" >/dev/null 2>&1; then
            patch -p1 -N -s -f --no-backup-if-mismatch < "$PATCH" &&
                logger -t preload-reapply "re-applied DING patch" 2>/dev/null
        else
            logger -t preload-reapply "DING patch no longer applies; review $PATCH" 2>/dev/null
        fi
    )
fi

# --- 2. XWayland launcher overrides ---------------------------------------
OUT=/usr/local/share/applications
mkdir -p "$OUT"
# desktop-file  binary-to-match
for pair in \
    "google-chrome.desktop:/usr/bin/google-chrome-stable" \
    "com.google.Chrome.desktop:/usr/bin/google-chrome-stable" \
    "com.anthropic.Claude.desktop:claude-desktop"
do
    name=${pair%%:*}
    bin=${pair#*:}
    src=/usr/share/applications/$name
    if [ ! -f "$src" ]; then
        rm -f "$OUT/$name"
        continue
    fi
    # Insert --ozone-platform=x11 right after the binary on every Exec= line
    # that does not already carry it.
    sed -E "/^Exec=/{/--ozone-platform=/!s#^(Exec=(env [^ ]+ )*)($bin)( |\$)#\1\3 --ozone-platform=x11\4#}" \
        "$src" > "$OUT/$name.tmp" && mv "$OUT/$name.tmp" "$OUT/$name"
    chmod 644 "$OUT/$name"
done
# WeChat (Qt 6 with its own bundled fcitx5-qt): run it natively on Wayland and
# route input through Wayland text-input-v3 -> GNOME Shell -> fcitx5's IBus
# frontend, so the system fcitx5 draws the (mac-themed) candidate bar. Its
# bundled IM module draws a blinking popup of its own on native Wayland, and
# under XWayland WeChat sends no desktop notifications. QT_IM_MODULES=fcitx
# from /etc/environment.d would select the bundled module, hence -u.
src=/usr/share/applications/wechat.desktop
if [ -f "$src" ]; then
    sed -E '/^Exec=/{/QT_IM_MODULE=text-input/!s#^Exec=#Exec=env -u QT_IM_MODULES QT_QPA_PLATFORM=wayland QT_IM_MODULE=text-input-unstable-v3 #}' \
        "$src" > "$OUT/wechat.desktop.tmp" && mv "$OUT/wechat.desktop.tmp" "$OUT/wechat.desktop"
    chmod 644 "$OUT/wechat.desktop"
else
    rm -f "$OUT/wechat.desktop"
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$OUT" 2>/dev/null

# --- 3. ONLYOFFICE plugins shipped by preload ------------------------------
# Each built plugin (/usr/local/share/preload/onlyoffice-plugins/*.plugin, the
# zip format of ONLYOFFICE's Plugin Manager) is unpacked into ONLYOFFICE's
# system plugin folder, so every user has it. That folder belongs to the
# onlyoffice-desktopeditors package, so this also restores the plugins after an
# upgrade or reinstall. A stamp per plugin (sha256 of the shipped zip) means it
# is only re-extracted when the shipped file changes or the folder is gone;
# plugins preload stops shipping are removed again.
if command -v python3 >/dev/null 2>&1; then
    python3 - /usr/local/share/preload/onlyoffice-plugins \
        /opt/onlyoffice/desktopeditors/editors/sdkjs-plugins \
        /var/lib/preload/onlyoffice-plugins <<'PY' || logger -t preload-reapply "ONLYOFFICE plugin install failed" 2>/dev/null
import hashlib, json, os, re, shutil, subprocess, sys, zipfile

src, dst, stampd = sys.argv[1:4]
def log(msg):
    subprocess.run(["logger", "-t", "preload-reapply", msg], check=False)
if not os.path.isdir(dst):          # ONLYOFFICE not installed (yet)
    shutil.rmtree(stampd, ignore_errors=True)
    sys.exit(0)
os.makedirs(stampd, exist_ok=True)
shipped = set()
for name in sorted(os.listdir(src)) if os.path.isdir(src) else []:
    if not name.endswith(".plugin"):
        continue
    path = os.path.join(src, name)
    try:
        data = open(path, "rb").read()
        z = zipfile.ZipFile(path)
        guid = json.loads(z.read("config.json"))["guid"]
    except Exception as e:
        log(f"skipping {name}: {e}")
        continue
    m = re.fullmatch(r"(?:asc\.)?(\{[0-9A-Fa-f-]{36}\})", guid)
    if not m:
        log(f"skipping {name}: unexpected guid {guid!r}")
        continue
    folder = m.group(1)
    shipped.add(folder)
    sha = hashlib.sha256(data).hexdigest()
    stamp = os.path.join(stampd, folder)
    target = os.path.join(dst, folder)
    if os.path.isfile(os.path.join(target, "config.json")) and \
            os.path.isfile(stamp) and open(stamp).read().strip() == sha:
        continue
    members = z.namelist()
    if any(n.startswith("/") or ".." in n.split("/") for n in members):
        log(f"skipping {name}: unsafe path in zip")
        continue
    tmp = os.path.join(dst, "." + folder + ".new")
    shutil.rmtree(tmp, ignore_errors=True)
    z.extractall(tmp)
    for root, dirs, files in os.walk(tmp):
        os.chmod(root, 0o755)
        for f in files:
            os.chmod(os.path.join(root, f), 0o644)
    shutil.rmtree(target, ignore_errors=True)
    os.rename(tmp, target)
    open(stamp, "w").write(sha + "\n")
    log(f"installed ONLYOFFICE plugin {name} into {target}")
for folder in os.listdir(stampd):
    if folder not in shipped:
        shutil.rmtree(os.path.join(dst, folder), ignore_errors=True)
        os.remove(os.path.join(stampd, folder))
        log(f"removed ONLYOFFICE plugin {folder} (no longer shipped)")
PY
fi
exit 0
