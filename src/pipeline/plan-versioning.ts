/**
 * Pure helpers for computing versioned plan/spec file paths.
 *
 * Version semantics:
 *   - lineage length 0 → next plan is v1 (no suffix; original path)
 *   - lineage length 1 → next plan is v2 (suffix "-v2")
 *   - lineage length N → next plan is v(N+1)
 *
 * No filesystem IO here. The controller (or future re-plan flow) is
 * responsible for actually writing the file at the returned path.
 */

/**
 * Suffix to insert into a plan/spec filename for the NEXT plan version.
 * Returns `''` (empty) for v1 so the original filename is preserved.
 */
export function nextPlanVersionSuffix(currentLineageLength: number): string {
  if (currentLineageLength <= 0) return '';
  // currentLineageLength = 1 → v2, = 2 → v3, ...
  return `-v${currentLineageLength + 1}`;
}

/**
 * Insert a version suffix into a `.md` (or any) path before the LAST extension.
 * Returns the original path unchanged for v1.
 *
 * Examples:
 *   versionedPlanPath('docs/plans/foo.md', 0) === 'docs/plans/foo.md'
 *   versionedPlanPath('docs/plans/foo.md', 1) === 'docs/plans/foo-v2.md'
 *   versionedPlanPath('docs/plans/foo.bar.md', 2) === 'docs/plans/foo.bar-v3.md'
 *   versionedPlanPath('docs/plans/PLAN_NO_EXT', 1) === 'docs/plans/PLAN_NO_EXT-v2'
 */
export function versionedPlanPath(originalPath: string, currentLineageLength: number): string {
  const suffix = nextPlanVersionSuffix(currentLineageLength);
  if (suffix === '') return originalPath;

  // Find the last '.' in the BASENAME (not in the directory portion). A path
  // like 'docs.v1/plans/foo' must not be mistaken for having a `.v1/...` ext.
  const lastSlash = Math.max(originalPath.lastIndexOf('/'), originalPath.lastIndexOf('\\'));
  const baseStart = lastSlash + 1;
  const lastDotInBase = originalPath.indexOf('.', baseStart) === -1
    ? -1
    : originalPath.lastIndexOf('.');

  if (lastDotInBase === -1 || lastDotInBase < baseStart) {
    // No extension on the basename — append the suffix at the end.
    return originalPath + suffix;
  }

  const stem = originalPath.slice(0, lastDotInBase);
  const ext = originalPath.slice(lastDotInBase);
  return stem + suffix + ext;
}
