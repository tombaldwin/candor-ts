#!/usr/bin/env node
// candor-viz — render a candor report + callgraph sidecar as a self-contained, dependency-free HTML
// effect graph. The PRACTICAL view is baked as STATIC inline SVG (renders in any viewer, no JS).
// The ABSTRACT view is a JS canvas animation (a real browser) where effects propagate — particles
// bubble up from each effect SOURCE through every caller that transitively reaches it.
//
//   node viz.mjs <report-prefix | report.json> [out.html]
//
// <report-prefix> is the part before `.json` (also reads `<prefix>.callgraph.json`). Pure fns live
// only in the callgraph; the report carries effects (`inferred` = transitive, `direct` = the
// source's own body). Works on any engine's report.
import fs from "node:fs";
import path from "node:path";

const arg = process.argv[2];
if (!arg) { console.error("usage: node viz.mjs <report-prefix|report.json> [out.html]"); process.exit(2); }
const repPath = arg.endsWith(".json") ? arg : arg + ".json";
const cgPath = repPath.replace(/\.json$/, ".callgraph.json");
const out = process.argv[3] || repPath.replace(/\.json$/, "") + ".viz.html";

const rep = JSON.parse(fs.readFileSync(repPath, "utf8"));
const fns = Array.isArray(rep) ? rep : rep.functions;
const cg = fs.existsSync(cgPath) ? JSON.parse(fs.readFileSync(cgPath, "utf8")) : {};

const PALETTE = [
  ["Exec", "#ff5470"], ["Net", "#4cc4ff"], ["Llm", "#00d0c0"], ["Db", "#ffb347"], ["Fs", "#3ce8a0"],
  ["Ipc", "#c77dff"], ["Env", "#a78bfa"], ["Clock", "#2dd4bf"], ["Rand", "#ff7ad9"],
  ["Log", "#94a3b8"], ["Clipboard", "#e0c84a"], ["Unknown", "#7c8794"],
];
const COLOR = Object.fromEntries(PALETTE);
const ORDER = PALETTE.map(([e]) => e);
const PURE = "#39424e";

const by = new Map(fns.map((f) => [f.fn, f]));
const ids = new Set([...Object.keys(cg), ...Object.values(cg).flat(), ...by.keys()]);
const callees = new Map([...ids].map((n) => [n, (cg[n] || []).filter((c) => ids.has(c))]));
const callers = new Map([...ids].map((n) => [n, []]));
for (const [n, cs] of callees) for (const c of cs) callers.get(c).push(n);
const blast = (n) => { const seen = new Set(); const st = [...callers.get(n)]; while (st.length) { const x = st.pop(); if (!seen.has(x)) { seen.add(x); st.push(...callers.get(x)); } } return seen.size; };
const primary = (effs) => ORDER.find((e) => effs.includes(e)) || null;

const nodeList = [...ids].sort();
const idx = new Map(nodeList.map((n, i) => [n, i]));
const nodes = nodeList.map((n) => {
  const f = by.get(n) || {}, inferred = f.inferred || [], p = primary(inferred);
  return { id: n, label: n.split(".").pop().split("::").pop(), effects: inferred, direct: f.direct || [],
    source: (f.direct || []).length > 0, color: p ? COLOR[p] || PURE : PURE, pure: inferred.length === 0,
    loc: f.loc || "", blast: blast(n) };
});
const links = [];
for (const [n, cs] of callees) for (const c of cs) links.push([idx.get(n), idx.get(c)]);

