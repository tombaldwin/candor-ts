// The candor-spec conformance cases in TypeScript — paired by bare function name with the Rust and
// Java fixtures; the expected effect sets are conformance/expected.json (the SAME oracle).
import * as fsm from "node:fs";
import * as netm from "node:net";
import * as cp from "node:child_process";

// --- one function per std-only effect ---
export function fs_read(): void { try { fsm.readFileSync("/tmp/x"); } catch {} }
export function net_connect(): void { try { netm.connect(1, "h"); } catch {} }
export function exec_spawn(): void { try { cp.spawn("x"); } catch {} }
export function env_read(): void { void process.env.X; }
export function clock_now(): void { void Date.now(); }

// --- purity (negative) ---
export function pure_fn(): number { return 1 + 2; }

// --- the Unknown trust contract: a function-valued field the engine cannot see through ---
class Holder { cb: () => void = () => {}; }
const h = new Holder();
export function unknown_dyn(): void { const cb = h.cb; cb(); }

// --- multi-effect union in one body ---
export function combined(): void { try { fsm.readFileSync("/tmp/x"); netm.connect(1, "h"); } catch {} }

// --- transitive propagation across a call ---
export function transitive_leaf(): void { try { fsm.readFileSync("/tmp/x"); } catch {} }
export function transitive_caller(): void { transitive_leaf(); }

// --- an effect inside a closure attributes to the enclosing function (SEMANTICS §2) ---
export function closure_effect(): void { const f = () => { try { fsm.readFileSync("/tmp/x"); } catch {} }; f(); }

// --- Unknown propagates like an effect ---
export function unknown_propagates(): void { unknown_dyn(); }

// --- mixed: a concrete effect AND an Unknown in one transitive set ---
export function mixed_unknown(): void { try { fsm.readFileSync("/tmp/x"); } catch {} unknown_dyn(); }

// --- a 3-hop chain a -> b -> c(Net) ---
export function hop_c(): void { try { netm.connect(1, "h"); } catch {} }
export function hop_b(): void { hop_c(); }
export function hop_a(): void { hop_b(); }

// --- a caller unions the effects of two distinct callees ---
export function union_b(): void { try { fsm.readFileSync("/tmp/x"); } catch {} }
export function union_c(): void { try { netm.connect(1, "h"); } catch {} }
export function union_a(): void { union_b(); union_c(); }

// --- recursion: the fixpoint must terminate AND keep the effect ---
export function recurse(n: number): void { if (n > 0) { void process.env.X; recurse(n - 1); } }

// --- an effect in one branch only is still inferred (over-approximation) ---
export function conditional(b: boolean): void { if (b) { try { cp.spawn("x"); } catch {} } }

// --- transitive purity: a -> b -> c, all pure, stays pure (negative) ---
export function pure_c(): number { return 3; }
export function pure_b(): number { return pure_c(); }
export function pure_a(): number { return pure_b(); }

// --- a method call on a concrete LOCAL-type receiver propagates the method's effect ---
export class Svc { act(): void { try { fsm.readFileSync("/tmp/x"); } catch {} } }
export function method_call(s: Svc): void { s.act(); }

// --- scheduler attribution: an effect inside a scheduled task attributes to the SCHEDULER ---
export function sched(): void { setTimeout(() => { try { fsm.readFileSync("/tmp/x"); } catch {} }, 0); }
