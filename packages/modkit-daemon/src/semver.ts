/**
 * One semver implementation for the daemon. `generate.ts` and `source.ts` each need to parse and
 * compare bare `major.minor.patch` versions — a target's installed version, a resolved tag, a
 * model's claimed range — and used to carry their own copies of the same three functions.
 *
 * Deliberately not a real semver parser: pre-release/build metadata is ignored, and anything that
 * does not start with `\d+.\d+.\d+` is simply not a version. That is enough for every caller here,
 * both of which are comparing versions read off a manifest or a git tag, not parsing an arbitrary
 * range expression.
 */

export type SemverTuple = [number, number, number];

export function parseSemver(v: string): SemverTuple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function cmpSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function maxSemver(a: string, b: string): string {
  return cmpSemver(a, b) >= 0 ? a : b;
}
