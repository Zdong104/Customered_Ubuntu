#!/bin/bash
# Memory guard for test VMs/containers. systemd-oomd kills GNOME Shell once the
# user manager's memory pressure stays above 50% for 20 s; this stops our test
# load long before that. Polls every 2 s; trips when ANY of:
#   - MemAvailable < MIN_AVAIL_GB (default 8)
#   - system or user-manager memory pressure "some avg10" > MAX_PSI (default 5)
# On trip: hard-stop the test VM(s) and test containers, log, notify, exit 1.
#
#   test/memguard.sh            (run in the background for the whole test)
#   GUARD_VMS="cu-test" GUARD_CONTAINERS="preload-" ...
set -u
MIN_AVAIL_GB=${MIN_AVAIL_GB:-8}
MAX_PSI=${MAX_PSI:-5}
VMS=${GUARD_VMS:-cu-test}
CPREFIX=${GUARD_CONTAINERS:-preload-}
LOG=${GUARD_LOG:-$(dirname "$0")/../work/memguard.log}
USERPSI=/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/memory.pressure

psi() { awk '/^some/{split($2,a,"="); print a[2]; exit}' "$1" 2>/dev/null || echo 0; }
over() { awk -v v="$1" -v m="$2" 'BEGIN{exit !(v>m)}'; }

stop_tests() {
    for vm in $VMS; do
        virsh -c qemu:///system destroy "$vm" >/dev/null 2>&1 && echo "destroyed VM $vm"
    done
    docker ps --format '{{.Names}}' 2>/dev/null | grep "^$CPREFIX" | xargs -r docker kill >/dev/null 2>&1 &&
        echo "killed containers $CPREFIX*"
}

echo "$(date '+%F %T') memguard start (avail<${MIN_AVAIL_GB}G or psi>${MAX_PSI})" >> "$LOG"
while sleep 2; do
    avail=$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)
    sp=$(psi /proc/pressure/memory); up=$(psi "$USERPSI")
    if [ "$avail" -lt "$MIN_AVAIL_GB" ] || over "$sp" "$MAX_PSI" || over "$up" "$MAX_PSI"; then
        msg="memguard TRIPPED: avail=${avail}G psi_sys=$sp psi_user=$up"
        { echo "$(date '+%F %T') $msg"; stop_tests; } >> "$LOG" 2>&1
        notify-send -u critical "测试已紧急停止 / Test stopped" "$msg" 2>/dev/null
        exit 1
    fi
done
