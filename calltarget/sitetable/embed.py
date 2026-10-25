#!/usr/bin/env python3
"""Embed the executed site table into scan.mjs (between the `// <<CT-SITE-TABLE` and `// CT-SITE-TABLE>>` markers),
marking each row 0.40.17's hand lists recognised (`r0`), so the CANDOR_CT2_OFF switch can restrict the table to them,
and printing the CALIBRATION: every 0.40.17 hand entry must be reproduced by an executed row with the same hooks, or
the embed refuses.

    node calltarget/sitetable/oracle.cjs > /tmp/t.json && python3 calltarget/sitetable/embed.py /tmp/t.json scan.mjs
"""
import json, sys

COERCE = ["[Symbol.toPrimitive]", "toString", "valueOf"]
# 0.40.17's hand lists, as table rows (key, role/arg, shape, the hooks that list resolved). Written down HERE, once,
# so the calibration can be checked; the engine no longer carries them.
ARITH = ["MinusToken", "AsteriskToken", "SlashToken", "PercentToken", "AsteriskAsteriskToken", "LessThanToken",
         "GreaterThanToken", "LessThanEqualsToken", "GreaterThanEqualsToken", "AmpersandToken", "BarToken", "CaretToken",
         "LessThanLessThanToken", "GreaterThanGreaterThanToken", "GreaterThanGreaterThanGreaterThanToken"]
COMPOUND_ARITH = ["MinusEqualsToken", "AsteriskEqualsToken", "SlashEqualsToken", "PercentEqualsToken", "AsteriskAsteriskEqualsToken"]
LEGACY_SYNTAX = [(f"BinaryExpression:{t}", r, COERCE) for t in ["PlusToken", "PlusEqualsToken"] + ARITH + COMPOUND_ARITH for r in ("left", "right")]
LEGACY_SYNTAX += [(f"PrefixUnaryExpression:{t}", "operand", COERCE) for t in ("PlusToken", "MinusToken", "TildeToken")]
LEGACY_SYNTAX += [("TemplateExpression", "span", COERCE), ("ForOfStatement", "expression", ["[Symbol.iterator]"]),
                  ("ForOfStatement:await", "expression", ["[Symbol.asyncIterator]", "[Symbol.iterator]"]),
                  ("SpreadElement", "expression", ["[Symbol.iterator]"]), ("SpreadElement:call", "expression", ["[Symbol.iterator]"]),
                  ("ArrayBindingPattern", "initializer", ["[Symbol.iterator]"]), ("SpreadAssignment", "expression", ["get:own"]),
                  ("ObjectBindingPattern:rest", "initializer", ["get:own"]),
                  ("VariableDeclarationList:using", "initializer", ["[Symbol.dispose]"]),
                  ("VariableDeclarationList:await-using", "initializer", ["[Symbol.asyncDispose]", "[Symbol.dispose]"])]
LEGACY_BUILTINS = [("StringConstructor.(call)", 0, "", COERCE), ("JSON.stringify", 0, "", ["get:own", "toJSON"]),
                   ("ObjectConstructor.assign", 0, "", ["set:own", "set:proto"]), ("ObjectConstructor.assign", 1, "", ["get:own"]),
                   ("ObjectConstructor.assign", 2, "", ["get:own"]),
                   ("ObjectConstructor.entries", 0, "", ["get:own"]), ("ObjectConstructor.values", 0, "", ["get:own"]),
                   ("structuredClone", 0, "", ["get:own"]), ("Reflect.get", 0, "", ["get:own", "get:proto"]),
                   ("Reflect.set", 0, "", ["set:own", "set:proto"]), ("ArrayConstructor.from", 0, "", ["[Symbol.iterator]"])]
# `arr.join()` / `arr.toString()` / `arr.toLocaleString()` coerced the ELEMENTS with toString/valueOf; the oracle says
# `toLocaleString` runs the elements' `toLocaleString` (whose inherited body calls `toString`) — a calibration
# DIFFERENCE, accepted and printed: the table's hooks are what executes.
LEGACY_BUILTINS += [(f"{a}.{m}", "this", "[]", COERCE) for a in ("Array", "ReadonlyArray") for m in ("join", "toString")]
LEGACY_BUILTINS += [(f"{a}.toLocaleString", "this", "[]", ["toLocaleString", "toString"]) for a in ("Array", "ReadonlyArray")]

def main():
    t = json.load(open(sys.argv[1])); scan = sys.argv[2]
    bad = 0
    for key, role, hooks in LEGACY_SYNTAX:
        row = t["syntax"].get(key, {})
        got = row.get(role)
        ok = got is not None and set(hooks) <= set(got)
        print(("OK   " if ok else "MISS ") + f"syntax {key}.{role}: 0.40.17 {hooks} / table {got}")
        bad += not ok
        if ok: row.setdefault("r0", []).append(role)
    for key, arg, shape, hooks in LEGACY_BUILTINS:
        rows = [r for r in t["builtins"].get(key, []) if r["arg"] == arg and r["shape"] == shape]
        ok = bool(rows) and set(hooks) <= set(rows[0]["hooks"])
        print(("OK   " if ok else "MISS ") + f"builtin {key} {arg}{shape}: 0.40.17 {hooks} / table {rows[0]['hooks'] if rows else None}")
        bad += not ok
        if ok: rows[0]["r0"] = True
    ns = sum(len([r for r in v if r not in ("source", "r0")]) for v in t["syntax"].values())
    nb = sum(len(v) for v in t["builtins"].values())
    print(f"calibration: {len(LEGACY_SYNTAX) + len(LEGACY_BUILTINS)} 0.40.17 entries, {bad} not reproduced; "
          f"table {len(t['syntax'])} syntax keys ({ns} roles), {len(t['builtins'])} builtins ({nb} rows)")
    if bad: sys.exit("REFUSED: a 0.40.17 entry is not reproduced by an executed row")
    s = open(scan).read()
    a = s.index("// <<CT-SITE-TABLE"); b = s.index("// CT-SITE-TABLE>>")
    head = s[a:s.index("\n", a) + 1]
    body = "const CT_SITE_TABLE = {\n" + f' "generatedBy": {json.dumps(t["generatedBy"])}, "node": {json.dumps(t["node"])},\n'
    body += ' "syntax": {\n' + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in t["syntax"].items()) + "\n },\n"
    body += ' "builtins": {\n' + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in t["builtins"].items()) + "\n }\n};\n"
    open(scan, "w").write(s[:a] + head + body + s[b:])
    print("embedded into", scan)

if __name__ == "__main__":
    main()
