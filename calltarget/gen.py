#!/usr/bin/env python3
"""Call-target matrix generator for candor-ts (calltarget-analysis 2026-10-24; in-repo since call-target round 1).

Axes:  lang x L(location) x K(call kind) x R(receiver typing / implementor shape) x N(implementors) x E(effect)
Every cell is a tiny program: abstraction A, implementors (E effectful / P pure), a SITE (the function whose
body contains the call site), and Q (the consumer function that builds the implementor and calls the site).
Ground truth is executed by run_gt.py; the engine is measured by measure.py.

Gated units: SITE (when it lives in the scanned consumer) and Q (always in the consumer).
"""
import json, os, shutil, sys, itertools

W = sys.argv[1]  # the work directory's m/ (run.sh passes it)
PORT = 47361

# ---------------------------------------------------------------- effects
EFF_IMPORT = {
    "Fs": 'import * as fs_ from "node:fs";',
    "Net": 'import * as net_ from "node:net";',
    "Exec": 'import * as cp_ from "node:child_process";',
}
EFF_REQUIRE = {
    "Fs": 'const fs_ = require("node:fs");',
    "Net": 'const net_ = require("node:net");',
    "Exec": 'const cp_ = require("node:child_process");',
}
EFF_BODY = {
    "Fs": 'fs_.writeFileSync("ctmark.txt", "x");',
    "Net": f'net_.connect({PORT}, "127.0.0.1").on("error", () => {{}});',
    "Exec": 'cp_.execFileSync("/usr/bin/touch", ["ctmark.txt"]);',
}

