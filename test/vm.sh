#!/bin/bash
# Boot the preload ISO in a fresh UEFI (Secure Boot + TPM) libvirt VM.
# Never touches existing VMs. Memory-capped: 4 GiB guest, 5 GiB cgroup hard
# limit for the whole qemu process, and it refuses to start unless the host
# has at least MIN_AVAIL_GB (default 8) of MemAvailable.
#
#   test/vm.sh out/preload-26.04.1-YYYYMMDD.iso [offline|online]
#
# offline (default): no NIC, proves the install needs no network.
# online           : default NAT network.
# Clean up afterwards:
#   virsh -c qemu:///system destroy preload-test
#   virsh -c qemu:///system undefine preload-test --nvram --remove-all-storage
#   sudo rm -f /var/lib/libvirt/images/preload-test.iso
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/build/lib.sh"
ISO=$(realpath "${1:?iso}")
MODE=${2:-offline}
NAME=${VM_NAME:-preload-test}
MIN_AVAIL_GB=${MIN_AVAIL_GB:-8} wait_mem
NET=(--network none)
[ "$MODE" = online ] && NET=(--network network=default,model=virtio)
# qemu (libvirt-qemu) cannot read files under a home directory: copy the ISO
# into the images pool, inside a capped scope (it is >10 GB of I/O).
case "$ISO" in /home/*)
    sudo systemd-run --scope --quiet -p MemoryMax=1G -p IOWeight=40 nice -n 15 ionice -c3 \
        install -m 0644 "$ISO" /var/lib/libvirt/images/preload-test.iso
    ISO=/var/lib/libvirt/images/preload-test.iso ;;
esac
/usr/bin/python3 /usr/bin/virt-install --connect qemu:///system --name "$NAME" \
    --memory 4096 --memtune hard_limit=5242880,soft_limit=4718592 \
    --vcpus 2 --cpu host-passthrough \
    --boot uefi,loader=/usr/share/OVMF/OVMF_CODE_4M.ms.fd,loader.readonly=yes,loader.type=pflash,loader.secure=yes,nvram.template=/usr/share/OVMF/OVMF_VARS_4M.ms.fd \
    --features smm.state=on --tpm emulator,model=tpm-crb,version=2.0 \
    --disk size=64,bus=virtio,format=qcow2 \
    --cdrom "$ISO" \
    --video virtio --graphics spice --channel spicevmc \
    "${NET[@]}" --osinfo ubuntu25.10 --noautoconsole
virt-viewer --connect qemu:///system "$NAME" &