// ---- bake a force layout (deterministic) ----
let seed = 1; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const N = nodes.length, W = 1600, H = 1000;
const P = nodes.map(() => ({ x: W / 2 + (rnd() - 0.5) * 700, y: H / 2 + (rnd() - 0.5) * 460, vx: 0, vy: 0 }));
for (let it = 0; it < 340; it++) {
  for (const p of P) { p.vx *= 0.86; p.vy *= 0.86; }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = dx * dx + dy * dy || 1;
    const f = 5600 / d2, d = Math.sqrt(d2); dx /= d; dy /= d;
    P[i].vx += dx * f; P[i].vy += dy * f; P[j].vx -= dx * f; P[j].vy -= dy * f;
  }
  for (const [a, b] of links) { let dx = P[b].x - P[a].x, dy = P[b].y - P[a].y, d = Math.sqrt(dx * dx + dy * dy) || 1; const f = (d - 92) * 0.02; dx /= d; dy /= d; P[a].vx += dx * f; P[a].vy += dy * f; P[b].vx -= dx * f; P[b].vy -= dy * f; }
  for (let i = 0; i < N; i++) { P[i].vx += (W / 2 - P[i].x) * 0.002; P[i].vy += (H / 2 - P[i].y) * 0.002; P[i].x += P[i].vx; P[i].y += P[i].vy; }
}
nodes.forEach((n, i) => { n.x = Math.round(P[i].x); n.y = Math.round(P[i].y); n.r = +(4 + Math.sqrt(n.blast) * 1.6).toFixed(1); });

const present = ORDER.filter((e) => nodes.some((n) => n.effects.includes(e)));
const title = path.basename(repPath).replace(/\.json$/, "");
const nEff = nodes.filter((n) => !n.pure).length, nSrc = nodes.filter((n) => n.source).length;
const sub = `${nodes.length} functions · ${nEff} effectful · ${nSrc} effect sources · ${links.length} call edges`;

// ---- STATIC SVG (the practical view; renders with zero JS) ----
const edgeSvg = links.map(([a, b]) => `<line x1="${nodes[a].x}" y1="${nodes[a].y}" x2="${nodes[b].x}" y2="${nodes[b].y}" stroke="#212a34" stroke-width="1"/>`).join("");
const nodeSvg = nodes.map((n, i) => {
  const stroke = n.source ? "#eef3f8" : "#0a0d12", sw = n.source ? 2 : 1, fill = n.pure ? PURE : n.color;
  const tcol = n.pure ? "#586573" : "#9fb0bf";
  return `<g data-i="${i}"><circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${n.pure ? "" : ` filter="url(#glow)"`}/>` +
    `<text x="${n.x + n.r + 3}" y="${n.y + 3}" fill="${tcol}" font-size="9">${esc(n.label)}</text></g>`;
}).join("");
const staticSvg = `<svg id="practical" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
  `<defs><filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
  `<g id="pworld">${edgeSvg}${nodeSvg}</g></svg>`;

const DATA = JSON.stringify({ nodes, links, present, colors: COLOR, W, H });
const legend = present.map((e) => `<span><i style="background:${COLOR[e]};box-shadow:0 0 8px ${COLOR[e]}"></i>${e}</span>`).join("");

fs.writeFileSync(out, page(title, sub, staticSvg, DATA, legend));
console.log(`wrote ${out}: ${nodes.length} nodes, ${links.length} edges, effects [${present.join(", ")}]`);

