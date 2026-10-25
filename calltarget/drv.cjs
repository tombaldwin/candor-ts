// Ground-truth driver (CommonJS: the repo is "type": "module"): node drv.cjs <module.js> <Q> <Fs|Net|Exec> <waitMs>
// Runs in a fresh cwd. Prints one JSON line: {pre, post, err}. pre = effect observed after require, before Q.
const fs = require("fs"), net = require("net");
const [mod, q, eff, waitMs] = process.argv.slice(2);
let conns = 0;
const seen = () => (eff === "Net" ? conns > 0 : fs.existsSync("ctmark.txt"));
function go() {
  let pre = false, err = null;
  try {
    const m = require(mod);
    pre = seen();
    const r = m[q]();
    if (r && typeof r.then === "function") r.then(() => {}, (e) => { err = String(e); });
  } catch (e) { err = String(e && e.stack || e).split("\n").slice(0, 2).join(" | "); }
  setTimeout(() => {
    console.log(JSON.stringify({ pre, post: seen(), err }));
    process.exit(0);
  }, Math.max(40, Number(waitMs) + 40) + (eff === "Net" ? 120 : 0));
}
if (eff === "Net") {
  const srv = net.createServer((s) => { conns++; s.destroy(); });
  srv.listen(47361, "127.0.0.1", go);
} else go();
