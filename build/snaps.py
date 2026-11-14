#!/usr/bin/env python3
"""Add snaps to the image's snapd seed (and drop unwanted ones).

    snaps.py SOURCES_CONF ROOTFS CACHE_DIR

For every `SNAP|name|channel` line: `snap download` it (with its assertions),
then pull in its base and the default-providers of its content plugs,
recursively, unless the seed already has them. Seed snaps listed on the
`SNAPDROP|a b c` line are removed. The result is checked with
`snap debug validate-seed`. Re-preseeding is done by build-layer.sh.
"""
import glob
import os
import shutil
import subprocess
import sys

import yaml


def sh(*cmd, **kw):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def snap_meta(path):
    out = subprocess.run(["unsquashfs", "-cat", path, "meta/snap.yaml"],
                         check=True, capture_output=True, text=True).stdout
    return yaml.safe_load(out)


def download(name, channel, cache):
    os.makedirs(cache, exist_ok=True)
    have = sorted(glob.glob(os.path.join(cache, f"{name}_*.snap")))
    if not have:
        sh("snap", "download", f"--channel={channel}", f"--target-directory={cache}", name)
        have = sorted(glob.glob(os.path.join(cache, f"{name}_*.snap")))
    snapf = have[-1]
    assertf = snapf[:-5] + ".assert"
    if not os.path.exists(assertf):
        sys.exit(f"missing assertion for {snapf}")
    return snapf, assertf


def main(conf, root, cache):
    wanted, drop = [], []
    for line in open(conf, encoding="utf-8"):
        parts = line.strip().split("|")
        if parts[0] == "SNAP":
            wanted.append((parts[1], parts[2]))
        elif parts[0] == "SNAPDROP":
            drop = parts[1].split()

    seed = os.path.join(root, "var/lib/snapd/seed")
    seed_yaml = os.path.join(seed, "seed.yaml")
    data = yaml.safe_load(open(seed_yaml))
    entries = data["snaps"]

    # drop
    keep = []
    for e in entries:
        if e["name"] in drop:
            print("dropping", e["name"])
            for p in (os.path.join(seed, "snaps", e["file"]),
                      os.path.join(seed, "assertions", e["file"][:-5] + ".assert")):
                if os.path.exists(p):
                    os.remove(p)
        else:
            keep.append(e)
    entries = keep
    present = {e["name"] for e in entries}

    queue = list(wanted)
    added = []
    while queue:
        name, channel = queue.pop(0)
        if name in present:
            continue
        snapf, assertf = download(name, channel, cache)
        meta = snap_meta(snapf)
        base = meta.get("base")
        if meta.get("type") not in ("base", "snapd", "os"):
            queue.append((base or "core", "latest/stable"))
        for plug in (meta.get("plugs") or {}).values():
            if isinstance(plug, dict) and plug.get("interface") == "content" and plug.get("default-provider"):
                queue.append((plug["default-provider"].split(":")[0], "latest/stable"))
        fname = os.path.basename(snapf)
        shutil.copy2(snapf, os.path.join(seed, "snaps", fname))
        shutil.copy2(assertf, os.path.join(seed, "assertions", fname[:-5] + ".assert"))
        entry = {"name": name, "channel": channel, "file": fname}
        if meta.get("confinement") == "classic":
            entry["classic"] = True
        entries.append(entry)
        present.add(name)
        added.append(name)
        print(f"seeded {name} ({channel}) -> {fname}")

    data["snaps"] = entries
    with open(seed_yaml, "w") as f:
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
    os.chmod(seed_yaml, 0o644)
    for p in glob.glob(os.path.join(seed, "snaps", "*")) + glob.glob(os.path.join(seed, "assertions", "*")):
        os.chmod(p, 0o644)
    sh("snap", "debug", "validate-seed", seed_yaml)
    print("seed snaps:", " ".join(sorted(present)))

    # Record what this build added to the stock seed (cumulative, so a rerun on
    # an already-seeded tree keeps the earlier names). app-uninstall's
    # classify.py reads it: a stock seed snap is part of Ubuntu and protected,
    # a snap the image added is a normal app the user may uninstall.
    rec = os.path.join(root, "var/lib/preload/seed-added-snaps")
    names = set(added)
    if os.path.exists(rec):
        names |= {ln.strip() for ln in open(rec, encoding="utf-8") if ln.strip()}
    os.makedirs(os.path.dirname(rec), mode=0o755, exist_ok=True)
    with open(rec, "w", encoding="utf-8") as f:
        f.write("".join(n + "\n" for n in sorted(names)))
    os.chmod(rec, 0o644)
    print("added to the seed:", " ".join(sorted(names)) or "nothing")


if __name__ == "__main__":
    main(*sys.argv[1:4])