function page(title, sub, staticSvg, DATA, legend) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>candor · ${esc(title)}</title>
<style>
 html,body{margin:0;height:100%;background:#0a0d12;color:#cdd6e0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}
 #practical,#abstract{position:fixed;inset:0;width:100vw;height:100vh;display:block}
 #abstract{display:none}
 #hdr{position:fixed;top:12px;left:16px;z-index:9;pointer-events:none}
 #hdr h1{margin:0;font-size:15px;color:#eef3f8;letter-spacing:.3px} #hdr .sub{color:#7c8794;font-size:12px}
 #legend{position:fixed;top:12px;right:16px;z-index:9;text-align:right;color:#9aa7b4}
 #legend span{margin-left:13px} #legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}
 #legend .src{width:7px;height:7px;border:2px solid #eef3f8;box-shadow:none}
 #modes{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9;display:flex;background:#141a22;border:1px solid #232c37;border-radius:999px;overflow:hidden}
 #modes button{background:none;border:none;color:#8b98a6;font:inherit;padding:7px 18px;cursor:pointer}
 #modes button.on{background:#1f6feb22;color:#eef3f8;box-shadow:inset 0 0 0 1px #1f6feb55}
 #tip{position:fixed;pointer-events:none;background:#10151c;border:1px solid #28323e;border-radius:7px;padding:8px 11px;font-size:12px;display:none;max-width:360px;z-index:10;box-shadow:0 6px 24px #000a}
 #tip b{color:#eef3f8} #tip .eff{color:#3ce8a0} #tip .dir{color:#ffb347} #tip .loc{color:#5d6875;font-size:11px}
 #hint{position:fixed;bottom:16px;left:16px;color:#4f5a67;font-size:11px;z-index:9}
 #practical text{pointer-events:none} #practical g[data-i]{cursor:pointer}
</style></head><body>
<div id="hdr"><h1>candor &middot; ${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
<div id="legend">${legend} <span><i class="src"></i>source</span></div>
${staticSvg}
<canvas id="abstract"></canvas>
<div id="tip"></div>
<div id="hint">hover a node for effects &middot; click to isolate everything its effect reaches</div>
<div id="modes"><button id="mPra" class="on">practical</button><button id="mAbs">abstract</button></div>
<script>
const D=${DATA}, NS="http://www.w3.org/2000/svg";
const svg=document.getElementById("practical"), cv=document.getElementById("abstract"), tip=document.getElementById("tip"), hint=document.getElementById("hint");
let raf=0;
// ---- practical: progressive enhancement on the static SVG (hover + click-isolate) ----
const out=new Map(D.nodes.map((_,i)=>[i,[]])), inn=new Map(D.nodes.map((_,i)=>[i,[]]));
D.links.forEach(([a,b])=>{out.get(a).push(b);inn.get(b).push(a);});
const reach=(i,adj)=>{const s=new Set(),st=[i];while(st.length){const x=st.pop();for(const y of adj.get(x))if(!s.has(y)){s.add(y);st.push(y);}}return s;};
const gels=[...svg.querySelectorAll("g[data-i]")], eels=[...svg.querySelectorAll("line")];
let isoN=null;
gels.forEach(g=>{ const n=D.nodes[+g.dataset.i];
 g.addEventListener("mousemove",ev=>{tip.style.display="block";tip.style.left=(ev.clientX+14)+"px";tip.style.top=(ev.clientY+14)+"px";
   tip.innerHTML="<b>"+esc(n.id)+"</b><br>"+(n.effects.length?"<span class=eff>"+n.effects.join(", ")+"</span>":"<span style=color:#5d6875>pure</span>")
     +(n.direct.length?" &middot; <span class=dir>performs "+n.direct.join(", ")+" here</span>":"")+"<br><span class=loc>"+esc(n.loc)+" &middot; blast radius "+n.blast+"</span>";});
 g.addEventListener("mouseleave",()=>tip.style.display="none");
 g.addEventListener("click",ev=>{ev.stopPropagation();iso(isoN===+g.dataset.i?null:+g.dataset.i);});
});
svg.addEventListener("click",()=>iso(null));
function iso(i){ isoN=i;
 if(i==null){gels.forEach(g=>g.style.opacity=1);eels.forEach(e=>{e.style.opacity=1;e.setAttribute("stroke","#212a34");});return;}
 const keep=reach(i,out);keep.add(i);for(const x of reach(i,inn))keep.add(x);
 gels.forEach(g=>g.style.opacity=keep.has(+g.dataset.i)?1:0.12);
 D.links.forEach(([a,b],k)=>{const on=keep.has(a)&&keep.has(b);eels[k].style.opacity=on?1:0.05;eels[k].setAttribute("stroke",on?"#3a4757":"#212a34");});
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
// ---- abstract: animated effect propagation (canvas) ----
const ctx=cv.getContext("2d"), cers=new Map(D.nodes.map((_,i)=>[i,[]]));
D.links.forEach(([a,b])=>cers.get(b).push(a));
const sources=D.nodes.map((n,i)=>({n,i})).filter(o=>o.n.source);
let parts=[];
function fit(){const s=Math.min(innerWidth/D.W,innerHeight/D.H)*0.92;return{s,ox:(innerWidth-D.W*s)/2,oy:(innerHeight-D.H*s)/2};}
function spawn(){for(const{n,i}of sources)for(const e of n.direct){if(parts.length>1400)return;if(Math.random()>0.16)continue;parts.push({x:n.x,y:n.y,node:i,col:D.colors[e]||"#7c8794",life:1,hop:0,tgt:null});}}
function step(){const nx=[];for(const p of parts){const cs=cers.get(p.node);
 if(p.tgt==null){if(!cs.length||p.hop>7)p.life-=0.04;else{p.tgt=cs[(Math.random()*cs.length)|0];p.hop++;}}
 if(p.tgt!=null){const t=D.nodes[p.tgt],dx=t.x-p.x,dy=t.y-p.y,d=Math.hypot(dx,dy);if(d<3){p.node=p.tgt;p.tgt=null;}else{p.x+=dx/d*Math.min(d,5.5);p.y+=dy/d*Math.min(d,5.5);}}
 p.life-=0.0022;if(p.life>0)nx.push(p);}parts=nx;spawn();}
function dot(x,y,r){ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill();}
function draw(){const{s,ox,oy}=fit();
 ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle="rgba(10,13,18,0.30)";ctx.fillRect(0,0,cv.width,cv.height);
 ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);ctx.save();ctx.translate(ox,oy);ctx.scale(s,s);
 ctx.strokeStyle="rgba(120,135,150,0.05)";ctx.lineWidth=1;ctx.beginPath();for(const[a,b]of D.links){ctx.moveTo(D.nodes[a].x,D.nodes[a].y);ctx.lineTo(D.nodes[b].x,D.nodes[b].y);}ctx.stroke();
 const t=performance.now()/1000;ctx.globalCompositeOperation="lighter";
 for(const n of D.nodes){if(n.pure){ctx.globalCompositeOperation="source-over";ctx.fillStyle="rgba(70,80,92,0.5)";dot(n.x,n.y,1.6);ctx.globalCompositeOperation="lighter";continue;}
   const pulse=n.source?(0.6+0.4*Math.sin(t*2+n.x*0.01)):1;ctx.shadowBlur=(n.source?22:11)*pulse;ctx.shadowColor=n.color;ctx.fillStyle=n.color;dot(n.x,n.y,(2.2+Math.sqrt(n.blast)*1.1)*(n.source?1.25:1)*pulse);}
 ctx.shadowBlur=0;for(const p of parts){ctx.fillStyle=p.col;ctx.shadowBlur=10;ctx.shadowColor=p.col;ctx.globalAlpha=Math.min(1,p.life*1.4);dot(p.x,p.y,2.1);}
 ctx.globalAlpha=1;ctx.shadowBlur=0;ctx.globalCompositeOperation="source-over";ctx.restore();}
function loop(){step();draw();raf=requestAnimationFrame(loop);}
function resizeCv(){const d=devicePixelRatio||1;cv.width=innerWidth*d;cv.height=innerHeight*d;}
addEventListener("resize",resizeCv);resizeCv();
// ---- mode toggle ----
function setMode(m){cancelAnimationFrame(raf);
 document.getElementById("mPra").classList.toggle("on",m==="practical");document.getElementById("mAbs").classList.toggle("on",m==="abstract");
 svg.style.display=m==="practical"?"block":"none";cv.style.display=m==="abstract"?"block":"none";
 if(m==="abstract"){hint.textContent="effects propagate from their sources up through every caller that reaches them";ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle="#0a0d12";ctx.fillRect(0,0,cv.width,cv.height);loop();}
 else hint.textContent="hover a node for effects · click to isolate everything its effect reaches";}
document.getElementById("mPra").onclick=()=>setMode("practical");
document.getElementById("mAbs").onclick=()=>setMode("abstract");
</script></body></html>`;
}
function esc(s){ return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
