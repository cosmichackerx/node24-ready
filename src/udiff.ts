/**
 * Unified diff for edits that replace lines in place (the line count never changes, which is all `--fix` does).
 * Output is accepted by `git apply` / `patch -p1`.
 */
export function unifiedDiff(file: string, before: string[], after: string[], context = 3): string {
  if (before.length !== after.length) throw new Error('unifiedDiff only supports in-place line replacements');
  const changed: number[] = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i);
  if (changed.length === 0) return '';
  const hunks: [number, number][] = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(before.length - 1, i + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = hi;
    else hunks.push([lo, hi]);
  }
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const [lo, hi] of hunks) {
    const count = hi - lo + 1;
    out.push(`@@ -${lo + 1},${count} +${lo + 1},${count} @@`);
    for (let i = lo; i <= hi; ) {
      if (before[i] === after[i]) {
        out.push(` ${before[i]}`);
        i++;
        continue;
      }
      let j = i; // a run of changed lines: all removals first, then all additions (like git diff)
      while (j <= hi && before[j] !== after[j]) j++;
      for (let k = i; k < j; k++) out.push(`-${before[k]}`);
      for (let k = i; k < j; k++) out.push(`+${after[k]}`);
      i = j;
    }
  }
  return out.join('\n') + '\n';
}
