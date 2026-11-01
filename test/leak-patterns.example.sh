# Template for the PRIVATE leak-scan patterns read by test/leakscan.sh.
# Copy to ~/.config/preload/leak-patterns.sh (chmod 600), fill in, and never
# commit the filled-in copy: it lists exactly what must not be published.
#
# Identity strings (case-insensitive, whole words): user names, hostnames,
# e-mail local parts, private directory names.
IDENT='yourname|yourhostname|your-email-local-part'
# Tokens that contain an identity string but are accepted by decision, e.g.
# extension UUIDs and the public repository URL.
EXPECTED_TOKEN_RE='[a-z-]+[@]yourname\.local|github\.com/YourUser/YourRepo[A-Za-z0-9._/-]*'
# Image scans: files where store metadata may carry accepted names, and the
# strings that are never accepted even there.
EXPECTED_VIEW_PATHS='^$'
VIEW_STRICT_RE='/home/'
# Extra secret regex, file-name globs and absolute paths (without leading /)
# that must never appear in an image.
PRIVATE_SECRET=''
PRIVATE_FIND_NAMES=()
PRIVATE_BAD_PATHS=(home/yourname)
