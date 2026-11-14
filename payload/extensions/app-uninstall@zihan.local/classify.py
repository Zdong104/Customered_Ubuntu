#!/usr/bin/python3 -I
"""Classify every desktop app for app-uninstall@zihan.local.

Runs as the user, read-only, outside the shell (the extension starts it with
Gio.Subprocess, so the shell main loop never parses dpkg data itself).

Output (default, --json): one JSON object on stdout
  {
    "version": 1,
    "protectedDebs": {pkg: reason},      # the stock-minimal deb set
    "protectedSnaps": {snap: reason},    # seeded + base/runtime snaps
    "apps": {desktop_id: {...}},         # see classify_entry()
  }
--table prints a human table of the visible apps instead (the unit test).

How "protected" is derived (data, not a hand list):
  debs   closure over the INSTALLED package database (/var/lib/dpkg/status) of
         Depends + Pre-Depends + Recommends (apt installs Recommends, so the
         stock install does too), starting from the Ubuntu seed metapackages
         ubuntu-minimal, ubuntu-standard, ubuntu-desktop-minimal and every
         Essential: yes / Priority: required|important package. Alternatives
         "a | b" follow apt: the first alternative installed by name wins; a
         virtual name only counts through a provider already in the set, so a
         browser the user added (Provides: www-browser) is not swept in.
  snaps  the installer seed (/var/lib/snapd/seed/seed.yaml) plus every snap
         whose type is not "app" (base, snapd, os, kernel, gadget). Snaps that
         a derived image added to the stock seed are listed one per line in
         /var/lib/preload/seed-added-snaps (written by the image build) and do
         not count as seeded; they stay protected if another rule applies.
  backstop  protected-apps.txt next to this file and
         $XDG_CONFIG_HOME/app-uninstall/protected-apps.txt (one desktop id,
         deb:<pkg> or snap:<name> per line, '#' comments). Additive only:
         nothing can un-protect an app.
The installer logs under /var/log/installer are root-only on Ubuntu 26.04,
so they cannot be used from the user session.
"""

import json
import os
import re
import socket
import subprocess
import sys

HOME = os.path.expanduser('~')
HERE = os.path.dirname(os.path.abspath(__file__))

SEED_METAPACKAGES = ['ubuntu-minimal', 'ubuntu-standard', 'ubuntu-desktop-minimal']
DESKTOP_ENVS = [d for d in os.environ.get('XDG_CURRENT_DESKTOP', 'ubuntu:GNOME').split(':') if d]

# Packages that must never leave through this extension, whatever the seed
# data says (also used by the shell-side removal gate).
CRITICAL_RE = re.compile(
    r'^(ubuntu-desktop.*|ubuntu-minimal|ubuntu-standard|gnome-shell.*|mutter.*|gdm3|'
    r'snapd|packagekit.*|policykit-1|polkitd|pkexec|systemd.*|apt|dpkg|libc6|'
    r'linux-(image|modules|headers|generic|signed|firmware|restricted).*|'
    r'nvidia-(driver|kernel|dkms|compute|utils|firmware).*|libnvidia-.*|'
    r'xserver-xorg.*|xwayland|network-manager.*|pipewire.*|wireplumber.*|'
    r'pulseaudio.*|plymouth.*|grub.*|shim.*|sudo|bash|coreutils|python3)$')


# ---------------------------------------------------------------- dpkg -----

