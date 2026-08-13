import { useState } from "react";
import type { DonutSlice } from "@/expenses/aggregate";

type DonutProps = {
  slices: DonutSlice[];
  totalLabel: string;
  formatAmount?: (cents: number) => string;
};
const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function CategoryDonut({
  slices,
  totalLabel,
  formatAmount = (cents) => `${cents.toLocaleString()} cents`,
}: DonutProps) {
  /**
   * The selected slice is held as an **id**, never as the slice object.
   *
   * Holding the object let a selection outlive the data it came from: switching
   * month replaced `slices` but not `active`, so the centre label kept the old
   * month's category and amount while `total` below recomputed for the new one.
   * August's Food (RM 85.90) against July's RM 7.90 total rendered as "1087%".
   *
   * Deriving it from the current `slices` makes that unrepresentable — a
   * selection that no longer exists simply falls back to the total label, and
   * one that still exists always reads the current month's amount.
   */
  const [activeId, setActiveId] = useState<string>();
  const active = slices.find((slice) => slice.id === activeId);
  if (slices.length === 0)
    return (
      <svg
        aria-label="No category spending this month"
        className="mx-auto block size-52"
        viewBox="0 0 120 120"
      >
        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
          className="text-muted"
        />
      </svg>
    );
  const total = slices.reduce((sum, slice) => sum + slice.totalCents, 0);
  return (
    <div className="mx-auto max-w-72">
      <svg
        role="img"
        aria-label="Category spending donut"
        className="mx-auto block size-52 overflow-visible"
        viewBox="0 0 120 120"
      >
        <title>Category spending for selected month</title>
        <g transform="rotate(-90 60 60)">
          {slices.map((slice, index) => {
            const length = (slice.totalCents / total) * CIRCUMFERENCE;
            const dash = `${Math.max(length - 1, 0)} ${CIRCUMFERENCE - length + 1}`;
            const currentOffset = -slices
              .slice(0, index)
              .reduce(
                (sum, previous) =>
                  sum + (previous.totalCents / total) * CIRCUMFERENCE,
                0,
              );
            const share = Math.round((slice.totalCents / total) * 100);
            return (
              <circle
                key={slice.id}
                role="button"
                tabIndex={0}
                aria-label={`${slice.name}: ${share}%`}
                cx="60"
                cy="60"
                r={RADIUS}
                fill="none"
                stroke={slice.color}
                strokeWidth="16"
                strokeDasharray={dash}
                strokeDashoffset={currentOffset}
                className="cursor-pointer transition-[stroke-width] hover:stroke-[18] focus:stroke-[18] motion-reduce:transition-none"
                onMouseEnter={() => setActiveId(slice.id)}
                onFocus={() => setActiveId(slice.id)}
                onClick={() => setActiveId(slice.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveId(slice.id);
                  }
                }}
              />
            );
          })}
        </g>
        <text
          x="60"
          y="58"
          textAnchor="middle"
          className="fill-foreground text-[10px] font-semibold"
        >
          {active ? active.name : totalLabel}
        </text>
        <text
          x="60"
          y="70"
          textAnchor="middle"
          className="fill-muted-foreground text-[7px]"
        >
          {active
            ? `${Math.round((active.totalCents / total) * 100)}%`
            : "total"}
        </text>
      </svg>
      {active && (
        <p className="mt-1 text-center text-sm" aria-live="polite">
          {active.name}: {formatAmount(active.totalCents)} ·{" "}
          {Math.round((active.totalCents / total) * 100)}%
        </p>
      )}
    </div>
  );
}
