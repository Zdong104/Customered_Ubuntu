#!/bin/bash
# Lenovo ThinkPad P1 Gen 8 hardware tweaks. Runs inside the installed system
# (curtin in-target from the installer's late-commands, or preload-update's hw
# step on a live system) and does nothing on any other machine. Idempotent.
# Pass --force to apply regardless of DMI.
set -u
H=/usr/local/lib/preload/hw/thinkpad-p1-gen8
product=$(cat /sys/class/dmi/id/product_version 2>/dev/null)
if [ "${1:-}" != "--force" ] && [[ "$product" != "ThinkPad P1 Gen 8"* ]]; then
    echo "thinkpad-p1-gen8: '$product' is not a ThinkPad P1 Gen 8, skipping"
    exit 0
fi
echo "thinkpad-p1-gen8: applying tweaks for '$product'"

# 1. Kernel command line: PSR off (eDP flicker/black panel), TB5 host_reset=0.
#    A grub.d drop-in, so the user's own /etc/default/grub is never edited.
#    (Installs from older images have the options in /etc/default/grub.)
f=/etc/default/grub.d/90-preload-thinkpad-p1-gen8.cfg
want='GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT i915.enable_psr=0 thunderbolt.host_reset=0"'
if grep -qs 'thunderbolt.host_reset=0' /etc/default/grub; then
    echo "kernel options already in /etc/default/grub"
elif [ "$(cat $f 2>/dev/null)" != "$want" ]; then
    install -d /etc/default/grub.d
    printf '%s\n' "$want" > $f
    update-grub || true
    touch /var/run/reboot-required 2>/dev/null || true
fi

# 2. C10 PHY black-panel workaround: relight watcher (user service) + fix-display
install -m 0755 $H/fix-display $H/relight-panel /usr/local/bin/
install -m 0644 $H/relight-panel.service /usr/lib/systemd/user/relight-panel.service
systemctl --global enable relight-panel.service

# 3. PipeWire / WirePlumber restart-always drop-ins
for d in pipewire.service.d wireplumber.service.d; do
    install -d /etc/systemd/user/$d
    install -m 0644 $H/user-dropins/$d/override.conf /etc/systemd/user/$d/50-preload-thinkpad-p1-gen8.conf
done

# 4. NVIDIA PRIME on-demand (hybrid Intel + NVIDIA)
echo on-demand > /etc/prime-discrete

# 5. Super+Shift+D -> fix-display (dconf system database default)
install -d /etc/dconf/profile /etc/dconf/db/local.d
[ -f /etc/dconf/profile/user ] || printf 'user-db:user\nsystem-db:local\n' > /etc/dconf/profile/user
install -m 0644 $H/50-thinkpad-p1-gen8-keybinding /etc/dconf/db/local.d/50-thinkpad-p1-gen8-keybinding
dconf update
exit 0
