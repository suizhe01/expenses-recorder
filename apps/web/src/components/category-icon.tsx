import { createElement } from 'react';
import { categoryIcon } from '@/lib/category-icon';

/**
 * Draws the icon derived from a category's name.
 *
 * A component rather than an inline lookup at each call site: resolving the
 * icon and rendering `<Icon />` inside JSX would define a component during
 * render, which `react-hooks/static-components` rejects and which costs React
 * the ability to reconcile it across renders.
 *
 * Always `aria-hidden`. The icon is decoration beside a name that is always
 * shown, so announcing it would only repeat the label.
 */
export function CategoryIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  // `createElement` rather than `<Icon />` on a looked-up local: rendering a
  // dynamic component through JSX reads to `react-hooks/static-components` as a
  // component defined during render. The icon is chosen from a fixed module-level
  // map, so nothing is actually being created here.
  return createElement(categoryIcon(name), { className, 'aria-hidden': true });
}