# ---------------------------------------------------------------- call kinds on a receiver
# member kinds: a = interface member decl; impl(body) = class member; obj(body) = object-literal member;
# abs = abstract member decl; base = pure default member (for a base class); expr(x) = the call site.
def K_table(i):
    m, f, g = f"m_{i}", f"f_{i}", f"g_{i}"
    meth = dict(a=f"{m}(): void;", impl=lambda b: f"{m}(): void {{ {b} }}", obj=lambda b: f"{m}(): void {{ {b} }}",
                abs=f"abstract {m}(): void;", base=f"{m}(): void {{ }}",
                js=lambda b: f"{m}() {{ {b} }}", jsname=m, jsfn=lambda b: f"function () {{ {b} }}")
    def k(base, expr, **kw):
        d = dict(base); d["expr"] = expr; d.update(kw); return d
    tostr = dict(a="toString(): string;", impl=lambda b: f'toString(): string {{ {b} return "s"; }}',
                 obj=lambda b: f'toString(): string {{ {b} return "s"; }}', abs="abstract toString(): string;",
                 base='toString(): string { return "b"; }', js=lambda b: f'toString() {{ {b} return "s"; }}',
                 jsname="toString", jsfn=lambda b: f'function () {{ {b} return "s"; }}')
    # undeclared: the abstraction does NOT declare toString — it is inherited from Object in the type system
    tostr_u = dict(tostr); tostr_u.update(a=f"tag_{i}(): number;", abs=f"abstract tag_{i}(): number;",
                                          base=f"tag_{i}(): number {{ return 0; }}",
                                          extra_impl=f"tag_{i}(): number {{ return 1; }}",
                                          extra_obj=f"tag_{i}(): number {{ return 1; }}",
                                          extra_js=f"tag_{i}() {{ return 1; }}", undeclared=True)
    valof = dict(a="valueOf(): number;", impl=lambda b: f"valueOf(): number {{ {b} return 1; }}",
                 obj=lambda b: f"valueOf(): number {{ {b} return 1; }}", abs="abstract valueOf(): number;",
                 base="valueOf(): number { return 0; }", js=lambda b: f"valueOf() {{ {b} return 1; }}",
                 jsname="valueOf", jsfn=lambda b: f"function () {{ {b} return 1; }}")
    itr = dict(a="[Symbol.iterator](): Iterator<number>;",
               impl=lambda b: f"*[Symbol.iterator](): Iterator<number> {{ {b} yield 1; }}",
               obj=lambda b: f"*[Symbol.iterator](): Iterator<number> {{ {b} yield 1; }}",
               abs="abstract [Symbol.iterator](): Iterator<number>;",
               base="*[Symbol.iterator](): Iterator<number> { }",
               js=lambda b: f"*[Symbol.iterator]() {{ {b} yield 1; }}", jsname=None,
               jsfn=lambda b: f"function* () {{ {b} yield 1; }}", jskey="Symbol.iterator")
    get = dict(a=f"readonly {g}: number;", impl=lambda b: f"get {g}(): number {{ {b} return 1; }}",
               obj=lambda b: f"get {g}(): number {{ {b} return 1; }}", abs=f"abstract get {g}(): number;",
               base=f"get {g}(): number {{ return 0; }}", js=lambda b: f"get {g}() {{ {b} return 1; }}",
               jsname=None, jsgetter=g)
    tojson = dict(a="toJSON(): unknown;", impl=lambda b: f"toJSON(): unknown {{ {b} return 1; }}",
                  obj=lambda b: f"toJSON(): unknown {{ {b} return 1; }}", abs="abstract toJSON(): unknown;",
                  base="toJSON(): unknown { return 0; }", js=lambda b: f"toJSON() {{ {b} return 1; }}",
                  jsname="toJSON", jsfn=lambda b: f"function () {{ {b} return 1; }}")
    then = dict(a="then(r: (v: number) => void): void;", impl=lambda b: f"then(r: (v: number) => void): void {{ {b} r(1); }}",
                obj=lambda b: f"then(r: (v: number) => void): void {{ {b} r(1); }}",
                abs="abstract then(r: (v: number) => void): void;", base="then(r: (v: number) => void): void { r(0); }",
                js=lambda b: f"then(r) {{ {b} r(1); }}", jsname="then", jsfn=lambda b: f"function (r) {{ {b} r(1); }}")
    fnprop = dict(a=f"{f}: () => void;", impl=lambda b: f"{f} = (): void => {{ {b} }};",
                  obj=lambda b: f"{f}: (): void => {{ {b} }}", abs=f"abstract {f}: () => void;",
                  base=f"{f} = (): void => {{ }};", js=lambda b: f"{f} = () => {{ {b} }};", jsname=None, jsfield=f)
    return {
        "meth": k(meth, lambda x: f"{x}.{m}();"),
        "elem": k(meth, lambda x: f'{x}["{m}"]();'),
        "callm": k(meth, lambda x: f"{x}.{m}.call({x});"),
        "hofref": k(meth, lambda x: f"[0].forEach({x}.{m});"),
        "defer": k(meth, lambda x: f"setTimeout({x}.{m}, 0);", wait=150),
        "thenref": k(meth, lambda x: f"Promise.resolve().then({x}.{m});", wait=60),
        "fnprop": k(fnprop, lambda x: f"{x}.{f}();"),
        "xtostr": k(tostr, lambda x: f"void {x}.toString();"),
        "xtostr_u": k(tostr_u, lambda x: f"void {x}.toString();"),
        "tpl": k(tostr, lambda x: f"void `${{{x}}}`;"),
        "tpl_u": k(tostr_u, lambda x: f"void `${{{x}}}`;"),
        "str": k(tostr, lambda x: f"void String({x});"),
        "plus": k(valof, lambda x: f'void ("" + {x});'),
        "unplus": k(valof, lambda x: f"void (+{x});"),
        "eqeq": k(valof, lambda x: f"void ({x} == (1 as any));", jsexpr=lambda x: f"void ({x} == 1);"),
        "numcall": k(valof, lambda x: f"void Number({x});"),
        "iter": k(itr, lambda x: f"for (const v of {x}) {{ void v; }}"),
        "spread": k(itr, lambda x: f"void [...{x}];"),
        "getter": k(get, lambda x: f"void {x}.{g};"),
        "json": k(tojson, lambda x: f"void JSON.stringify({x});"),
        "jsonnest": k(tojson, lambda x: f"void JSON.stringify({{ a: {x} }});"),
        "await": k(then, lambda x: f"await {x};", asyn=True, wait=60),
    }

