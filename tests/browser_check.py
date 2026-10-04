"""Browser smoke test: loads dist/index.html in headless Chromium, runs the sample floor to completion,
drags a door, runs Monte Carlo and the calibration tab, and saves screenshots to docs/screenshots/.

Requires:  pip install playwright && playwright install chromium
Usage:     python3 tools/build.py && python3 tests/browser_check.py
"""
import asyncio, os, pathlib
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = (ROOT / "dist" / "index.html").as_uri()
SHOTS = ROOT / "docs" / "screenshots"


async def wait_done(pg, limit=60):
    st = ""
    for _ in range(limit * 2):
        await pg.wait_for_timeout(500)
        st = await pg.evaluate("document.querySelector('#resState').textContent")
        if "finished" in st or "stopped" in st:
            break
    return st


async def main():
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1440, "height": 900})
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(PAGE)
        await pg.wait_for_timeout(1500)
        await pg.click('[data-speed="30"]')
        st = await wait_done(pg)
        a = await pg.evaluate("document.querySelector('#rTime').textContent")
        print("baseline:", st, a)
        assert "finished" in st, "baseline run did not finish"
        await pg.click("#b-saveA")
        # drag the east double door D13 7 m west
        box = await pg.locator("#cv").bounding_box()
        sx, sy = await pg.evaluate("evacuationFlow.W2S(38.1, 8.5)")
        tx, _ = await pg.evaluate("evacuationFlow.W2S(31.1, 8.5)")
        await pg.mouse.move(box["x"] + sx, box["y"] + sy)
        await pg.mouse.down()
        for k in range(1, 21):
            await pg.mouse.move(box["x"] + sx + (tx - sx) * k / 20, box["y"] + sy)
            await pg.wait_for_timeout(20)
        await pg.mouse.up()
        st = await wait_done(pg)
        print("door moved:", st, await pg.evaluate("document.querySelector('#rCompare').textContent"))
        await pg.screenshot(path=str(SHOTS / "moved.png"))
        await pg.evaluate("document.querySelectorAll('details.card').forEach(d => d.open = true)")
        await pg.select_option("#i-runs", "10")
        await pg.click("#b-mc")
        for _ in range(90):
            await pg.wait_for_timeout(1000)
            t = await pg.evaluate("document.querySelector('#mcOut').textContent")
            if "median" in t or "No run" in t:
                break
        print("monte carlo:", t)
        await pg.click("#tab-b-cal")
        for _ in range(90):
            await pg.wait_for_timeout(1000)
            t = await pg.evaluate("document.querySelector('#testState').textContent")
            if t.startswith("Done"):
                break
        res = await pg.evaluate("[...document.querySelectorAll('#testCards .card')].map(c => c.innerText.replace(/\\n+/g, ' | '))")
        for r in res:
            print("test:", r)
        await pg.screenshot(path=str(SHOTS / "cal.png"))
        await b.close()
    if errors:
        raise SystemExit("page errors: %s" % errors)
    print("OK")


asyncio.run(main())
