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
  const [active, setActive] = useState<DonutSlice>();
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
                onMouseEnter={() => setActive(slice)}
                onFocus={() => setActive(slice)}
                onClick={() => setActive(slice)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActive(slice);
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