RECV_KINDS = list(K_table(0).keys())
NONRECV_KINDS = ["static", "fnparam", "fnreg"]

R_TS = ["iface", "struct", "objlit", "cls", "abs", "gen", "any", "field", "conc", "union"]
R_JS = ["jcls_doc", "jcls_untyped", "jproto_doc", "jproto_untyped", "jobj_untyped", "jmixin_untyped"]
N_ALL = ["one", "mix", "pure", "sib"]

def rn_ok(R, N, L):
    if R == "conc" and N not in ("one", "pure"): return False
    if R == "union" and N != "mix": return False
    if N == "sib" and R not in ("cls", "abs", "jcls_doc", "jcls_untyped"): return False
    if L.startswith("dsite") and (R in ("conc", "union") or N == "sib"): return False   # dep cannot name consumer classes
    return True

def rk_ok(R, K):
    # Object.assign copies a getter's VALUE at assignment time: the effect runs at module load, not at the site.
    if R == "jmixin_untyped" and K == "getter": return False
    return True

def effect_happens(N): return N in ("one", "mix")

# ---------------------------------------------------------------- TS fragments
def ts_fragments(cid, K, R, N, E):
    """Returns dict(abs_src, impl_src, site_src, q_src, site_fn, q_fn, imports) — import placeholders resolved later.
    Names: A_<id> abstraction, B_<id> base, E_<id> effectful, P_<id> pure, S_<id> site, H_<id> holder, Q_<id> consumer."""
    i = cid
    A, B, Ec, Pc, S, H, Q = (f"{p}_{i}" for p in ("A", "B", "E", "P", "S", "H", "Q"))
    body = EFF_BODY[E]
    out = dict(abs=[], impl=[], site=[], q=[], exports_abs=[], exports_impl=[], exports_site=[])
    if K in NONRECV_KINDS:
        F = f"F_{i}"
        fbody = body if N == "one" else "void 0;"
        out["impl"].append(f"export function {F}(): void {{ {fbody} }}")
        out["exports_impl"] += [F]
        if K == "static":
            out["site"].append(f"export function {S}(): void {{ {F}(); }}")
            out["q"].append(f"export function {Q}(): void {{ {S}(); }}")
            out["site_needs"] = ["impl"]
        elif K == "fnparam":
            out["site"].append(f"export function {S}(f: () => void): void {{ f(); }}")
            out["q"].append(f"export function {Q}(): void {{ {S}({F}); }}")
            out["site_needs"] = []
        elif K == "fnreg":
            RG = f"REG_{i}"
            out["abs"].append(f"export const {RG} = new Map<string, () => void>();")
            out["exports_abs"] += [RG]
            out["impl"].append(f"export function reg_{i}(): void {{ {RG}.set(\"k\", {F}); }}")
            out["exports_impl"] += [f"reg_{i}"]
            out["site"].append(f"export function {S}(): void {{ const h = {RG}.get(\"k\"); if (h) h(); }}")
            out["q"].append(f"export function {Q}(): void {{ reg_{i}(); {S}(); }}")
            out["site_needs"] = ["abs"]
        out["site_fn"], out["q_fn"] = S, Q
        out["exports_site"] = [S]
        out["impl_needs"] = ["abs"] if K == "fnreg" else []
        out["q_needs"] = ["site", "impl"]
        return out
    kt = K_table(i)[K]
    asyn = kt.get("asyn", False)
    eb = body
    pb = "void 0;"
    def cls_body(b, extends=None, implements=None):
        mem = kt["impl"](b)
        extra = kt.get("extra_impl", "")
        if extends and kt.get("undeclared") and R == "cls":
            extra = ""  # a concrete base already supplies tag_
        hdr = f"export class {{name}}" + (f" extends {extends}" if extends else "") + (f" implements {implements}" if implements else "")
        return hdr + " { " + mem + (" " + extra if extra else "") + " }"
    eff_N = N in ("one", "mix")
    has_P = N in ("mix", "pure", "sib")
    has_E = N in ("one", "mix", "sib")
    # abstraction
    if R in ("iface", "struct", "objlit", "gen", "any", "field", "conc", "union"):
        out["abs"].append(f"export interface {A} {{ {kt['a']} }}")
        out["exports_abs"] += [A]
        tyname = A
    if R in ("cls", "abs"):
        if R == "cls":
            out["abs"].append(f"export class {B} {{ {kt['base']} }}")
        else:
            out["abs"].append(f"export abstract class {B} {{ {kt['abs']} }}")
        out["exports_abs"] += [B]
        tyname = B
    # implementors
    def mk(name, b):
        if R in ("iface", "any", "gen", "field", "conc", "union"):
            return cls_body(b, implements=A).replace("{name}", name)
        if R == "struct":
            return cls_body(b).replace("{name}", name)
        if R in ("cls", "abs"):
            return cls_body(b, extends=B).replace("{name}", name)
        if R == "objlit":
            mem = kt["obj"](b); extra = kt.get("extra_obj", "")
            # two-step so the undeclared-member literal is not an excess-property error (no cast involved)
            return (f"const {name}_lit = {{ {mem}{', ' + extra if extra else ''} }};\n"
                    f"export const {name}: {A} = {name}_lit;")
    if has_E:
        out["impl"].append(mk(Ec, eb)); out["exports_impl"].append(Ec)
    if has_P:
        out["impl"].append(mk(Pc, pb)); out["exports_impl"].append(Pc)
    out["impl_needs"] = ["abs"]
    # receiver type at the site
    rty = {"iface": A, "struct": A, "objlit": A, "any": "any", "field": A, "cls": B, "abs": B, "gen": "T",
           "conc": Ec if N == "one" else Pc, "union": f"{Ec} | {Pc}"}[R]
    if N == "sib": rty = Pc
    expr = kt["expr"]("x")
    a_kw = "async " if asyn else ""
    ret = "Promise<void>" if asyn else "void"
    if R == "field":
        fexpr = kt["expr"]("this.f")
        out["site"].append(f"export class {H} {{ constructor(private f: {A}) {{}} {a_kw}run(): {ret} {{ {fexpr} }} }}")
        site_fn = f"{H}.run"
        out["exports_site"] += [H]
    else:
        gen = f"<T extends {A}>" if R == "gen" else ""
        out["site"].append(f"export {a_kw}function {S}{gen}(x: {rty}): {ret} {{ {expr} }}")
        site_fn = S
        out["exports_site"] += [S]
    out["site_needs"] = ["abs"] + (["impl"] if R in ("conc", "union") or N == "sib" else [])
    # consumer
    runtime = Ec if eff_N else Pc
    val = runtime if R == "objlit" else f"new {runtime}()"
    if R == "field":
        call = f"new {H}({val}).run()"
    else:
        call = f"{S}({val})"
    if asyn:
        out["q"].append(f"export async function {Q}(): Promise<void> {{ await {call}; }}")
    else:
        out["q"].append(f"export function {Q}(): void {{ {call}; }}")
    out["q_needs"] = ["site", "impl"]
    out["site_fn"], out["q_fn"] = site_fn, Q
    return out

