export type DiffLine = { type: "same" | "add" | "del"; text: string };

/**
 * Simple LCS-based line diff. Returns null when the changed region is too
 * large to diff comfortably (caller should show a fallback message).
 */
export function diffLines(before: string, after: string, cap = 1200): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");

  // Trim common prefix/suffix so the DP only covers the changed region
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ca = a.slice(start, endA);
  const cb = b.slice(start, endB);
  if (ca.length > cap || cb.length > cap) return null;

  // LCS lengths
  const rows = ca.length + 1;
  const cols = cb.length + 1;
  const dp = new Uint32Array(rows * cols);
  for (let i = ca.length - 1; i >= 0; i--) {
    for (let j = cb.length - 1; j >= 0; j--) {
      dp[i * cols + j] =
        ca[i] === cb[j]
          ? dp[(i + 1) * cols + j + 1] + 1
          : Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  for (let k = 0; k < start; k++) out.push({ type: "same", text: a[k] });

  let i = 0;
  let j = 0;
  while (i < ca.length && j < cb.length) {
    if (ca[i] === cb[j]) {
      out.push({ type: "same", text: ca[i] });
      i++; j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      out.push({ type: "del", text: ca[i] });
      i++;
    } else {
      out.push({ type: "add", text: cb[j] });
      j++;
    }
  }
  while (i < ca.length) { out.push({ type: "del", text: ca[i] }); i++; }
  while (j < cb.length) { out.push({ type: "add", text: cb[j] }); j++; }

  for (let k = endA; k < a.length; k++) out.push({ type: "same", text: a[k] });
  return out;
}