def parse_dpkg_status(path='/var/lib/dpkg/status'):
    pkgs = {}
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            data = f.read()
    except OSError:
        return pkgs
    for para in data.split('\n\n'):
        fields = {}
        key = None
        for line in para.split('\n'):
            if not line:
                continue
            if line[0] in ' \t':
                if key in ('Depends', 'Pre-Depends', 'Recommends', 'Provides'):
                    fields[key] += ' ' + line.strip()
                continue
            key, _, val = line.partition(':')
            fields[key] = val.strip()
        name = fields.get('Package')
        if not name or not fields.get('Status', '').endswith(' installed'):
            continue
        p = pkgs.setdefault(name, {'deps': [], 'recs': [], 'provides': set(),
                                   'priority': '', 'essential': False})
        p['deps'] += parse_rel(fields.get('Pre-Depends', '')) + parse_rel(fields.get('Depends', ''))
        p['recs'] += parse_rel(fields.get('Recommends', ''))
        p['provides'] |= {alt[0] for grp in parse_rel(fields.get('Provides', '')) for alt in grp}
        p['priority'] = fields.get('Priority', p['priority'])
        p['essential'] = p['essential'] or fields.get('Essential') == 'yes'
    return pkgs


def parse_rel(text):
    """'a (>= 1) | b:any, c' -> [[a, b], [c]] (names only)."""
    out = []
    for grp in text.split(','):
        alts = []
        for alt in grp.split('|'):
            alt = alt.strip()
            if not alt:
                continue
            name = re.split(r'[\s(\[<]', alt, maxsplit=1)[0].split(':')[0]
            if name:
                alts.append(name)
        if alts:
            out.append(alts)
    return out


def protected_debs(pkgs):
    providers = {}
    for name, p in pkgs.items():
        for v in p['provides']:
            providers.setdefault(v, []).append(name)

    reason = {}
    queue = []

    def add(name, why):
        if name in pkgs and name not in reason:
            reason[name] = why
            queue.append(name)

    for name in SEED_METAPACKAGES:
        add(name, 'Ubuntu seed metapackage')
    for name, p in sorted(pkgs.items()):
        if p['essential']:
            add(name, 'Essential: yes')
        elif p['priority'] in ('required', 'important'):
            add(name, f'Priority: {p["priority"]}')

    while queue:
        cur = queue.pop(0)
        p = pkgs[cur]
        for kind, groups in (('Depends', p['deps']), ('Recommends', p['recs'])):
            for alts in groups:
                pick = next((a for a in alts if a in pkgs), None)
                if pick is None:
                    # virtual alternatives: only through a provider already
                    # protected, else the first provider of the first virtual
                    # name for Depends (apt must have picked one of them).
                    provs = [pv for a in alts for pv in providers.get(a, [])]
                    pick = next((pv for pv in provs if pv in reason), None)
                    if pick is None and kind == 'Depends' and provs:
                        pick = sorted(provs)[0]
                if pick:
                    add(pick, f'{cur} {kind}')
    return reason


def reason_chain(reasons, pkg, limit=6):
    chain = [pkg]
    cur = pkg
    for _ in range(limit):
        why = reasons.get(cur, '')
        parent = why.split(' ')[0]
        if not why.endswith(('Depends', 'Recommends')) or parent in chain:
            chain.append(f'({why})')
            break
        chain.append(parent)
        cur = parent
    else:
        chain.append('…')
    return ' <- '.join(chain)