# ---------------------------------------------------------------- JS fragments (plain JS, CommonJS)
def js_fragments(cid, K, R, N, E):
    i = cid
    B, Ec, Pc, S, Q = (f"{p}_{i}" for p in ("B", "E", "P", "S", "Q"))
    body = EFF_BODY[E]
    out = dict(abs=[], impl=[], site=[], q=[], exports_abs=[], exports_impl=[], exports_site=[])
    kt = K_table(i)[K]
    asyn = kt.get("asyn", False)
    has_P = N in ("mix", "pure", "sib"); has_E = N in ("one", "mix", "sib")
    eff_N = N in ("one", "mix")
    pb = "void 0;"
    expr = kt.get("jsexpr", kt["expr"])("x")
    expr = expr.replace(" as any", "")
    kind_cls = R.startswith("jcls")
    if kind_cls:
        basemem = kt["base"]
        # strip TS types from the base member (simple, generator-controlled shapes)
        out["abs"].append(f"class {B} {{ {js_strip(basemem)} }}"); out["exports_abs"] += [B]
        def mk(name, b):
            mem = kt["js"](b); extra = kt.get("extra_js", "") if not kt.get("undeclared") else ""
            return f"class {name} extends {B} {{ {mem} {extra} }}"
        doc_ty = B if N != "sib" else Pc
    elif R.startswith("jproto"):
        def mk(name, b):
            fn = kt.get("jsfn")
            if kt.get("jsgetter"):
                return (f"function {name}() {{}}\nObject.defineProperty({name}.prototype, \"{kt['jsgetter']}\", "
                        f"{{ get: function () {{ {b} return 1; }} }});")
            if kt.get("jsfield"):
                return f"function {name}() {{ this.{kt['jsfield']} = () => {{ {b} }}; }}"
            key = kt.get("jskey")
            lhs = f"{name}.prototype[{key}]" if key else f"{name}.prototype.{kt['jsname']}"
            extra = f"\n{name}.prototype.tag_{i} = function () {{ return 1; }};" if kt.get("undeclared") else ""
            return f"function {name}() {{}}\n{lhs} = {fn(b)};{extra}"
        doc_ty = Ec if eff_N else Pc
    elif R == "jobj_untyped":
        def mk(name, b):
            mem = kt["js"](b)
            if kt.get("jsfield"): mem = f"{kt['jsfield']}: () => {{ {b} }}"
            extra = kt.get("extra_js", "")
            return f"const {name} = {{ {mem}{', ' + extra if extra else ''} }};"
        doc_ty = None
    elif R == "jmixin_untyped":
        def mk(name, b):
            mem = kt["js"](b)
            if kt.get("jsfield"):
                return f"class {name} {{ constructor() {{ Object.assign(this, {{ {kt['jsfield']}: () => {{ {b} }} }}); }} }}"
            return f"class {name} {{}}\nObject.assign({name}.prototype, {{ {mem} }});"
        doc_ty = None
    if has_E: out["impl"].append(mk(Ec, body)); out["exports_impl"].append(Ec)
    if has_P: out["impl"].append(mk(Pc, pb)); out["exports_impl"].append(Pc)
    out["impl_needs"] = ["abs"] if kind_cls else []
    doc = f"/** @param {{{doc_ty}}} x */\n" if (R.endswith("_doc") and doc_ty) else ""
    a_kw = "async " if asyn else ""
    out["site"].append(f"{doc}{a_kw}function {S}(x) {{ {expr} }}"); out["exports_site"] += [S]
    out["site_needs"] = (["abs"] if kind_cls else []) + (["impl"] if doc and not kind_cls else []) + (["impl"] if N == "sib" else [])
    runtime = Ec if eff_N else Pc
    val = runtime if R == "jobj_untyped" else f"new {runtime}()"
    if asyn: out["q"].append(f"async function {Q}() {{ await {S}({val}); }}")
    else: out["q"].append(f"function {Q}() {{ {S}({val}); }}")
    out["q_needs"] = ["site", "impl"]
    out["site_fn"], out["q_fn"] = S, Q
    return out

