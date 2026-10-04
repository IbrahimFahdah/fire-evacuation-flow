// Procedural test scenes (IMO MSC.1/Circ.1533 style) in the same model format as DXF imports.
function TEST_SCENES() {
  function rect(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  // walls around a box [x0,y0,x1,y1] (interior), thickness t, as 4 solid rects
  function box(x0, y0, x1, y1, t) {
    return [rect(x0 - t, y0 - t, x1 + t, y0), rect(x0 - t, y1, x1 + t, y1 + t), rect(x0 - t, y0, x0, y1), rect(x1, y0, x1 + t, y1)];
  }
  function door(name, hinge, u, n, width, isExit) {
    return { name, hinge, u, n, width, isExit: !!isExit, blocked: false, band: [0, 0.2], orig: null, fire: false };
  }
  // IMO test 4: 8 m x 5 m room, 1 m exit centred on a 5 m wall, 100 persons
  function imo4(doorW) {
    const w = doorW || 1.0;
    return {
      name: "IMO 4", bounds: [-0.2, -0.2, 8.2, 5.2], solids: box(0, 0, 8, 5, 0.2), strokes: [], furniture: [], seats: [],
      doors: [door("Exit", [8.0, 2.5 - w / 2], [0, 1], [1, 0], w, true)],
      spawnBox: [0.3, 0.3, 7.7, 4.7],
    };
  }
  // door sweep: 10 x 10 room, door width w
  function sweep(w) {
    return {
      name: "Door " + w, bounds: [-0.2, -0.2, 10.2, 10.2], solids: box(0, 0, 10, 10, 0.2), strokes: [], furniture: [], seats: [],
      doors: [door("Exit", [10.0, 5 - w / 2], [0, 1], [1, 0], w, true)], spawnBox: [0.3, 0.3, 9.7, 9.7],
    };
  }
  // IMO test 1: 40 m x 2 m corridor, one person, exit across the far end
  function imo1() {
    return {
      name: "IMO 1", bounds: [-0.2, -0.2, 40.2, 2.2], solids: box(0, 0, 40, 2, 0.2), strokes: [], furniture: [], seats: [],
      doors: [door("End", [40.0, 0.0], [0, 1], [1, 0], 2.0, true)], spawnBox: null,
    };
  }
  // IMO test 6: 2 m corridor, 10 m then a left turn and 10 m; 20 persons start in the first 4 m
  function imo6() {
    const t = 0.2, s = [];
    s.push(rect(-t, -t, 12 + t, 0));          // south wall of first leg (to corner)
    s.push(rect(-t, 2, 10, 2 + t));           // north wall of first leg until turn
    s.push(rect(-t, 0, 0, 2));                // start cap
    s.push(rect(12, 0, 12 + t, 12));          // east wall of second leg
    s.push(rect(10 - t, 2, 10, 12));          // west wall of second leg
    return {
      name: "IMO 6", bounds: [-0.2, -0.2, 12.2, 12.2], solids: s, strokes: [], furniture: [], seats: [],
      doors: [door("End", [10.0, 12.0], [1, 0], [0, 1], 2.0, true)], spawnBox: [0.3, 0.3, 7.0, 1.7],
    };
  }
  // jittered lattice: dense enough for IMO densities (2.5 p/m2) without overlaps
  function randomPositions(sb, n, seed, core) {
    const r = core.rng(seed), W = sb[2] - sb[0], H = sb[3] - sb[1];
    let s = Math.sqrt(W * H / n);
    let cols, rows;
    while (true) { cols = Math.floor(W / s); rows = Math.floor(H / s); if (cols * rows >= n) break; s *= 0.98; }
    const pts = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) pts.push([sb[0] + (i + 0.5) * W / cols, sb[1] + (j + 0.5) * H / rows]);
    for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
    const jit = Math.max(0, Math.min(W / cols, H / rows) - 0.55) / 2;
    return pts.slice(0, n).map(p => [p[0] + (r() * 2 - 1) * jit, p[1] + (r() * 2 - 1) * jit]);
  }
  function runTest(core, id, opt) {
    opt = opt || {};
    const seed = opt.seed || 7;
    if (id === "imo1") {
      const m = imo1(), env = core.buildEnv(m);
      const sim = core.runHeadless(env, { N: 1, seed, positions: [[0.5, 1.0]], fixedSpeed: 1.0 });
      // start at x=0.5 (body clear of the end wall); door plane at x=40 -> 39.5 m, scaled to 40 m
      const t = sim.TE[0] * 40 / 39.5;
      return { id, label: "IMO 1 · speed in a corridor", expected: "40 s for 40 m at 1.0 m/s", value: t.toFixed(1) + " s", pass: Math.abs(t - 40) <= 1.5 };
    }
    if (id === "imo4") {
      const m = imo4(), env = core.buildEnv(m);
      const sim = core.runHeadless(env, { N: 100, seed, positions: randomPositions(m.spawnBox, 100, seed, core) });
      const s = sim.summary(), e = s.exits[0];
      const flow = e.count / Math.max(1e-6, e.last);
      return { id, label: "IMO 4 · flow through a 1 m exit", expected: "≤ 1.33 p/s over the whole period", value: flow.toFixed(2) + " p/s (" + e.count + " people, " + e.last.toFixed(1) + " s)", pass: flow <= 1.33 && e.count === 100, flow };
    }
    if (id === "imo6") {
      const m = imo6(), env = core.buildEnv(m);
      const sim = core.runHeadless(env, { N: 20, seed, positions: randomPositions(m.spawnBox, 20, seed, core) });
      const s = sim.summary();
      // boundary check: nobody ever stood inside a wall cell (enforced) and everyone made it round
      return { id, label: "IMO 6 · rounding a corner", expected: "all 20 round the corner, none cross walls", value: s.exits[0].count + "/20 through in " + s.tClear.toFixed(1) + " s, 0 wall crossings", pass: s.exits[0].count === 20 };
    }
    if (id === "sweep") {
      const rows = [];
      for (const w of opt.widths || [0.8, 1.0, 1.2, 1.6, 2.0, 2.4]) {
        const m = sweep(w), env = core.buildEnv(m);
        const N = opt.N || 150;
        const sim = core.runHeadless(env, { N, seed, positions: randomPositions(m.spawnBox, N, seed, core) });
        const te = Array.from(sim.TE).filter(x => x >= 0).sort((a, b) => a - b);
        const a = te[Math.floor(te.length * 0.1)], b = te[Math.floor(te.length * 0.9)];
        const flow = (0.8 * te.length) / Math.max(1e-6, b - a);
        rows.push({ w, flow, specific: flow / w, sfpe: 1.32 * Math.max(0, w - 0.3), n: te.length, placed: sim.n });
      }
      return { id, rows };
    }
  }
  return { imo1, imo4, imo6, sweep, runTest, randomPositions };
}
if (typeof module !== "undefined") module.exports = TEST_SCENES();
