"""Build the static site into dist/.

  dist/index.html  – self-contained page (engine, UI and sample floor inlined), served by GitHub Pages
  dist/.nojekyll   – tells GitHub Pages to serve the files as-is

Usage:  python3 tools/build.py
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
SITE_URL = "https://ibrahimfahdah.github.io/fire-evacuation-flow/"
DESCRIPTION = ("Browser-based, agent-based evacuation simulator for floor plans: DXF import, "
               "social force model, bottleneck heatmaps, PD 7974-6 pre-movement, IMO verification tests.")
FAVICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
           "%3Crect width='32' height='32' rx='6' fill='%2308844a'/%3E"
           "%3Cpath d='M9 16h11m-4-5 5 5-5 5' stroke='white' stroke-width='3' fill='none' "
           "stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def write(name, text):
    with open(os.path.join(DIST, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


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

    # template.html starts with <title>, font links and <style>; those go in <head>, the rest in <body>
    cut = page.index("</style>") + len("</style>")
    head, body = page[:cut].strip(), page[cut:].strip()

    html = (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="description" content="%s">\n'
        '<meta name="theme-color" content="#08844a">\n'
        '<link rel="canonical" href="%s">\n'
        '<link rel="icon" href="%s">\n'
        "<style>[hidden]{display:none!important}body{margin:0}img{max-width:100%%}</style>\n"
        "%s\n</head>\n<body>\n%s\n</body>\n</html>\n"
    ) % (DESCRIPTION, SITE_URL, FAVICON, head, body)

    os.makedirs(DIST, exist_ok=True)
    write("index.html", html)
    write(".nojekyll", "")
    print("built dist/index.html (%d bytes)" % len(html))


if __name__ == "__main__":
    main()