def js_strip(s):
    import re
    s = re.sub(r"\): [A-Za-z<>\[\]]+ \{", ") {", s)
    s = re.sub(r"\(r: \(v: number\) => void\)", "(r)", s)
    s = re.sub(r" = \(\): void =>", " = () =>", s)
    return s

# ---------------------------------------------------------------- locations
# Each location maps the four roles to (package, file). "C" = the scanned consumer, "D" = the dependency.
LOCS_TS = {
    "same":   dict(abs=("C", "x"), impl=("C", "x"), site=("C", "x"), q=("C", "x")),
    "mod":    dict(abs=("C", "a"), impl=("C", "i"), site=("C", "s"), q=("C", "q")),
    "dimp":   dict(abs=("D", "x"), impl=("D", "x"), site=("C", "x"), q=("C", "x")),
    "dsite":  dict(abs=("D", "x"), impl=("C", "x"), site=("D", "x"), q=("C", "x")),
}

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh: fh.write(text)

def tsconfig(allow_js):
    return json.dumps({"compilerOptions": {"target": "ES2022", "module": "commonjs", "outDir": "build", "rootDir": "src",
                                           "strict": False, "noEmitOnError": False, "skipLibCheck": True,
                                           "esModuleInterop": True, "declaration": True, "allowJs": allow_js,
                                           "checkJs": False, "types": ["node"], "lib": ["ES2022", "DOM"]},
                       "include": ["src"]}, indent=1)