def dpkg_owners(paths):
    owners = {}
    if not paths:
        return owners
    try:
        res = subprocess.run(['dpkg-query', '-S', *paths], capture_output=True,
                             text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return owners
    for line in res.stdout.splitlines():
        if line.startswith(('diversion by', 'local diversion')):
            continue
        pk, sep, path = line.partition(': ')
        if sep:
            owners[path.strip()] = [x.strip().split(':')[0] for x in pk.split(',')]
    return owners


# ---------------------------------------------------------------- snaps ----

def snapd_get(path):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect('/run/snapd.socket')
        s.sendall(f'GET {path} HTTP/1.0\r\nHost: localhost\r\n\r\n'.encode())
        buf = b''
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        body = buf.split(b'\r\n\r\n', 1)[1]
        return json.loads(body)['result']
    except Exception:
        return None


def seed_snaps(path='/var/lib/snapd/seed/seed.yaml'):
    names = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = re.match(r'\s*-?\s*name:\s*([A-Za-z0-9._-]+)', line)
                if m:
                    names.append(m.group(1))
    except OSError:
        pass
    return names


def image_added_snaps(path='/var/lib/preload/seed-added-snaps'):
    """Snaps the preload image build added to the stock installer seed."""
    try:
        with open(path, encoding='utf-8') as f:
            return {ln.strip() for ln in f
                    if ln.strip() and not ln.lstrip().startswith('#')}
    except OSError:
        return set()


def protected_snaps():
    reason = {}
    added = image_added_snaps()
    for n in seed_snaps():
        if n not in added:
            reason[n] = 'seeded by the Ubuntu installer (seed.yaml)'
    snaps = snapd_get('/v2/snaps') or []
    for s in snaps:
        if s.get('type', 'app') != 'app':
            reason.setdefault(s['name'], f'snap type {s["type"]}')
    return reason, {s['name']: s for s in snaps}


# ---------------------------------------------------------- desktop files --

def data_dirs():
    home = os.environ.get('XDG_DATA_HOME') or os.path.join(HOME, '.local/share')
    dirs = os.environ.get('XDG_DATA_DIRS') or '/usr/local/share:/usr/share:/var/lib/snapd/desktop'
    seen, out = set(), []
    for d in [home] + dirs.split(':'):
        d = os.path.normpath(d) if d else ''
        if d and d not in seen:
            seen.add(d)
            out.append(d)
    return home, out


def read_entry(path):
    entry, group = {}, None
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.rstrip('\n')
                if line.startswith('['):
                    group = line.strip()
                    continue
                if group != '[Desktop Entry]' or '=' not in line or line.startswith('#'):
                    continue
                k, _, v = line.partition('=')
                entry[k.strip()] = v.strip()
    except OSError:
        return None
    return entry


def which(prog):
    if not prog:
        return None
    if os.path.isabs(prog):
        return prog if os.access(prog, os.X_OK) else None
    for d in os.environ.get('PATH', '/usr/bin:/bin').split(':'):
        c = os.path.join(d, prog)
        if os.access(c, os.X_OK) and not os.path.isdir(c):
            return c
    return None


def exec_argv(entry):
    import shlex
    try:
        return shlex.split(entry.get('Exec', ''))
    except ValueError:
        return entry.get('Exec', '').split()


def visible(entry):
    if entry.get('Type') != 'Application':
        return False, 'not an application'
    if entry.get('NoDisplay') == 'true':
        return False, 'NoDisplay'
    if entry.get('Hidden') == 'true':
        return False, 'Hidden'
    only = [x for x in entry.get('OnlyShowIn', '').split(';') if x]
    if only and not set(only) & set(DESKTOP_ENVS):
        return False, 'OnlyShowIn other desktop'
    nots = [x for x in entry.get('NotShowIn', '').split(';') if x]
    if set(nots) & set(DESKTOP_ENVS):
        return False, 'NotShowIn this desktop'
    if entry.get('TryExec') and not which(entry['TryExec']):
        return False, 'TryExec missing'
    argv = exec_argv(entry)
    if argv and argv[0] != 'env' and not which(argv[0]):
        return False, 'Exec missing'
    return True, ''


def scan_desktop_files():
    """[(desktop_id, path, data_dir)] in precedence order (first id wins)."""
    _home, dirs = data_dirs()
    found = []
    for d in dirs:
        base = os.path.join(d, 'applications')
        if not os.path.isdir(base):
            continue
        for root, _subdirs, files in os.walk(base, followlinks=True):
            for fn in sorted(files):
                if fn.endswith('.desktop'):
                    p = os.path.join(root, fn)
                    did = os.path.relpath(p, base).replace('/', '-')
                    found.append((did, p, d))
    return found


def load_overrides():
    prot = set()
    for p in (os.path.join(HERE, 'protected-apps.txt'),
              os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(HOME, '.config'),
                           'app-uninstall', 'protected-apps.txt')):
        try:
            with open(p, encoding='utf-8') as f:
                for line in f:
                    line = line.split('#', 1)[0].strip()
                    if line:
                        prot.add(line)
        except OSError:
            pass
    return prot


