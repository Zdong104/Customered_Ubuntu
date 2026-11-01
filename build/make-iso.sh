#!/bin/bash
# Assemble the preload ISO from the stock 26.04.1 desktop ISO + the preload layer.
#
#   sudo build/make-iso.sh [OUTPUT.iso]
#
# Inputs : stock ISO ($STOCK_ISO), work/out/minimal.standard.preload.{squashfs,size,manifest},
#          work/pool (NVIDIA offline pool), iso/ (grub.cfg, install-sources.yaml.in, preload/)
# Changes vs stock:
#   + /casper/minimal.standard.preload.{squashfs,size,manifest}
#   + /preload/{oobe,interactive}/{user-data,meta-data}, /preload/late.sh, /preload/pool/
#   ~ /casper/install-sources.yaml  (single source: the preload layer, no language layers)
#   ~ /boot/grub/grub.cfg, /boot/grub/loopback.cfg (preload install entries)
#   - language layers and enhanced-secureboot (TPM FDE) layers (unused by the preload source)
#   ~ /md5sum.txt
# Boot records (El Torito, GPT/MBR, appended ESP) are replayed from the stock ISO.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$ROOT/work
STOCK=${STOCK_ISO:-$ROOT/work/ubuntu-26.04.1-desktop-amd64.iso}   # or a symlink there
OUT=${1:-$ROOT/out/preload-26.04.1-$(date +%Y%m%d).iso}
LAYER=minimal.standard.preload
ST=$W/iso-stage
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
. "$ROOT/build/lib.sh"
run_capped_self "$@"     # md5 + xorriso run in a MemoryMax-capped scope
for f in "$W/out/$LAYER.squashfs" "$W/out/$LAYER.size" "$W/out/$LAYER.manifest" "$W/pool/Packages"; do
    [ -e "$f" ] || { echo "missing $f (run build-layer.sh first)" >&2; exit 1; }
done
mkdir -p "$(dirname "$OUT")" "$W/iso"
mountpoint -q "$W/iso" || mount -o loop,ro "$STOCK" "$W/iso"

rm -rf "$ST"; mkdir -p "$ST/casper" "$ST/boot/grub" "$ST/preload"
# casper metadata
sed "s/@SIZE@/$(cat "$W/out/$LAYER.size")/" "$ROOT/iso/install-sources.yaml.in" > "$ST/casper/install-sources.yaml"
cp "$W/out/$LAYER.size" "$W/out/$LAYER.manifest" "$ST/casper/"
# grub
cp "$ROOT/iso/grub.cfg" "$ST/boot/grub/grub.cfg"
awk '/^menuentry "Install Ubuntu/{p=1} p{print} /^}/{if(p){p=0}}' "$ROOT/iso/grub.cfg" |
    sed 's#ds=nocloud#iso-scan/filename=${iso_path} ds=nocloud#' > "$ST/boot/grub/loopback.cfg"
# preload dir (autoinstall configs, late-commands, NVIDIA pool)
cp -r "$ROOT/iso/preload/." "$ST/preload/"
mkdir -p "$ST/preload/pool"; cp -a "$W/pool/." "$ST/preload/pool/"
chmod -R a+rX "$ST"

# files to drop from /casper
mapfile -t DROP < <(cd "$W/iso/casper" && ls | grep -E '^minimal(\.standard)?\.(enhanced-secureboot|no-languages|de|en|es|fr|it|pt|ru|zh)(\.|$)' || true)
printf 'dropping %s files from /casper\n' "${#DROP[@]}"

# md5sum.txt: stock entries minus dropped/replaced, plus ours
python3 - "$W/iso/md5sum.txt" "$ST" "$W/out/$LAYER.squashfs" "${DROP[@]}" > "$ST/md5sum.txt" <<'PY'
import hashlib, os, sys
stock, stage, layer, drop = sys.argv[1], sys.argv[2], sys.argv[3], set(sys.argv[4:])
def md5(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()
ours = {}
for d, _, files in os.walk(stage):
    for n in files:
        p = os.path.join(d, n)
        rel = "./" + os.path.relpath(p, stage)
        if rel != "./md5sum.txt":
            ours[rel] = md5(p)
ours["./casper/minimal.standard.preload.squashfs"] = md5(layer)
for line in open(stock):
    h, rel = line.rstrip("\n").split("  ", 1)
    if rel.startswith("./casper/") and rel[len("./casper/"):] in drop:
        continue
    if rel in ours:
        continue
    print(f"{h}  {rel}")
for rel in sorted(ours):
    print(f"{ours[rel]}  {rel}")
PY

wait_mem
rm -f "$OUT"
RM=()
for f in "${DROP[@]}"; do RM+=("/casper/$f"); done
xorriso -indev "$STOCK" -outdev "$OUT" \
    -compliance iso_9660_level=3 \
    -boot_image any replay \
    -rm "${RM[@]}" -- \
    -map "$W/out/$LAYER.squashfs" "/casper/$LAYER.squashfs" \
    -map "$ST/casper/$LAYER.size" "/casper/$LAYER.size" \
    -map "$ST/casper/$LAYER.manifest" "/casper/$LAYER.manifest" \
    -map "$ST/casper/install-sources.yaml" /casper/install-sources.yaml \
    -map "$ST/boot/grub/grub.cfg" /boot/grub/grub.cfg \
    -map "$ST/boot/grub/loopback.cfg" /boot/grub/loopback.cfg \
    -map "$ST/preload" /preload \
    -map "$ST/md5sum.txt" /md5sum.txt \
    -end
chown "${SUDO_UID:-0}:${SUDO_GID:-0}" "$OUT" 2>/dev/null || true
ls -la "$OUT"
sha256sum "$OUT" | tee "$OUT.sha256"
