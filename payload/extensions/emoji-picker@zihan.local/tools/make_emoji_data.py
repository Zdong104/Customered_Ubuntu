#!/usr/bin/python3
"""Build emoji-data.json for emoji-picker@zihan.local from locally installed data.

Source: IBus emoji dictionaries (package ibus-data), which are generated from
Unicode emoji-test.txt (order + groups) and CLDR annotations (keywords), in
English and Chinese:  /usr/share/ibus/dicts/emoji-{en,zh}.dict
Filter: fully-qualified only (first of each FE0F-insensitive duplicate), no
"Component" group, skin-tone variants folded into their base ("t": 5 tones),
and only sequences that Noto Color Emoji renders as ONE glyph (Pango check),
so nothing shows up as tofu or as a split ZWJ sequence.

Run with the system python:  /usr/bin/python3 tools/make_emoji_data.py
"""
import json, os, sys
import gi
gi.require_version('IBus', '1.0')
gi.require_version('Pango', '1.0')
gi.require_version('PangoCairo', '1.0')
from gi.repository import IBus, Pango, PangoCairo

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'emoji-data.json')
TONES = ['\U0001F3FB', '\U0001F3FC', '\U0001F3FD', '\U0001F3FE', '\U0001F3FF']
TONE_NAMES = ['light skin tone', 'medium-light skin tone', 'medium skin tone',
              'medium-dark skin tone', 'dark skin tone']

# picker category id -> (title, icon, [Unicode groups])
CATEGORIES = [
    ('smileys', 'Smileys & People', 'emoji-people-symbolic', ['Smileys & Emotion', 'People & Body']),
    ('nature', 'Animals & Nature', 'emoji-nature-symbolic', ['Animals & Nature']),
    ('food', 'Food & Drink', 'emoji-food-symbolic', ['Food & Drink']),
    ('activity', 'Activity', 'emoji-activities-symbolic', ['Activities']),
    ('travel', 'Travel & Places', 'emoji-travel-symbolic', ['Travel & Places']),
    ('objects', 'Objects', 'emoji-objects-symbolic', ['Objects']),
    ('symbols', 'Symbols', 'emoji-symbols-symbolic', ['Symbols']),
    ('flags', 'Flags', 'emoji-flags-symbolic', ['Flags']),
]
GROUP_TO_CAT = {g: c[0] for c in CATEGORIES for g in c[3]}

fontmap = PangoCairo.FontMap.get_default()
ctx = fontmap.create_context()
fdesc = Pango.FontDescription.from_string('Noto Color Emoji 20')


def renders_as_one_glyph(s):
    layout = Pango.Layout.new(ctx)
    layout.set_font_description(fdesc)
    layout.set_text(s, -1)
    if layout.get_unknown_glyphs_count() != 0:
        return False
    it = layout.get_iter()
    glyphs = 0
    while True:
        run = it.get_run()
        if run is not None:
            glyphs += run.glyphs.num_glyphs
            fam = run.item.analysis.font.describe().get_family()
            if 'Emoji' not in fam:
                return False
        if not it.next_run():
            break
    return glyphs == 1


def key(s):
    return s.replace('️', '')


def words(seq):
    out = []
    for w in seq:
        w = w.strip().lower()
        if w and w not in out:
            out.append(w)
    return out


en = IBus.EmojiData.load('/usr/share/ibus/dicts/emoji-en.dict')
zh = {key(d.get_emoji()): d for d in IBus.EmojiData.load('/usr/share/ibus/dicts/emoji-zh.dict')}

seen = set()
items = {c[0]: [] for c in CATEGORIES}
by_name = {}
tone_variants = {}  # base name -> list of (tone index, emoji)
dropped = []
for d in en:
    e = d.get_emoji()
    cat = GROUP_TO_CAT.get(d.get_category())
    if not cat or key(e) in seen:
        continue
    seen.add(key(e))
    name = d.get_description()
    if any(t in e for t in TONES):
        # "waving hand: medium skin tone" -> base "waving hand"; only single-tone variants
        if ':' in name:
            base, _, tone = name.partition(':')
            tone = tone.strip()
            if tone in TONE_NAMES:
                tone_variants.setdefault(base.strip(), []).append((TONE_NAMES.index(tone), e))
        continue
    if not renders_as_one_glyph(e):
        dropped.append(e)
        continue
    z = zh.get(key(e))
    zw = []
    if z is not None:
        zw = words([z.get_description()] + list(z.get_annotations()))
    rec = {'e': e, 'n': name, 'k': [w for w in words(d.get_annotations()) if w != name.lower()]}
    if zw:
        rec['z'] = zw
    items[cat].append(rec)
    by_name[name] = rec

ntones = 0
for base, vs in tone_variants.items():
    rec = by_name.get(base)
    if rec is None or len(vs) != 5:
        continue
    vs.sort()
    if [i for i, _ in vs] != [0, 1, 2, 3, 4]:
        continue
    if not all(renders_as_one_glyph(v) for _, v in vs):
        continue
    rec['t'] = [v for _, v in vs]
    ntones += 1

data = {
    'source': 'ibus-data emoji-en.dict / emoji-zh.dict (Unicode emoji-test + CLDR annotations)',
    'categories': [{'id': c[0], 'title': c[1], 'icon': c[2], 'emoji': items[c[0]]} for c in CATEGORIES],
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
total = sum(len(v) for v in items.values())
print(f'{total} emoji, {ntones} with skin tones, {len(dropped)} dropped (font): {"".join(dropped[:40])}', file=sys.stderr)
for c in CATEGORIES:
    print(f'  {c[0]}: {len(items[c[0]])}', file=sys.stderr)
