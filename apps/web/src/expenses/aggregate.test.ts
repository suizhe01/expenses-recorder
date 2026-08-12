import { describe, expect, it } from "vitest";
import type { Expense } from "@/api/expenses";
import { donutSlices, overviewFor, previousMonth } from "./aggregate";

const blank = { purchasedAtTime: null, subtotalCents: null, taxCents: null, roundingCents: null, merchantTaxId: null, paymentMethod: null, createdAt: "", updatedAt: "" };

const rows: Expense[] = [
  {
    id: "1",
    category: { id: "food", name: "Food" },
    receiptId: null,
    totalCents: 1200,
    purchasedOn: "2026-08-01",
    currency: "MYR",
    merchantName: null,
    receiptNumber: null,
    note: null,
    ...blank,
  },
  {
    id: "2",
    category: { id: "food", name: "Food" },
    receiptId: null,
    totalCents: 800,
    purchasedOn: "2026-08-02",
    currency: "MYR",
    merchantName: null,
    receiptNumber: null,
    note: null,
    ...blank,
  },
  {
    id: "3",
    category: { id: "travel", name: "Travel" },
    receiptId: null,
    totalCents: 1000,
    purchasedOn: "2026-07-31",
    currency: "MYR",
    merchantName: null,
    receiptNumber: null,
    note: null,
    ...blank,
  },
  {
    id: "4",
    category: { id: "food", name: "Food" },
    receiptId: null,
    totalCents: 9999,
    purchasedOn: "2026-08-01",
    currency: "SGD",
    merchantName: null,
    receiptNumber: null,
    note: null,
    ...blank,
  },
];
describe("overview aggregation", () => {
  it("uses YYYY-MM-DD strings, keeps currencies separate, and derives every figure", () => {
    const result = overviewFor(rows, "2026-08", "MYR")!;
    expect(result).toMatchObject({
      totalCents: 2000,
      previousTotalCents: 1000,
      percentChange: 100,
      averageMonthlyCents: 1500,
      busiestDay: "Saturday",
      currencies: ["MYR", "SGD"],
    });
    expect(result.categories).toEqual([
      { id: "food", name: "Food", count: 2, totalCents: 2000 },
    ]);
    expect(previousMonth("2026-01")).toBe("2025-12");
  });
  it("does not produce a percentage when the previous month has no spending", () =>
    expect(
      overviewFor(
        rows.filter((row) => row.purchasedOn !== "2026-07-31"),
        "2026-08",
        "MYR",
      )!.percentChange,
    ).toBeUndefined());
  it("keeps the six largest categories and folds the remainder into Other", () => {
    const categories = Array.from({ length: 8 }, (_, index) => ({
      id: `category-${index}`,
      name: `Category ${index}`,
      count: 1,
      totalCents: (8 - index) * 100,
    }));
    const slices = donutSlices(categories);
    expect(slices).toHaveLength(7);
    expect(slices.slice(0, 6).map((slice) => slice.name)).toEqual([
      "Category 0",
      "Category 1",
      "Category 2",
      "Category 3",
      "Category 4",
      "Category 5",
    ]);
    expect(slices[6]).toMatchObject({
      id: "other",
      name: "Other",
      count: 2,
      totalCents: 300,
      color: "var(--cat-other)",
    });
  });
  it("keeps a category colour stable when its rank changes", () => {
    const alpha = { id: "alpha", name: "Alpha", count: 1, totalCents: 100 };
    const beta = { id: "beta", name: "Beta", count: 1, totalCents: 200 };
    const firstColor = donutSlices([alpha, beta]).find(
      (slice) => slice.id === alpha.id,
    )!.color;
    const secondColor = donutSlices([{ ...alpha, totalCents: 300 }, beta]).find(
      (slice) => slice.id === alpha.id,
    )!.color;
    expect(secondColor).toBe(firstColor);
  });
});
