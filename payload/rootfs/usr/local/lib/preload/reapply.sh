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
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$OUT" 2>/dev/null
exit 0
