"""Generate a synthetic MDX with N headwords, for measuring wuDict's indexing RAM (Phase 0).

Usage (needs `pip install mdict-utils`):
    python make-big-dict.py <out-dir> [N=1000000]

Writes <out-dir>/PXBig.mdx (~36 MB for 1M headwords). The intermediate text source is written to
<out-dir>/../_big_src so that it is not inside a folder wuDict scans.
"""
import os
import random
import string
import subprocess
import sys

out = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 1_000_000
os.makedirs(out, exist_ok=True)
src = os.path.join(out, "..", "_big_src")
os.makedirs(src, exist_ok=True)

rnd = random.Random(42)
words = ["alpha", "beta", "gamma", "delta", "word", "meaning", "sense", "example"]
with open(os.path.join(src, "src.txt"), "w", encoding="utf-8") as f:
    for i in range(n):
        hw = "".join(rnd.choices(string.ascii_lowercase, k=rnd.randint(4, 12))) + str(i)
        f.write(f'{hw}\r\n<div class="hw">{hw}</div><p>Definition {i}: '
                + " ".join(rnd.choices(words, k=12)) + "</p>\r\n</>\r\n")
with open(os.path.join(src, "t.html"), "w") as f:
    f.write("PXBig 1M")
with open(os.path.join(src, "d.html"), "w") as f:
    f.write("<p>synthetic</p>")

subprocess.check_call(
    ["mdict", "--title", os.path.join(src, "t.html"), "--description", os.path.join(src, "d.html"),
     "-a", os.path.join(src, "src.txt"), os.path.join(out, "PXBig.mdx")],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
