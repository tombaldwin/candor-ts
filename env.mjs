// THE ONE PLACE THIS ENGINE READS ITS ENVIRONMENT (SPEC §3.4 ⟨0.42⟩, SOUNDNESS R1634).
//
// Every `process.env` access in the engine goes through a function below, and `test-env-lint.mjs` fails the suite on
// any other. That is what makes the clause enforceable without a list: SPEC §3.4 says "the registration is the read",
// because a list of switch names beside the code that reads them is an allowlist, and it fails in the absence
// direction — a switch added without its entry is exactly the silent one. Here the read IS the registration: there
// is no table of names in this file.
//
// FOUR KINDS OF READ, and the kind is chosen at the call site by what the variable does:
//   envSwitch(name, isSet)  a RESULT-MOVING switch — a kill switch for a closed defect, an opt-in mode: its value
//                           selects which logic runs. When the value, as the caller reads it, selects a branch other
//                           than the one an unset variable selects (`isSet`), the name is recorded. Recorded names
//                           are the report's `switches` (§2) and make a gate refuse (§3.3 cause (e)).
//   envTrace(name)          a DIAGNOSTIC — the value only decides whether something is written to stderr. No report
//                           or verdict byte can depend on it, so nothing is recorded (§3.4: "a read that only writes to
//                           stderr is out of scope"). A trace read that moves a result is a switch: reclassify it.
//   envOperator(name)       an INPUT the operator documents — a path to a policy, baseline, dependency report or
//                           configuration file, the report locator, a tooling knob. Configuration, out of scope (§3.4).
//   childEnv(extra)         the whole environment handed to a child process the engine starts. An enumeration, so it
//                           lives here too; it reads nothing on behalf of this process's answer.
// An engine MUST NOT read every switch at process start (§3.4 (a)): a read happens where the logic that the variable
// selects is reached, and a name is consulted only when that read executes.
const consulted = new Set();

/** @param {string} name  @param {(v: string|undefined) => boolean} [isSet]  default: any non-empty value. Returns the raw value. */
export function envSwitch(name, isSet = (v) => v !== undefined && v !== "") {
  const v = process.env[name];
  if (isSet(v)) consulted.add(name);
  return v;
}
export function envTrace(name) { return process.env[name]; }
export function envOperator(name) { return process.env[name]; }
export function childEnv(extra = {}) { return { ...process.env, ...extra }; }

/** The switches set AND consulted by THIS process so far, sorted by code point, no duplicates (§2 `switches`). */
export function consultedSwitches() {
  return [...consulted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Test seam: forget what was consulted (an in-process harness that runs several scans). */
export function resetConsultedSwitches() { consulted.clear(); }

/** The refusal's `reason` (§3.3 (e), §3.1: a refusal always says why): names the switches and says to unset them. */
export function switchRefusalReason(names) {
  return `a result-moving switch is set: ${names.join(", ")} — the answer depends on an environment variable that `
    + `selects which logic ran, so the gate cannot say whether the code passes (SPEC §3.4). Unset ${names.length === 1 ? "it" : "them"} and re-run.`;
}

/** Install `make(rawEnv)` as `process.env` (the `candor-ts-verify` preload wraps the app's environment to witness reads). */
export function wrapProcessEnv(make) {
  Object.defineProperty(process, "env", { value: make(process.env), configurable: true });
}

/** SPEC §3.4 (d): `[{ package, switches }]` from package -> Set of names, ordered by package, names sorted (code point). */
export function switchedDependenciesOf(byPackage) {
  const c = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byPackage.entries()].sort((x, y) => c(x[0], y[0]))
    .map(([pkg, names]) => ({ package: pkg, switches: [...names].sort(c) }));
}
