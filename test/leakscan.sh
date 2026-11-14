#!/bin/bash
# Scan a preload artifact for personal data / identity / secrets.
#
#   sudo test/leakscan.sh work/out/minimal.standard.preload.squashfs
#   sudo test/leakscan.sh out/preload-26.04.1-YYYYMMDD.iso
#   sudo test/leakscan.sh /some/mounted/root
#   test/leakscan.sh --repo [REV]   tracked files of the git repo (default HEAD)
#   test/leakscan.sh --history      every commit, plus commit/tag identities
#
# The owner's identity strings (names, hostname, e-mail, machine-specific
# paths) are NOT in this public file. They are read from a private patterns
# file: $PRELOAD_LEAK_PATTERNS, or ~/.config/preload/leak-patterns.sh of the
# invoking (sudo) user; test/leak-patterns.example.sh lists its variables.
# Without it the scan refuses to run, so nothing is ever "clean" just because
# the patterns were missing.
#
# For an ISO it scans every file outside /casper, plus the preload layer (the
# stock Canonical layers are not ours and are skipped). Exit status is
# non-zero when a FAIL finding exists. "EXPECTED" lines are known, accepted
# matches (e.g. the custom extension UUIDs, kept by decision).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${1:?usage: leakscan.sh <squashfs|iso|dir|--repo [REV]|--history>}
FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }
note() { echo "EXPECTED: $*"; }

# --- patterns ----------------------------------------------------------------
# Generic secrets. The bracketed letters keep this file from matching itself.
SECRET='BEGIN (OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY|ps[k]=|x-access-toke[n]|gh[pousr]_[A-Za-z0-9]{30}|github_pa[t]_[A-Za-z0-9_]{20}|sk-ant-[A-Za-z0-9_-]{20}|s[k]-[A-Za-z0-9]{40}|AKI[A][0-9A-Z]{16}|xox[bpa]-[A-Za-z0-9-]{10}'
# Generic per-machine / personal paths for image scans.
BAD_PATHS=(root/.ssh root/.bash_history root/snap root/Desktop etc/xdg/mimeapps.list
    etc/cloud/cloud.cfg.d/99-installer.cfg var/log/installer swap.img
    var/lib/docker/image var/lib/docker/containers var/snap/lxd/common/lxd/storage-pools)
SECRET_NAMES=(.bash_history .python_history .git-credentials .gitconfig .netrc .npmrc
    .condarc-token auth.json recently-used.xbel .zsh_history .wget-hsts)
# E-mail-shaped strings that are not addresses: extension UUIDs, systemd template
# units (org.gnome.Shell@wayland.service), JS stack frames (fn@file, @resource)
# and GVariant format strings ("(&s@ay)").
EMAIL_OK_RE='@([a-z0-9-]+\.local|[A-Za-z0-9.-]*\.?invalid|rastersoft\.com|corgijan\.dev|canonical\.com|ubuntu\.com|cua|[A-Za-z0-9-]+\.github\.io|users\.noreply\.github\.com|(ubuntu|wayland|x11)\.service|ay|resource|file)$'
# Public-key material is allowed only where it belongs.
PUBKEY_OK_FILES='^(updater/allowed_signers|bootstrap\.sh)$'
PGP_OK_FILES='^payload/keys/'

# Private part: IDENT, EXPECTED_TOKEN_RE, EXPECTED_VIEW_PATHS, VIEW_STRICT_RE,
# PRIVATE_BAD_PATHS, PRIVATE_FIND_NAMES, PRIVATE_SECRET.
home=$(getent passwd "${SUDO_USER:-$(id -un)}" | cut -d: -f6)
PATTERNS=${PRELOAD_LEAK_PATTERNS:-$home/.config/preload/leak-patterns.sh}
if [ ! -r "$PATTERNS" ]; then
    echo "FAIL: private identity patterns not found ($PATTERNS); refusing to scan" >&2
    echo "      copy test/leak-patterns.example.sh there and fill it in" >&2
    exit 3
fi
PRIVATE_BAD_PATHS=() PRIVATE_FIND_NAMES=() PRIVATE_SECRET='' VIEW_STRICT_RE='/home/'
EXPECTED_VIEW_PATHS='^$'
# shellcheck source=leak-patterns.example.sh
. "$PATTERNS"
: "${IDENT:?IDENT not set in $PATTERNS}" "${EXPECTED_TOKEN_RE:?EXPECTED_TOKEN_RE not set}"
[ -n "$PRIVATE_SECRET" ] && SECRET="$SECRET|$PRIVATE_SECRET"

