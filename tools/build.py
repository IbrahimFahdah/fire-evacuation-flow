"""Assemble the single-file app.

  dist/evacuation-flow.html  – page fragment (as published to a Claude artifact)
  dist/index.html            – standalone page with <!doctype>, ready for GitHub Pages or any static host

Usage:  python3 tools/build.py
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def strip_export(s):
    # the src modules end with a CommonJS export so Node tests can require() them
    for name in ("SIM_CORE()", "TEST_SCENES()", "DXF_IMPORT"):
        s = s.replace('if (typeof module !== "undefined") module.exports = %s;' % name, "")
    return s


def main():
    sample = read("samples", "Sample_Office_Level03.dxf").strip()
    assert "</script" not in sample, "sample DXF must not contain a closing script tag"
    page = read("src", "template.html")
    page = page.replace("/*SAMPLE_DXF*/", sample)
    page = page.replace("/*CORE*/", strip_export(read("src", "core.js")))
    page = page.replace("/*TESTS*/", strip_export(read("src", "testscenes.js")))
    page = page.replace("/*DXF*/", strip_export(read("src", "dxf.js")))
    page = page.replace("/*APP*/", read("src", "app.js"))
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    with open(os.path.join(ROOT, "dist", "evacuation-flow.html"), "w", encoding="utf-8") as f:
        f.write(page)
    standalone = (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        "<style>[hidden]{display:none!important}body{margin:0}img{max-width:100%}</style>\n"
        "</head>\n<body>\n" + page + "\n</body>\n</html>\n"
    )
    with open(os.path.join(ROOT, "dist", "index.html"), "w", encoding="utf-8") as f:
        f.write(standalone)
    print("built dist/evacuation-flow.html (%d bytes) and dist/index.html" % len(page))


if __name__ == "__main__":
    main()
