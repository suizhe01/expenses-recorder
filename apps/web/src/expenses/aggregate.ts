import type { Expense } from "@/api/expenses";
import { categoryColor } from "@/lib/palette";

export type Overview = {
  currencies: string[];
  currency: string;
  totalCents: number;
  previousTotalCents: number;
  percentChange?: number;
  categories: { id: string; name: string; count: number; totalCents: number }[];
  averageMonthlyCents: number;
  busiestDay?: string;
};

export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function previousMonth(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return value === 1
    ? `${year! - 1}-12`
    : `${year!}-${String(value! - 1).padStart(2, "0")}`;
}

export function overviewFor(
  expenses: readonly Expense[],
  month: string,
  requestedCurrency?: string,
): Overview | undefined {
  if (expenses.length === 0) return undefined;
  const counts = new Map<string, number>();
  expenses.forEach(({ currency }) =>
    counts.set(currency, (counts.get(currency) ?? 0) + 1),
  );
  const currencies = [...counts.keys()].sort();
  const currency =
    requestedCurrency && counts.has(requestedCurrency)
      ? requestedCurrency
      : [...counts.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0]![0];
  const active = expenses.filter((expense) => expense.currency === currency);
  const selected = active.filter(
    (expense) => expense.purchasedOn.slice(0, 7) === month,
  );
  const previous = active.filter(
    (expense) => expense.purchasedOn.slice(0, 7) === previousMonth(month),
  );
  const totalCents = sum(selected);
  const previousTotalCents = sum(previous);
  const categoryMap = new Map<
    string,
    { id: string; name: string; count: number; totalCents: number }
  >();
  selected.forEach((expense) => {
    const entry = categoryMap.get(expense.category.id) ?? {
      id: expense.category.id,
      name: expense.category.name,
      count: 0,
      totalCents: 0,
    };
    entry.count += 1;
    entry.totalCents += expense.totalCents;
    categoryMap.set(expense.category.id, entry);
  });
  const months = new Map<string, number>();
  active.forEach((expense) => {
    const key = expense.purchasedOn.slice(0, 7);
    months.set(key, (months.get(key) ?? 0) + expense.totalCents);
  });
  const weekdayCounts = new Map<string, number>();
  selected.forEach((expense) => {
    const [year, dateMonth, day] = expense.purchasedOn.split("-").map(Number);
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year!, dateMonth! - 1, day!)));
    weekdayCounts.set(weekday, (weekdayCounts.get(weekday) ?? 0) + 1);
  });
  return {
    currencies,
    currency,
    totalCents,
    previousTotalCents,
    percentChange:
      previousTotalCents > 0
        ? Math.round(
            ((totalCents - previousTotalCents) / previousTotalCents) * 100,
          )
        : undefined,
    categories: [...categoryMap.values()].sort(
      (a, b) => b.totalCents - a.totalCents,
    ),
    averageMonthlyCents: months.size
      ? Math.round(sum([...months.values()]) / months.size)
      : 0,
    busiestDay: [...weekdayCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0],
  };
}

export type DonutSlice = {
  id: string;
  name: string;
  totalCents: number;
  count: number;
  color: string;
  other?: boolean;
};

/** Folds the summary into six identity-coloured categories plus neutral Other. */
export function donutSlices(categories: Overview["categories"]): DonutSlice[] {
  const top = categories
    .slice(0, 6)
    .map((category) => ({
      ...category,
      color: categoryColor(categorySlot(category.id) - 1),
    }));
  const rest = categories.slice(6);
  if (rest.length === 0) return top;
  return [
    ...top,
    {
      id: "other",
      name: "Other",
      count: rest.reduce((total, slice) => total + slice.count, 0),
      totalCents: rest.reduce((total, slice) => total + slice.totalCents, 0),
      color: "var(--cat-other)",
      other: true,
    },
  ];
}

function categorySlot(identity: string): number {
  return (
    ([...identity].reduce(
      (hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0,
      0,
    ) %
      6) +
    1
  );
}

function sum(rows: readonly Expense[] | readonly number[]): number {
  return rows.reduce<number>(
    (total, row) => total + (typeof row === "number" ? row : row.totalCents),
    0,
  );
}