# Whole-word identity hits left in a token list once accepted tokens are removed.
unexpected_tokens() { sed -E "s#$EXPECTED_TOKEN_RE##g" | grep -iwE "$IDENT"; }

# --- repository mode -----------------------------------------------------------
scan_rev() { # rev [label]
    local rev=$1 label=${2:-$1} line path tok rest n x
    echo "== scanning git $label"
    # 1. identity strings in any tracked file (binary included)
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        line=${line#"$rev":}; path=${line%%:*}; tok=${line#*:}
        rest=$(printf '%s\n' "$tok" | unexpected_tokens)
        if [ -n "$rest" ]; then fail "identity string in $path: $tok"; fi
    done < <(git -C "$ROOT" grep -a -i -o -E "[A-Za-z0-9._@/-]*($IDENT)[A-Za-z0-9._@/-]*" "$rev" -- . 2>/dev/null | sort -u)
    # 2. home-directory paths
    while IFS= read -r line; do
        [ -n "$line" ] && fail "home path: ${line#"$rev":}"
    done < <(git -C "$ROOT" grep -I -n -o -E '/home/[A-Za-z0-9_][A-Za-z0-9_.-]*' "$rev" -- . 2>/dev/null)
    # 3. secrets
    while IFS= read -r line; do
        [ -n "$line" ] && fail "secret-looking content: $(cut -c1-160 <<< "${line#"$rev":}")"
    done < <(git -C "$ROOT" grep -I -n -E "$SECRET" "$rev" -- . 2>/dev/null)
    # 4. key material outside its allowed files
    while IFS= read -r path; do
        path=${path#"$rev":}
        [[ $path =~ $PUBKEY_OK_FILES ]] || fail "SSH public key outside updater/allowed_signers, bootstrap.sh: $path"
    done < <(git -C "$ROOT" grep -I -l -E 'ssh-(ed25519|rsa|dss|ecdsa-[a-z0-9-]+) AAAA' "$rev" -- . 2>/dev/null)
    while IFS= read -r path; do
        path=${path#"$rev":}
        [[ $path =~ $PGP_OK_FILES ]] || fail "PGP key block outside payload/keys: $path"
    done < <(git -C "$ROOT" grep -I -l -E '-----BEGIN PGP (PUBLIC|PRIVATE)' "$rev" -- . 2>/dev/null)
    # 5. e-mail addresses
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        tok=${line##*:}
        [[ $tok =~ $EMAIL_OK_RE ]] || fail "e-mail address: ${line#"$rev":}"
    done < <(git -C "$ROOT" grep -I -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*' "$rev" -- . 2>/dev/null | sort -u)
    # 6. file names
    while IFS= read -r path; do
        n=$(basename "$path")
        case "$n" in
            id_rsa|id_ed25519|id_ecdsa|*.pem|*.p12|*.key|preload-release|.env) fail "key/secret-like file name: $path" ;;
        esac
        for x in "${SECRET_NAMES[@]}"; do [ "$n" = "$x" ] && fail "history/credential file: $path"; done
        for x in "${PRIVATE_FIND_NAMES[@]}"; do
            # shellcheck disable=SC2053  # glob match on purpose
            [[ $n == $x ]] && fail "forbidden file name: $path"
        done
    done < <(git -C "$ROOT" ls-tree -r --name-only "$rev")
}

if [ "$TARGET" = --repo ]; then
    scan_rev "$(git -C "$ROOT" rev-parse --verify "${2:-HEAD}^{commit}")" "${2:-HEAD}"
elif [ "$TARGET" = --history ]; then
    out=$(for c in $(git -C "$ROOT" rev-list --all); do
              scan_rev "$c" "$(git -C "$ROOT" log -1 --format='%h %s' "$c")"
          done)
    printf '%s\n' "$out" | awk '!/^FAIL/ || !seen[$0]++'     # each distinct finding once
    grep -q '^FAIL' <<< "$out" && FAIL=1
    echo "== identities recorded in commits and tags (public with the history)"
    while IFS= read -r who; do
        [ -n "${who// /}" ] || continue
        grep -q 'users\.noreply\.github\.com>' <<< "$who" ||
            fail "commit/tag identity carries a real e-mail address: $who"
    done < <( { git -C "$ROOT" log --all --format='%an <%ae>%n%cn <%ce>'
                git -C "$ROOT" for-each-ref refs/tags --format='%(taggername) %(taggeremail)'; } | sort -u)
fi
if [ "$TARGET" = --repo ] || [ "$TARGET" = --history ]; then
    if [ $FAIL = 0 ]; then echo "RESULT: CLEAN"; else echo "RESULT: FINDINGS (see FAIL lines)"; fi
    exit $FAIL
fi

# --- image / ISO / directory mode ---------------------------------------------------
. "$ROOT/build/lib.sh"
run_capped_self "$@"     # the scan reads tens of GB; keep it in a capped scope
TMP=$(mktemp -d /var/tmp/leakscan.XXXXXX)
MNTS=()
cleanup() { for m in "${MNTS[@]}"; do umount "$m" 2>/dev/null; done; rm -rf "$TMP"; }
trap cleanup EXIT

mount_ro() { # src dst [opts]
    mkdir -p "$2"; mount -o "ro,${3:-loop}" "$1" "$2" && MNTS=("$2" "${MNTS[@]}")
}

scan_root() { # dir label
    local R=$1 label=$2 p x g f n
    echo "== scanning $label ($R)"
    # 1. forbidden paths
    for p in "${BAD_PATHS[@]}" "${PRIVATE_BAD_PATHS[@]}"; do
        [ -e "$R/$p" ] || [ -L "$R/$p" ] || continue
        # overlayfs whiteouts (char 0:0) mean "deleted" - fine
        if [ -c "$R/$p" ]; then continue; fi
        fail "forbidden path present: /$p"
    done
    # Explicit assertions (each prints PASS or FAIL so the report shows they ran)
    assert_none() { # description, find-results
        if [ -n "$2" ]; then fail "$1: $(echo $2 | cut -c1-300)"; else echo "PASS: $1"; fi
    }
    for x in "${PRIVATE_FIND_NAMES[@]}"; do
        assert_none "no $x file anywhere" \
            "$(find "$R" -xdev -iname "$x" ! -type c 2>/dev/null | sed "s#^$R##")"
    done
    assert_none "nothing under /home" \
        "$(find "$R/home" -mindepth 1 ! -type c 2>/dev/null | sed "s#^$R##" | head -20)"
    assert_none "no Trash directories" \
        "$(find "$R" -xdev \( -iname 'Trash' -o -iname '.Trash' -o -iname '.Trash-*' \) ! -type c 2>/dev/null | sed "s#^$R##" | grep -vE '^/usr/(share|lib)/' | head -20)"
    for g in 'etc/ssh/ssh_host_*' 'etc/netplan/90-NM-*' 'etc/NetworkManager/system-connections/*' \
             'etc/apt/auth.conf.d/*' 'var/lib/fprint/*' 'var/lib/AccountsService/users/*' \
             'var/lib/AccountsService/icons/*' 'etc/cups/printers.conf' 'etc/libvirt/qemu/*.xml' \
             'var/lib/libvirt/images/*' 'var/lib/bluetooth/*'; do
        for f in $R/$g; do
            [ -e "$f" ] && [ ! -c "$f" ] && fail "per-machine/personal file: ${f#$R}"
        done
    done
    for n in "${SECRET_NAMES[@]}"; do
        while IFS= read -r f; do
            [ -c "$f" ] && continue
            case "$f" in */opt/miniconda3/*/site-packages/*|*/usr/lib/*) continue ;; esac
            fail "history/credential file: ${f#$R}"
        done < <(find "$R" -xdev -name "$n" \( -type f -o -type l \) 2>/dev/null)
    done
    if [ -s "$R/etc/machine-id" ]; then fail "/etc/machine-id is not empty"; fi
    if [ -f "$R/etc/passwd" ] && awk -F: '$3>=1000 && $3<60000' "$R/etc/passwd" | grep -q .; then
        fail "human accounts in /etc/passwd: $(awk -F: '$3>=1000 && $3<60000{print $1}' "$R/etc/passwd" | tr '\n' ' ')"
    fi
    if [ -d "$R/var/log" ]; then
        local nonempty
        nonempty=$(find "$R/var/log" -type f -size +0 2>/dev/null | grep -v '/var/log/installer/' | head -5)
        [ -n "$nonempty" ] && fail "non-empty logs: $(echo $nonempty)"
    fi
    if [ -d "$R/etc/sudoers.d" ]; then
        for f in "$R"/etc/sudoers.d/*; do
            [ -e "$f" ] && [ ! -c "$f" ] || continue
            case "$(basename "$f")" in README) ;; *) fail "unexpected sudoers drop-in: ${f#$R}" ;; esac
        done
    fi
    # 2. identity strings (text and binary), whole-word, case-insensitive
    local hits rel tokens rest
    hits=$(grep -rlaiwE -D skip "$IDENT" "$R" 2>/dev/null)
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        rel=${f#$R}
        tokens=$(grep -aoiwE "[A-Za-z0-9._@/-]*($IDENT)[A-Za-z0-9._@/-]*" "$f" | sort -u)
        rest=$(printf '%s\n' "$tokens" | unexpected_tokens)
        if [ -z "$rest" ]; then
            note "accepted identifiers only in $rel: $(printf '%s ' $tokens | cut -c1-160)"
        elif [[ $rel =~ $EXPECTED_VIEW_PATHS ]] && ! printf '%s\n' "$rest" | grep -qiE "$VIEW_STRICT_RE"; then
            note "view snap store metadata in $rel: $(printf '%s ' $rest | cut -c1-160)"
        else
            fail "identity string in $rel: $(printf '%s ' $rest | cut -c1-200)"
        fi
    done <<< "$hits"
    # 3. secrets (text files outside vendor trees whose test fixtures ship sample keys)
    hits=$(grep -rIlE -D skip "$SECRET" "$R" 2>/dev/null |
        grep -vE '/usr/(lib|share|src)/|/opt/(miniconda3|TinyTeX|vocalinux/venv|uv|google|zoom|wechat|ChatGPT|Claude)|/usr/local/lib/node_modules/' )
    while IFS= read -r f; do [ -n "$f" ] && fail "secret-looking content in ${f#$R}"; done <<< "$hits"
}

case "$TARGET" in
    *.squashfs)
        mount_ro "$TARGET" "$TMP/layer"
        scan_root "$TMP/layer" "layer $(basename "$TARGET")" ;;
    *.iso)
        mount_ro "$TARGET" "$TMP/iso"
        echo "== scanning ISO files outside /casper"
        # copy the small non-casper text tree out and scan it as a root
        mkdir -p "$TMP/isofiles"
        (cd "$TMP/iso" && find . -path ./casper -prune -o -path ./pool -prune -o -type f -print0 |
            xargs -0 -I{} cp --parents {} "$TMP/isofiles/")
        hits=$(grep -rIliwE "$IDENT" "$TMP/isofiles" 2>/dev/null)
        while IFS= read -r f; do [ -n "$f" ] && fail "identity string in ISO file ${f#$TMP/isofiles}"; done <<< "$hits"
        hits=$(grep -rIlE "$SECRET" "$TMP/isofiles" 2>/dev/null)
        while IFS= read -r f; do [ -n "$f" ] && fail "secret-looking content in ISO file ${f#$TMP/isofiles}"; done <<< "$hits"
        # pool .debs: names only
        ls "$TMP/iso/preload/pool" 2>/dev/null | grep -vE '\.deb$|^Packages' && fail "unexpected files in /preload/pool"
        for l in "$TMP/iso/casper/"*.squashfs; do
            case "$(basename "$l")" in
                minimal.squashfs|minimal.standard.squashfs|minimal.standard.live.squashfs)
                    echo "skip stock layer $(basename "$l")" ;;
                *) mount_ro "$l" "$TMP/l-$(basename "$l")"
                   scan_root "$TMP/l-$(basename "$l")" "ISO layer $(basename "$l")" ;;
            esac
        done ;;
    *)
        [ -d "$TARGET" ] || { echo "not found: $TARGET" >&2; exit 2; }
        scan_root "$TARGET" "$TARGET" ;;
esac

if [ $FAIL = 0 ]; then echo "RESULT: CLEAN"; else echo "RESULT: FINDINGS (see FAIL lines)"; fi
exit $FAIL