def appimage_of(entry, path):
    """An AppImage the launcher clearly owns: a user-owned *.AppImage file in $HOME."""
    argv = exec_argv(entry)
    if not argv:
        return None
    cand = argv[0]
    if argv[0] == 'env':
        rest = [a for a in argv[1:] if '=' not in a]
        cand = rest[0] if rest else ''
    if not cand.lower().endswith('.appimage'):
        return None
    cand = os.path.expanduser(cand)
    try:
        st = os.stat(cand)
    except OSError:
        return None
    real = os.path.realpath(cand)
    if not real.startswith(HOME + '/') or st.st_uid != os.getuid() or not os.path.isfile(real):
        return None
    return real


# ----------------------------------------------------------------- main ----

def classify():
    pkgs = parse_dpkg_status()
    pdebs = protected_debs(pkgs)
    psnaps, snapinfo = protected_snaps()
    overrides = load_overrides()
    home_data, _ = data_dirs()
    home_apps = os.path.join(home_data, 'applications')
    user_flatpak = os.path.join(home_data, 'flatpak', 'exports', 'share')

    files = scan_desktop_files()
    first = {}
    shadowed = {}
    for did, p, d in files:
        if did not in first:
            first[did] = (p, d)
        elif did not in shadowed:
            shadowed[did] = (p, d)

    system_paths = [p for did, (p, d) in first.items() if d != home_data] + \
                   [p for did, (p, d) in shadowed.items()]
    owners = dpkg_owners([p for p in system_paths if p.startswith(('/usr/', '/opt/', '/etc/'))])

    def by_system_file(did, p, d, entry):
        """origin of a desktop file that lives outside the user's data dir."""
        rec = {}
        snapname = entry.get('X-SnapInstanceName')
        if snapname or p.startswith('/var/lib/snapd/desktop/'):
            name = snapname or os.path.basename(p).split('_', 1)[0]
            rec.update(origin='snap', snap=name)
            if f'snap:{name}' in overrides:
                rec.update(protected=True, reason='protected-apps.txt override')
            elif name in psnaps:
                rec.update(protected=True, reason=psnaps[name])
            elif name not in snapinfo and snapinfo:
                rec.update(protected=True, reason='snap not installed (stale entry)')
            else:
                rec.update(protected=False, reason='snap installed after setup')
            return rec
        if '/flatpak/exports/' in p:
            inst = 'user' if p.startswith(user_flatpak) else 'system'
            ref = entry.get('X-Flatpak') or did[:-len('.desktop')]
            rec.update(origin='flatpak', flatpak=ref, installation=inst,
                       protected=False, reason=f'flatpak ({inst} installation)')
            return rec
        own = owners.get(p)
        if own:
            pkg = own[0]
            rec.update(origin='deb', pkg=pkg)
            if f'deb:{pkg}' in overrides:
                rec.update(protected=True, reason='protected-apps.txt override')
            elif pkg in pdebs:
                rec.update(protected=True, reason=reason_chain(pdebs, pkg))
            elif CRITICAL_RE.match(pkg):
                rec.update(protected=True, reason='critical system package')
            else:
                rec.update(protected=False, reason='deb not part of the stock minimal set')
            return rec
        rec.update(origin='unmanaged', protected=True,
                   reason='not owned by any package manager (left alone)')
        return rec

    apps = {}
    for did, (p, d) in first.items():
        entry = read_entry(p)
        if entry is None:
            continue
        vis, why = visible(entry)
        rec = {'file': p, 'name': entry.get('Name', did), 'visible': vis}
        if d == home_data:
            sh = shadowed.get(did)
            if sh:
                sentry = read_entry(sh[0]) or {}
                rec.update(by_system_file(did, sh[0], sh[1], sentry))
                rec['localOverride'] = p
                rec['systemFile'] = sh[0]
            else:
                rec.update(origin='local', protected=False,
                           reason='launcher in your own app list')
                ai = appimage_of(entry, p)
                if ai:
                    rec['appimage'] = ai
                    rec['reason'] = 'AppImage launcher in your own app list'
                elif '--app-id=' in entry.get('Exec', ''):
                    rec['reason'] = 'Chrome web app shortcut'
                elif entry.get('Exec', '').startswith('env WINEPREFIX') or '/wine/' in p:
                    rec['reason'] = 'Wine program shortcut'
                elif 'steam://' in entry.get('Exec', ''):
                    rec['reason'] = 'Steam game shortcut'
        else:
            rec.update(by_system_file(did, p, d, entry))
            # A system-wide launcher override (preload's reapply.sh writes some to
            # /usr/local/share/applications, e.g. Chrome and WeChat) shadows the
            # package's own entry: the app is still that package's. reapply.sh
            # drops the override once the package's entry is gone.
            sh = shadowed.get(did)
            if rec['origin'] == 'unmanaged' and sh and sh[1] != home_data:
                srec = by_system_file(did, sh[0], sh[1], read_entry(sh[0]) or {})
                if srec['origin'] != 'unmanaged':
                    rec.update(srec)
                    rec['systemFile'] = sh[0]
        if did in overrides:
            rec.update(protected=True, reason='protected-apps.txt override')
        if not vis:
            rec.update(hiddenReason=why)
        # The shell decides what is shown; only hidden/system entries are
        # excluded here (an Exec check that disagrees with GIO must not hide
        # the menu item of an app the grid does show).
        system_entry = not vis and why in ('NoDisplay', 'Hidden', 'not an application')
        if system_entry and not rec['protected']:
            rec.update(protected=True, reason=f'{why} system entry')
        rec['action'] = ('none' if rec['protected'] else
                         'remove-entry' if rec['origin'] == 'local' else 'uninstall')
        apps[did] = rec

    return {
        'version': 1,
        'protectedDebs': pdebs,
        'protectedSnaps': psnaps,
        'criticalRe': CRITICAL_RE.pattern,
        'apps': apps,
    }


