import {
  Bolt,
  Bus,
  Clapperboard,
  GraduationCap,
  HeartPulse,
  ShoppingBag,
  ShoppingCart,
  Tag,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';

/**
 * A category's icon is **derived from its name**, never stored.
 *
 * The same choice `palette.ts` makes for colour: `categories` has no icon
 * column, so nothing has to be migrated, and a category created on any client
 * is drawn consistently everywhere without a round trip.
 *
 * The cost is honest and bounded: a name this map does not know falls back to a
 * neutral tag, and renaming a category can change its icon. Both are acceptable
 * because the icon is decoration beside a name that is always shown — it never
 * carries meaning on its own, so a generic icon loses nothing an accessible
 * label would have provided.
 *
 * Keys are matched case-insensitively against the trimmed name, so `food`,
 * `Food` and ` FOOD ` agree. The nine seeded defaults are all covered; the
 * aliases beyond them are common synonyms a user is likely to type.
 */
const ICONS: Record<string, LucideIcon> = {
  food: UtensilsCrossed,
  dining: UtensilsCrossed,
  restaurant: UtensilsCrossed,
  groceries: ShoppingCart,
  grocery: ShoppingCart,
  transport: Bus,
  transportation: Bus,
  travel: Bus,
  medical: HeartPulse,
  health: HeartPulse,
  education: GraduationCap,
  utilities: Bolt,
  bills: Bolt,
  shopping: ShoppingBag,
  entertainment: Clapperboard,
};

/** The neutral fallback, and what `Other` deliberately resolves to. */
export const FALLBACK_CATEGORY_ICON: LucideIcon = Tag;

export function categoryIcon(name: string): LucideIcon {
  return ICONS[name.trim().toLowerCase()] ?? FALLBACK_CATEGORY_ICON;
}
