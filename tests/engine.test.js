const core = require("../src/core.js");
const T = require("../src/testscenes.js");
const params = process.argv[2] ? JSON.parse(process.argv[2]) : null;
if (params) Object.assign(core.DEF, params);
for (const id of ["imo1", "imo4", "imo6"]) {
  const t0 = Date.now(); const r = T.runTest(core, id); console.log(r.label, "|", r.value, "|", r.pass ? "PASS" : "FAIL", (Date.now() - t0) + "ms");
}
const t0 = Date.now();
const s = T.runTest(core, "sweep");
for (const r of s.rows) console.log("door", r.w, "flow", r.flow.toFixed(2), "p/s  specific", r.specific.toFixed(2), " SFPE", r.sfpe.toFixed(2), r.n, r.placed);
console.log("sweep ms", Date.now() - t0);
