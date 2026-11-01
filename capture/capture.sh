#!/bin/bash
# READ-ONLY helper for refreshing the payload from the owner's machine.
# It never copies anything into payload/; it prints what changed so a human
# can review it and update the whitelisted payload files by hand.
#
#   capture/capture.sh > /tmp/capture-report.txt
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
P=$ROOT/payload

echo "### apt: manually installed packages not in payload/packages.txt"
comm -23 <(apt-mark showmanual | sort) \
         <(grep -vE '^\s*(#|$)' "$P/packages.txt" | tr ' ' '\n' | grep -v '^$' | sort)

echo; echo "### snaps installed vs payload/sources.conf"
snap list | awk 'NR>1{print $1" "$4}' | sort > /tmp/.cap-snaps.$$
grep '^SNAP|' "$P/sources.conf" | cut -d'|' -f2 | sort | join -v1 /tmp/.cap-snaps.$$ - | sed 's/^/not in payload: /'
rm -f /tmp/.cap-snaps.$$

echo; echo "### GNOME extensions: enabled now vs payload defaults"
gsettings get org.gnome.shell enabled-extensions
grep '^enabled-extensions' "$P/dconf/defaults.ini"

echo; echo "### custom extension sources that differ from payload/extensions"
for d in "$P"/extensions/*/; do
    u=$(basename "$d"); src=$HOME/.local/share/gnome-shell/extensions/$u
    [ -d "$src" ] || { echo "missing locally: $u"; continue; }
    for f in $(cd "$d" && find . -type f); do
        cmp -s "$d/$f" "$src/$f" || echo "differs: $u/${f#./}  (payload has DEBUG=false edits)"
    done
done

echo; echo "### whitelisted dconf keys whose live value differs from payload/dconf/defaults.ini"
python3 - "$P/dconf/defaults.ini" <<'PY'
import subprocess, sys, re
schema = None
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    m = re.fullmatch(r'\[(.+)\]', line)
    if m:
        schema = m.group(1); continue
    key, val = line.split('=', 1)
    r = subprocess.run(['gsettings', 'get', schema, key], capture_output=True, text=True)
    live = r.stdout.strip()
    if r.returncode == 0 and live.replace(' ', '') != val.replace(' ', ''):
        print(f"{schema} {key}\n    payload: {val}\n    live:    {live}")
PY
