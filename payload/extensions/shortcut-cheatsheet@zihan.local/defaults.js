/**
 * Default contents of ~/.config/shortcut-cheatsheet/shortcuts.json.
 * Written once, on the first show, when the file does not exist yet; after
 * that the user's file is the only source (re-read on every show).
 *
 * Every binding below is one that stock Ubuntu 26.04 or this package sets up
 * (not GNOME's generic list): e.g. Super+Left/Right/Up/Down come from
 * tiling-assistant, Super+Alt+Left/Right from workspace-islands, the
 * graphical session runs on VT2 (so Ctrl+Alt+F2 returns to it), and the
 * package enables SysRq (kernel.sysrq=240).
 */

export const HELP =
    'keys: "+" joins keys pressed together, " then " is a sequence, ' +
    '" / " separates alternatives ("Super+← / →" shows Super+← / →), spaces ' +
    'inside one step without "+" (e.g. "R E I S U B") are keys typed one after another. desc = the text, zh = an optional ' +
    'second line. hold_ms = how long Super must be held (default 800). ' +
    'columns = 0 for automatic. Saved changes apply the next time the sheet ' +
    'opens; no relogin needed.';

export const DEFAULTS = {
    _help: HELP,
    hold_ms: 800,
    columns: 0,
    sections: [
        {
            title: 'When the system freezes',
            items: [
                {keys: 'Alt+PrtSc+F', desc: 'Kill the biggest-memory process (SysRq OOM kill)'},
                {keys: 'Ctrl+Alt+F3', desc: 'Text console: log in, then top / kill the culprit'},
                {keys: 'Ctrl+Alt+F2', desc: 'Back to the desktop (session is on VT2)'},
                {keys: 'Alt+PrtSc then REISUB', desc: 'Last resort: safe reboot (hold Alt+PrtSc, type R E I S U B ~1 s apart)'},
                {keys: 'Super+Esc', desc: 'Take shortcuts back from an app that grabbed them (VM, remote desktop)'},
            ],
        },
        {
            title: 'Added by this setup',
            items: [
                {keys: 'Super+.', desc: 'Emoji picker (also Ctrl+Super+Space)'},
                {keys: 'Super+Alt+← / →', desc: 'Previous / next workspace on this monitor'},
                {keys: 'Super+Alt+1…4', desc: 'Jump to workspace N on this monitor'},
                {keys: 'Hold Super', desc: 'This cheatsheet'},
                {keys: 'Super then type', desc: 'Quick Answers in the search: 36F, $100, 3pm PST, weather, define word (Enter copies)'},
            ],
        },
        {
            title: 'Windows',
            items: [
                {keys: 'Super+← / →', desc: 'Tile window to the left / right half'},
                {keys: 'Super+↑ / ↓', desc: 'Maximize / restore window'},
                {keys: 'Super+Shift+← / →', desc: 'Move window to the other monitor'},
                {keys: 'Super+`', desc: 'Switch between windows of the same app'},
                {keys: 'Alt+F7 / F8', desc: 'Move / resize with the keyboard (window off-screen)'},
                {keys: 'Alt+Space', desc: 'Window menu (always on top, move to workspace…)'},
                {keys: 'Super+H / D', desc: 'Minimize window / show desktop'},
            ],
        },
        {
            title: 'Workspaces & apps',
            items: [
                {keys: 'Super+PgUp / PgDn', desc: 'Previous / next workspace'},
                {keys: 'Super+Shift+PgUp / PgDn', desc: 'Move window to previous / next workspace'},
                {keys: 'Super+1…9', desc: 'Open / switch to dock app N (add Ctrl: new window)'},
                {keys: 'Super+A', desc: 'App grid'},
            ],
        },
        {
            title: 'System',
            items: [
                {keys: 'Print', desc: 'Screenshot UI (Shift: full screen, Alt: window)'},
                {keys: 'Ctrl+Shift+Alt+R', desc: 'Record the screen'},
                {keys: 'Super+V / N', desc: 'Notifications & calendar / focus newest notification'},
                {keys: 'Super+S', desc: 'Quick settings'},
                {keys: 'Super+P', desc: 'Switch display layout (after docking)'},
                {keys: 'Super+L', desc: 'Lock screen'},
            ],
        },
    ],
};
