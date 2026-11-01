#!/bin/bash
# Owner side: tag a signed release that every installed machine will apply.
#
#   ./release.sh [-m "what changed"]
#
# Refuses a dirty tree, checks that bootstrap.sh and updater/ agree on the
# repository URL and signing key, runs the leak scan over every tracked file
# (needs the private ~/.config/preload/leak-patterns.sh), picks the next
# version vYYYY.MM.DD[.N], creates an SSH-signed annotated tag with the
# dedicated release key, verifies it the way clients will, and prints - but
# does not run - the push command. Nothing reaches anyone until you push.
#
#   PRELOAD_RELEASE_KEY   signing key (default ~/.ssh/preload-release)
#   PRELOAD_TAGGER        "Name <email>" recorded publicly in the tag (or git config
#                         preload.tagger); default is a non-personal placeholder
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
KEY=${PRELOAD_RELEASE_KEY:-$HOME/.ssh/preload-release}
TAGGER=${PRELOAD_TAGGER:-$(git config preload.tagger || echo "preload-release <release@customered-ubuntu.invalid>")}
TAG_RE='^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]{1,3})?$'
die() { echo "release: $*" >&2; exit 1; }

msg=""
while [ $# -gt 0 ]; do
    case $1 in
        -m) msg=${2:?-m needs text}; shift 2 ;;
        *) die "usage: release.sh [-m message]" ;;
    esac
done

# 1. clean tree, on a commit
[ -z "$(git status --porcelain --untracked-files=all)" ] || die "working tree is not clean (commit or stash first)"
branch=$(git symbolic-ref --short -q HEAD || echo detached)
[ "$branch" = main ] || echo "note: releasing from '$branch', not main"

# 2. pinned values agree
url_conf=$(sed -n 's/^REPO_URL=//p' updater/preload.conf)
url_boot=$(sed -n 's/^REPO_URL=//p' bootstrap.sh | head -1)
[ -n "$url_conf" ] && [ "$url_conf" = "$url_boot" ] || die "REPO_URL differs: updater/preload.conf '$url_conf' vs bootstrap.sh '$url_boot'"
[[ $url_conf == https://* ]] || die "REPO_URL must be https://"
boot_signer=$(sed -n "s/^SIGNERS='\(.*\)'$/\1/p" bootstrap.sh)
grep -qxF "$boot_signer" updater/allowed_signers || die "bootstrap.sh SIGNERS line is not in updater/allowed_signers"

# 3. the key we sign with is one clients trust
[ -r "$KEY" ] && [ -r "$KEY.pub" ] || die "signing key $KEY(.pub) not found"
pub=$(cut -d' ' -f1,2 "$KEY.pub")
grep -v '^#' updater/allowed_signers | grep -qF "$pub" || die "$KEY.pub is not in updater/allowed_signers"

# 4. syntax + leak scan of exactly what will be published
for f in bootstrap.sh release.sh payload/provision.sh updater/preload-update updater/preload-user-sync; do
    bash -n "$f" || die "syntax error in $f"
done
if command -v shellcheck >/dev/null; then
    shellcheck -S error bootstrap.sh release.sh payload/provision.sh updater/preload-update updater/preload-user-sync ||
        die "shellcheck errors"
fi
test/leakscan.sh --repo HEAD || die "leak scan found something (see FAIL lines); nothing was tagged"

# 5. next version: today's date, .N if needed, always above every existing tag
git fetch -q --tags origin 2>/dev/null || echo "note: could not fetch tags from origin; using local tags"
v=v$(date +%Y.%m.%d)
n=1
while git rev-parse -q --verify "refs/tags/$v" >/dev/null; do n=$((n + 1)); v=v$(date +%Y.%m.%d).$n; done
latest=$(git tag -l 'v*' | grep -E "$TAG_RE" | sort -V | tail -1 || true)
if [ -n "$latest" ] && [ "$(printf '%s\n%s\n' "$latest" "$v" | sort -V | tail -1)" != "$v" ]; then
    die "next version $v would not be above the newest tag $latest (clock?)"
fi
[[ $v =~ $TAG_RE ]] || die "bad version $v"

# 6. signed annotated tag; the tagger identity is public, so not a personal address
prev=${latest:-$(git rev-list --max-parents=0 HEAD | tail -1)}
body=${msg:-Release $v}$'\n\n'$(git log --no-merges --format='- %s' "$prev..HEAD" 2>/dev/null | head -50)
name=${TAGGER% <*}; email=${TAGGER##*<}; email=${email%>}
GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email \
    git -c gpg.format=ssh -c user.signingkey="$KEY" tag -s -a "$v" -m "$body"

# 7. verify exactly as a client does
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$ROOT/updater/allowed_signers" verify-tag "$v" ||
    { git tag -d "$v" >/dev/null; die "tag did not verify; deleted it"; }

echo
echo "Tagged $v ($(git rev-parse --short "$v^{commit}")). Publish with:"
echo
echo "    git push origin HEAD:main && git push origin $v"
echo
echo "Installed machines pick it up within a day (15 min after boot at the earliest)."
