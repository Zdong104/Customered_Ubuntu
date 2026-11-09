# GNOME Files (nautilus-python) extension: adds "Send with LocalSend" to the
# right-click menu of selected files/folders. The paths are passed to the
# LocalSend binary (snap, .deb or anything named localsend/localsend_app on
# PATH); a running LocalSend (even hidden in the tray) receives them in its
# Send list and comes to the front.
# Needs python3-nautilus. Installed system-wide by Customered Ubuntu in
# /usr/share/nautilus-python/extensions; restart Files with:  nautilus -q
import os
import shutil

import gi

try:
    gi.require_version("Nautilus", "4.1")      # Files 49+
except ValueError:
    gi.require_version("Nautilus", "4.0")      # Files 43–48
from gi.repository import Gio, GLib, GObject, Nautilus  # noqa: E402

LOCALSEND = next((p for p in ("/snap/bin/localsend", shutil.which("localsend") or "",
                              shutil.which("localsend_app") or "") if p and os.access(p, os.X_OK)), None)
HOME = os.path.realpath(os.path.expanduser("~"))
# The snap's own dir is always readable by it; used to stage files it can't see.
OUTBOX = os.path.join(HOME, "snap", "localsend", "common", "outbox")


def _snap_can_read(path):
    """The snap 'home' plug covers non-hidden paths under $HOME only."""
    if not LOCALSEND or not LOCALSEND.startswith("/snap/"):
        return True
    real = os.path.realpath(path)
    if real.startswith(os.path.join(HOME, "snap", "localsend") + os.sep):
        return True
    if not real.startswith(HOME + os.sep):
        return False
    return not any(part.startswith(".") for part in os.path.relpath(real, HOME).split(os.sep))


def _prune_outbox(max_age=24 * 3600):
    """Drop staged copies older than a day (LocalSend has sent them by then)."""
    if not os.path.isdir(OUTBOX):
        return
    now = GLib.get_real_time() / 1e6
    for name in os.listdir(OUTBOX):
        p = os.path.join(OUTBOX, name)
        try:
            if now - os.lstat(p).st_ctime > max_age:
                shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else os.remove(p)
        except OSError:
            pass


def _stage(path):
    """Copy an unreadable-to-the-snap file into the outbox; returns new path."""
    os.makedirs(OUTBOX, exist_ok=True)
    dest = os.path.join(OUTBOX, os.path.basename(path.rstrip(os.sep)))
    if os.path.lexists(dest):
        shutil.rmtree(dest) if os.path.isdir(dest) and not os.path.islink(dest) else os.remove(dest)
    if os.path.isdir(path):
        shutil.copytree(path, dest, symlinks=True)
    else:
        try:
            os.link(path, dest)            # instant when on the same filesystem
        except OSError:
            shutil.copy2(path, dest)
    return dest


def _notify(title, body=""):
    if shutil.which("notify-send"):
        try:
            GLib.spawn_async(["notify-send", "-a", "LocalSend", "-i", "localsend", title, body],
                             flags=GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.STDOUT_TO_DEV_NULL
                             | GLib.SpawnFlags.STDERR_TO_DEV_NULL)
        except GLib.Error:
            pass


def _send(paths):
    _prune_outbox()
    try:
        args = [p if _snap_can_read(p) else _stage(p) for p in paths]
    except OSError as e:
        _notify("LocalSend: could not prepare files", str(e))
        return
    try:
        Gio.Subprocess.new([LOCALSEND] + args,
                           Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)
    except GLib.Error as e:
        _notify("Could not start LocalSend", e.message)


class LocalSendMenu(GObject.GObject, Nautilus.MenuProvider):
    def get_file_items(self, *args):
        files = args[-1]
        if not LOCALSEND or not files:
            return []
        paths = []
        for f in files:
            loc = f.get_location()
            path = loc.get_path() if loc else None
            if not path or not os.path.exists(path):
                return []                  # remote/virtual entries (trash, network…)
            paths.append(path)
        n = len(paths)
        item = Nautilus.MenuItem(
            name="LocalSendMenu::send",
            label="Send with LocalSend" if n == 1 else f"Send {n} Items with LocalSend",
            tip="Add to LocalSend's send list and open LocalSend")
        item.connect("activate", lambda *_: _send(paths))
        return [item]
