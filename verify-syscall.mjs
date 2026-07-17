// candor verify — the SYSCALL capture front-end (RQ1 §A). The strongest oracle: a kernel/libc syscall trace
// is MECHANISM-INDEPENDENT — it observes effects BELOW the language runtime, so it can't share a runtime bug
// with the analyzer (or with the language-level Node capture in verify-preload.mjs). Its cost is attribution:
// mapping a syscall to a candor FUNCTION needs stack unwinding + symbolization (research-grade), so this slice
// delivers the mechanism-independent PROGRAM-LEVEL check — an effect that appears in the syscall trace but
// NOWHERE in candor's report (across all functions) is a program-wide false-pure — plus the syscall→effect map
// and trace parsers (strace / dtruss). Per-function syscall attribution (via `strace -k` stacks) is future work.
//
// The effect→observability mapping (which effects a syscall trace witnesses DIRECTLY): Net/Fs/Exec are clean;
// Env (getenv — a libc memory read) and Clock (clock_gettime — often served from the vDSO with no kernel trap)
// are INVISIBLE to a plain syscall trace, so the syscall oracle scopes its claim to {Net,Fs,Exec} (the same
// `direct` headline the language-level oracle uses). Db/Llm fold into Net (classified by destination elsewhere).

export const SYSCALL_DIRECT = ["Net", "Fs", "Exec"];

// A syscall NAME → candor effect. Curated for the direct set across Linux (strace) + macOS (dtruss) spellings.
// Not exhaustive — a curated, high-precision core; an unmapped syscall is simply not counted (disclosed).
export const SYSCALL_EFFECT = {
  // Net
  socket: "Net", connect: "Net", sendto: "Net", recvfrom: "Net", sendmsg: "Net", recvmsg: "Net",
  bind: "Net", listen: "Net", accept: "Net", accept4: "Net", getpeername: "Net",
  connectx: "Net", socket_delegate: "Net", // macOS spellings
  // Fs
  open: "Fs", openat: "Fs", open_nocancel: "Fs", read: "Fs", write: "Fs", pread64: "Fs", pwrite64: "Fs",
  pread: "Fs", pwrite: "Fs", stat: "Fs", stat64: "Fs", lstat: "Fs", lstat64: "Fs", fstat: "Fs", fstat64: "Fs",
  newfstatat: "Fs", fstatat64: "Fs", unlink: "Fs", unlinkat: "Fs", rename: "Fs", renameat: "Fs", renameat2: "Fs",
  mkdir: "Fs", mkdirat: "Fs", rmdir: "Fs", getdirentries64: "Fs", getdents64: "Fs", access: "Fs", faccessat: "Fs",
  // Exec
  execve: "Exec", execveat: "Exec", posix_spawn: "Exec", fork: "Exec", vfork: "Exec",
};

/** Map a raw syscall name → candor effect (null if not effect-bearing / not mapped). */
export function syscallEffect(name) {
  return SYSCALL_EFFECT[name] ?? null;
}

// Parse a plain `strace`/`strace -f` line: optional `[pid N] `, then `syscall(args) = ret`. `-f` prefixes pids;
// a resumed/unfinished line (`<unfinished ...>` / `<... resumed>`) still carries the syscall name up front.
const STRACE = /^(?:\[pid\s+\d+\]\s*)?(?:\d+\s+)?([a-z_][a-z0-9_]*)\(/i;
// Parse a `dtruss` line (macOS): whitespace, then `syscall(args) = ret`. dtruss also prints a header line and
// a leading PID/elapsed column in some modes; the syscall name is the first `word(` token.
const DTRUSS = /([a-z_][a-z0-9_]*)\(/i;

/** Parse a captured syscall trace (text) → the SET of candor effects it exhibits (in the direct scope). */
export function parseTrace(text, format) {
  const re = format === "dtruss" ? DTRUSS : STRACE;
  const effects = new Set();
  for (const line of text.split("\n")) {
    const m = format === "dtruss" ? re.exec(line.trim()) : re.exec(line);
    if (!m) continue;
    const eff = syscallEffect(m[1]);
    if (eff) effects.add(eff);
  }
  return effects;
}

/** The PROGRAM-LEVEL honesty check: an effect the syscall trace exhibits that appears NOWHERE in the report
 *  (across all functions, within the direct scope) is a program-wide false-pure — candor missed it entirely.
 *  `reportUnion` = the union of every fn's inferred effects. Returns { observed, reportUnion, escaped, holds }. */
export function programCheck(reportUnion, observed) {
  const scope = new Set(SYSCALL_DIRECT);
  const union = new Set([...reportUnion].filter((e) => scope.has(e)));
  const obs = new Set([...observed].filter((e) => scope.has(e)));
  // an Unknown ANYWHERE in the report discloses that candor could not see everything — so a syscall effect is
  // only an escape if candor claimed NO Unknown at all (a fully-resolved, complete program claim).
  const disclosed = reportUnion.has("Unknown");
  const escaped = disclosed ? [] : [...obs].filter((e) => !union.has(e)).sort();
  return {
    scope: "direct",
    observed: [...obs].sort(),
    reportUnion: [...union].sort(),
    disclosedUnknown: disclosed,
    escaped,
    honestyInvariantHolds: escaped.length === 0,
  };
}
