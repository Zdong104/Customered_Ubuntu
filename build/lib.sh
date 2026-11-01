# Shared helpers for the preload build scripts (sourced, not executed).
#
# Every build script re-executes itself inside a resource-capped transient
# systemd scope, so a heavy step (apt in the chroot, snap-preseed, mksquashfs,
# xorriso, the leak scan) can never exhaust the build host's RAM. Before each
# heavy step the scripts also wait until enough memory is available.
#
# Overrides (environment):
#   CAP_MEM_MAX=8G CAP_MEM_HIGH=7G CAP_SWAP_MAX=2G CAP_CPU_WEIGHT=40 CAP_IO_WEIGHT=40
#   MIN_AVAIL_GB=4      wait until MemAvailable >= this before a heavy step
#   MEM_WAIT_MIN=30     give up after this many minutes of waiting
#   PRELOAD_UNCAPPED=1  do not wrap (not recommended)

# Re-exec the calling script inside a capped scope (call as: run_capped_self "$@").
run_capped_self() {
    [ -n "${PRELOAD_CAPPED:-}" ] && return 0
    [ "${PRELOAD_UNCAPPED:-0}" = 1 ] && return 0
    command -v systemd-run >/dev/null || { echo "systemd-run missing" >&2; exit 1; }
    wait_mem
    export PRELOAD_CAPPED=1
    exec systemd-run --scope --quiet \
        -p MemoryMax="${CAP_MEM_MAX:-8G}" -p MemoryHigh="${CAP_MEM_HIGH:-7G}" \
        -p MemorySwapMax="${CAP_SWAP_MAX:-2G}" \
        -p CPUWeight="${CAP_CPU_WEIGHT:-40}" -p IOWeight="${CAP_IO_WEIGHT:-40}" \
        --setenv=PRELOAD_CAPPED=1 \
        nice -n 15 ionice -c3 "$BASH" "$0" "$@"
}

mem_avail_kb() { awk '/^MemAvailable:/{print $2}' /proc/meminfo; }

# Block until MemAvailable >= MIN_AVAIL_GB (poll every 60 s, up to MEM_WAIT_MIN minutes).
wait_mem() {
    local need=$(( ${MIN_AVAIL_GB:-4} * 1024 * 1024 )) tries=${MEM_WAIT_MIN:-30} i
    for (( i = 0; i <= tries; i++ )); do
        local have
        have=$(mem_avail_kb)
        if [ "$have" -ge "$need" ]; then
            return 0
        fi
        echo "[mem] MemAvailable $((have / 1024)) MiB < ${MIN_AVAIL_GB:-4} GiB; waiting (${i}/${tries} min)" >&2
        [ "$i" -lt "$tries" ] && sleep 60
    done
    echo "[mem] still not enough memory after ${tries} min; aborting this step" >&2
    exit 75
}