def main():
    shutil.rmtree(W, ignore_errors=True)
    cells = []
    cid = 0
    # project buffers: proj -> file -> list of (role, cell, text)
    files = {}
    def add(proj, fname, cell, role, text):
        files.setdefault(proj, {}).setdefault(fname, []).append((cell, role, text))
    LANGS = [("ts", R_TS, list(LOCS_TS)), ("js", R_JS, ["same", "mod", "dimp"])]
    for lang, Rs, Ls in LANGS:
        for L in Ls:
            Es = ["Fs", "Net", "Exec"] if L in ("same", "dimp") else ["Fs"]
            kinds = RECV_KINDS + (NONRECV_KINDS if lang == "ts" else [])
            for K, E in itertools.product(kinds, Es):
                combos = []
                if K in NONRECV_KINDS:
                    if L == "dsite" and K == "static": continue
                    combos = [("-", "one"), ("-", "pure")]
                else:
                    combos = [(R, N) for R in Rs for N in N_ALL if rn_ok(R, N, L) and rk_ok(R, K)]
                for R, N in combos:
                    if lang == "js" and K in ("xtostr_u", "tpl_u") and R.startswith("jproto"): pass
                    cid += 1
                    i = f"{cid:05d}"
                    fr = (js_fragments if lang == "js" else ts_fragments)(i, K, R, N, E)
                    kt = K_table(i).get(K, {})
                    cell = dict(id=i, lang=lang, L=L, K=K, R=R, N=N, E=E, expect_effect=effect_happens(N),
                                site_fn=fr["site_fn"], q_fn=fr["q_fn"], wait=kt.get("wait", 0) if K in RECV_KINDS else 0,
                                site_in_consumer=(LOCS_TS[L]["site"][0] == "C"))
                    cells.append(cell)
                    loc = LOCS_TS[L]
                    ext = ".js" if lang == "js" else ".ts"
                    for role in ("abs", "impl", "site", "q"):
                        pkg, f = loc[role]
                        fname = f"c{i}_{f}{ext}"
                        for t in fr[role]:
                            add((lang, L, pkg), fname, cell, role, t)
                    cell["_fr"] = fr
    # emit packages
    for (lang, L, pkg), fmap in files.items():
        pass
    emit(cells, files)
    with open(os.path.join(W, "cells.jsonl"), "w") as fh:
        for c in cells:
            c2 = {k: v for k, v in c.items() if k != "_fr"}
            fh.write(json.dumps(c2) + "\n")
    print("cells", len(cells))

