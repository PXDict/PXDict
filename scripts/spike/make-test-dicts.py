"""Generate small MDict test dictionaries for the PXDict Phase 0 spike.

Usage (needs `pip install mdict-utils`):
    python make-test-dicts.py <out-dir>

Creates three dictionaries under <out-dir>:
  pxtest/   PXTest.mdx + PXTest.mdd (images, audio) + pxtest.css / pxtest.js beside the MDX;
            entries use relative, root-absolute, sound:// and entry:// references and an @@@LINK
  pxtest2/  PXTest2.mdx only, overlapping headwords (for multi-dictionary filtering)
  pxtest3/  PXTest3.mdx + PXTest3.mdd with the stylesheet inside the MDD
Intermediate sources go to <out-dir>/../_src so that wuDict does not scan them.
"""
import os, struct, subprocess, sys, zlib

OUT = sys.argv[1]

def png(rgb):
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = b"".join(b"\x00" + bytes(rgb) * 4 for _ in range(4))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())

def mdx(dirname, name, title, entries, res=None, extra=None):
    d = os.path.join(OUT, dirname)
    os.makedirs(d, exist_ok=True)
    src = os.path.join(OUT, "..", "_src", name)
    os.makedirs(src, exist_ok=True)
    txt = "".join(f"{hw}\r\n{body}\r\n</>\r\n" for hw, body in entries)
    write(os.path.join(src, "src.txt"), txt)
    write(os.path.join(src, "title.html"), title)
    write(os.path.join(src, "desc.html"), f"<p>{title} - PXDict spike test dictionary</p>")
    subprocess.check_call(["mdict", "--title", os.path.join(src, "title.html"),
                           "--description", os.path.join(src, "desc.html"),
                           "-a", os.path.join(src, "src.txt"), os.path.join(d, name + ".mdx")],
                          stdout=subprocess.DEVNULL)
    if res:
        rd = os.path.join(src, "res")
        for p, data in res.items():
            write(os.path.join(rd, p), data)
        subprocess.check_call(["mdict", "-a", rd, os.path.join(d, name + ".mdd")],
                              stdout=subprocess.DEVNULL)
    for p, data in (extra or {}).items():
        write(os.path.join(d, p), data)

def body(hw, other):
    return (f'<link rel="stylesheet" type="text/css" href="pxtest.css">'
            f'<script src="pxtest.js"></script>'
            f'<div class="hw">{hw}</div><p class="def">Definition of {hw} (PXTest).</p>'
            f'<img src="img/{hw}.png" alt="{hw}">'
            f'<a href="sound://audio/{hw}.mp3">play</a> '
            f'<a href="entry://{other}">see {other}</a> '
            f'<img src="/img/abs.png" alt="abs">')

words = ["cat", "dog", "bird", "fish", "horse"]
entries = [(w, body(w, words[(i + 1) % len(words)])) for i, w in enumerate(words)]
entries.append(("kitty", "@@@LINK=cat"))
entries += [(f"apple{i}", f"<p>apple number {i}</p>") for i in range(20)]
res = {f"img/{w}.png": png((40 * i, 200 - 30 * i, 120)) for i, w in enumerate(words)}
res["img/abs.png"] = png((0, 0, 0))
res.update({f"audio/{w}.mp3": b"ID3\x03\x00\x00\x00\x00\x00\x00" + w.encode() * 50 for w in words})
mdx("pxtest", "PXTest", "PXTest EN-VI", entries, res,
    extra={"pxtest.css": ".hw{font-weight:bold;color:#a00}\n",
           "pxtest.js": "document.documentElement.dataset.pxtest='js-ran';\n"})

mdx("pxtest2", "PXTest2", "PXTest2 plain",
    [(w, f"<p>PXTest2 says: {w}</p>") for w in words + ["zebra"]])

# One that ships CSS inside the MDD instead of beside the MDX.
mdx("pxtest3", "PXTest3", "PXTest3 css-in-mdd",
    [(w, f'<link rel="stylesheet" href="inmdd.css"><p class="x">PXTest3 {w}</p>') for w in words],
    {"inmdd.css": ".x{color:green}\n"})