def print_table(res, show_all=False):
    rows = []
    for did, r in sorted(res['apps'].items(), key=lambda kv: kv[1]['name'].lower()):
        if not r['visible'] and not show_all:
            continue
        what = r.get('pkg') or r.get('snap') or r.get('flatpak') or r.get('appimage') or '-'
        if r.get('localOverride'):
            what += ' (+local override)'
        rows.append((r['name'][:30], did[:44], r['origin'], what[:34],
                     'PROTECTED' if r['protected'] else r['action'], r['reason'][:90]))
    w = [max(len(x[i]) for x in rows + [('name', 'desktop id', 'origin', 'package/snap', 'status', 'reason')]) for i in range(5)]
    hdr = ('name', 'desktop id', 'origin', 'package/snap', 'status', 'reason')
    for row in [hdr] + rows:
        print('  '.join(row[i].ljust(w[i]) for i in range(5)) + '  ' + row[5])
    counts = {}
    for r in res['apps'].values():
        if r['visible'] or show_all:
            k = (r['origin'], 'protected' if r['protected'] else r['action'])
            counts[k] = counts.get(k, 0) + 1
    print()
    print(f'{len(rows)} apps; protected debs in stock set: {len(res["protectedDebs"])}; '
          f'protected snaps: {len(res["protectedSnaps"])}')
    for k in sorted(counts):
        print(f'  {k[0]:10s} {k[1]:13s} {counts[k]}')


if __name__ == '__main__':
    result = classify()
    if '--table' in sys.argv:
        print_table(result, show_all='--all' in sys.argv)
    else:
        json.dump(result, sys.stdout, separators=(',', ':'))