def emit(cells, files):
    byid = {c["id"]: c for c in cells}
    # roles -> which file of which package each cell's role landed in
    for c in cells:
        loc = LOCS_TS[c["L"]]
        ext = ".js" if c["lang"] == "js" else ".ts"
        c["_where"] = {r: (loc[r][0], f"c{c['id']}_{loc[r][1]}{ext}") for r in ("abs", "impl", "site", "q")}
    for (lang, L, pkg), fmap in files.items():
        depname = f"dep{L}{lang}"            # e.g. depdimpts
        root = os.path.join(W, "dep", depname) if pkg == "D" else os.path.join(W, "src-" + f"{lang}-{L}")
        for fname, items in fmap.items():
            c = items[0][0]
            ext = ".js" if lang == "js" else ".ts"
            effs = sorted({it[0]["E"] for it in items})
            hdr = []
            # imports of node effect modules
            for E in effs:
                hdr.append(EFF_REQUIRE[E] if lang == "js" else EFF_IMPORT[E])
            roles_here = {it[1] for it in items}
            # cross-file imports for this cell
            needs = set()
            for role in roles_here:
                needs |= set(c["_fr"].get(role + "_needs", []))
            for need in sorted(needs):
                wp, wf = c["_where"][need]
                if (wp, wf) == (pkg, fname): continue
                names = c["_fr"]["exports_" + need] if need != "site" else c["_fr"]["exports_site"]
                if not names: continue
                spec = ("./" + wf[:-3]) if wp == pkg else depname
                if lang == "js":
                    hdr.append(f"const {{ {', '.join(names)} }} = require(\"{spec}\");")
                else:
                    hdr.append(f"import {{ {', '.join(names)} }} from \"{spec}\";")
            body = []
            exported = []
            for (cc, role, t) in items:
                body.append(t)
                if lang == "js":
                    exported += cc["_fr"]["exports_" + role] if role != "q" else [cc["q_fn"]]
            if lang == "js":
                body.append(f"module.exports = {{ {', '.join(dict.fromkeys(exported))} }};")
            write(os.path.join(root, "src", fname), "\n".join(hdr) + "\n" + "\n".join(body) + "\n")
        # index for deps
    # dep packages: index re-exporting everything + package.json + tsconfig
    for (lang, L, pkg), fmap in files.items():
        if pkg != "D": continue
        depname = f"dep{L}{lang}"
        root = os.path.join(W, "dep", depname)
        ext = ".js" if lang == "js" else ".ts"
        mods = sorted(fmap)
        if lang == "js":
            idx = "module.exports = Object.assign({}, " + ", ".join(f'require("./{m[:-3]}")' for m in mods) + ");\n"
        else:
            idx = "".join(f'export * from "./{m[:-3]}";\n' for m in mods)
        write(os.path.join(root, "src", "index" + ext), idx)
        write(os.path.join(root, "package.json"), json.dumps({"name": depname, "version": "1.0.0", "main": "build/index.js",
                                                              "types": "build/index.d.ts"}))
        write(os.path.join(root, "tsconfig.json"), tsconfig(lang == "js"))
    # consumer projects
    for (lang, L, pkg), fmap in files.items():
        if pkg != "C": continue
        root = os.path.join(W, "src-" + f"{lang}-{L}")
        write(os.path.join(root, "package.json"), json.dumps({"name": f"app{L}{lang}", "version": "1.0.0",
              **({"dependencies": {f"dep{L}{lang}": "1.0.0"}} if L in ("dimp", "dsite") else {})}))
        write(os.path.join(root, "tsconfig.json"), tsconfig(lang == "js"))
    # where to find Q at runtime
    for c in cells:
        wp, wf = c["_where"]["q"]
        c["q_module"] = os.path.join("src-" + f"{c['lang']}-{c['L']}", "build", wf.rsplit(".", 1)[0] + ".js")

if __name__ == "__main__":
    # main() writes cells.jsonl after emit() has filled q_module
    main()
