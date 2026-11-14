#!/usr/bin/env python3
"""Generate macOS-style fcitx5 classicui themes (mac-light / mac-dark).
Re-run after editing the constants below:
    python3 tools/make_mac_themes.py [OUTDIR]
OUTDIR defaults to the payload copy installed as /usr/share/fcitx5/themes.
Needs python3-pil."""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter

SS = 4                      # supersampling factor for smooth anti-aliased edges
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "payload", "rootfs", "usr", "share", "fcitx5", "themes")
S = 12                      # shadow room around the panel (logical px)
R = 10                      # panel corner radius
HR = 6                      # highlight (selected candidate) corner radius
BLUE = (10, 132, 255)       # macOS system blue

VARIANTS = {
    "mac-light": dict(name="macOS Light", panel=(250, 250, 250, 246),
                      edge=(0, 0, 0, 30), inner=None, shadow=70,
                      text="#1d1d1f", hltext="#ffffff", arrow=(60, 60, 67, 150)),
    "mac-dark":  dict(name="macOS Dark", panel=(40, 40, 42, 246),
                      edge=(0, 0, 0, 150), inner=(255, 255, 255, 28), shadow=110,
                      text="#f5f5f7", hltext="#ffffff", arrow=(235, 235, 245, 150)),
}

def rr(draw, box, r, **kw):
    draw.rounded_rectangle([v * SS for v in box], radius=r * SS, **kw)

def panel_png(v, path):
    core = 2 * R + 4                     # stretchable middle is tiny; corners are what matter
    W = H = 2 * S + core
    big = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    # soft drop shadow, nudged down a bit like macOS
    sh = Image.new("RGBA", big.size, (0, 0, 0, 0))
    rr(ImageDraw.Draw(sh), (S, S + 2, W - S, H - S + 2), R, fill=(0, 0, 0, v["shadow"]))
    sh = sh.filter(ImageFilter.GaussianBlur(5 * SS))
    big = Image.alpha_composite(big, sh)
    # hairline outer edge, then the fill inset by 1px
    layer = Image.new("RGBA", big.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rr(d, (S, S, W - S, H - S), R, fill=v["edge"])
    big = Image.alpha_composite(big, layer)
    # punch the fill area (replace, not blend, so the edge stays a thin line)
    fill = Image.new("RGBA", big.size, (0, 0, 0, 0))
    rr(ImageDraw.Draw(fill), (S + 1, S + 1, W - S - 1, H - S - 1), R - 1, fill=v["panel"])
    mask = fill.split()[3].point(lambda a: 255 if a else 0)
    big.paste(fill, (0, 0), mask)
    if v["inner"]:                        # subtle inner top highlight for dark mode depth
        il = Image.new("RGBA", big.size, (0, 0, 0, 0))
        rr(ImageDraw.Draw(il), (S + 1, S + 1, W - S - 1, H - S - 1), R - 1, outline=v["inner"], width=SS)
        big = Image.alpha_composite(big, il)
    big.resize((W, H), Image.LANCZOS).save(path)
    return W, H

def highlight_png(path):
    W = H = 2 * HR + 4
    big = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    rr(ImageDraw.Draw(big), (0, 0, W, H), HR, fill=BLUE + (255,))
    big.resize((W, H), Image.LANCZOS).save(path)

def chevron_png(path, color, left):
    W, H = 16, 24
    big = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    pts = [(10, 7), (5.5, 12), (10, 17)] if left else [(6, 7), (10.5, 12), (6, 17)]
    d.line([(x * SS, y * SS) for x, y in pts], fill=color, width=int(1.8 * SS), joint="curve")
    big.resize((W, H), Image.LANCZOS).save(path)

CONF = """[Metadata]
Name={name}
Version=1
Author=local
Description=Clean macOS-like candidate panel (rounded, borderless, soft shadow)
ScaleWithDPI=True

[InputPanel]
NormalColor={text}
HighlightCandidateColor={hltext}
HighlightColor={text}
HighlightBackgroundColor=#0a84ff
PageButtonAlignment=Last Candidate
Spacing=2

[InputPanel/TextMargin]
Left=8
Right=8
Top=6
Bottom=6

[InputPanel/ContentMargin]
Left={cm}
Right={cm}
Top={cm}
Bottom={cm}

[InputPanel/ShadowMargin]
Left={s}
Right={s}
Top={s}
Bottom={s}

[InputPanel/Background]
Image=panel.png

[InputPanel/Background/Margin]
Left={m}
Right={m}
Top={m}
Bottom={m}

[InputPanel/Highlight]
Image=highlight.png

[InputPanel/Highlight/Margin]
Left={hm}
Right={hm}
Top={hm}
Bottom={hm}

[InputPanel/PrevPage]
Image=prev.png

[InputPanel/PrevPage/ClickMargin]
Left=4
Right=4
Top=4
Bottom=4

[InputPanel/NextPage]
Image=next.png

[InputPanel/NextPage/ClickMargin]
Left=4
Right=4
Top=4
Bottom=4

[Menu]
NormalColor={text}
HighlightCandidateColor={hltext}
Spacing=0

[Menu/Background]
Image=panel.png

[Menu/Background/Margin]
Left={m}
Right={m}
Top={m}
Bottom={m}

[Menu/ContentMargin]
Left={cm}
Right={cm}
Top={cm}
Bottom={cm}

[Menu/ShadowMargin]
Left={s}
Right={s}
Top={s}
Bottom={s}

[Menu/Highlight]
Image=highlight.png

[Menu/Highlight/Margin]
Left={hm}
Right={hm}
Top={hm}
Bottom={hm}

[Menu/Separator]
Color={sep}

[Menu/CheckBox]
Image=/usr/share/fcitx5/themes/{stock}/radio.png

[Menu/SubMenu]
Image=/usr/share/fcitx5/themes/{stock}/arrow.png

[Menu/TextMargin]
Left=8
Right=8
Top=5
Bottom=5
"""

for key, v in VARIANTS.items():
    out = os.path.join(ROOT, key)
    os.makedirs(out, exist_ok=True)
    panel_png(v, os.path.join(out, "panel.png"))
    highlight_png(os.path.join(out, "highlight.png"))
    chevron_png(os.path.join(out, "prev.png"), v["arrow"], True)
    chevron_png(os.path.join(out, "next.png"), v["arrow"], False)
    with open(os.path.join(out, "theme.conf"), "w") as f:
        f.write(CONF.format(name=v["name"], text=v["text"], hltext=v["hltext"],
                            s=S, cm=S + 5, m=S + R + 1, hm=HR,
                            sep="#00000022" if key == "mac-light" else "#ffffff22",
                            stock="default" if key == "mac-light" else "default-dark"))
    print("wrote", out)
