/**
 * Category identity maps to a fixed slot. Values beyond the six named slots
 * are intentionally folded into the neutral Other slot by chart renderers.
 */
export function categoryColor(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 5) {
    return 'var(--cat-other)';
  }

  return `var(--cat-${index + 1})`;
}
