import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryDonut } from "./donut";

describe("category donut", () => {
  it("renders an accessible neutral empty ring and reveals a tapped slice share", async () => {
    const { rerender } = render(
      <CategoryDonut slices={[]} totalLabel="RM 0.00" />,
    );
    expect(
      screen.getByLabelText("No category spending this month"),
    ).toBeInTheDocument();
    rerender(
      <CategoryDonut
        totalLabel="RM 10.00"
        slices={[
          {
            id: "food",
            name: "Food",
            count: 1,
            totalCents: 1000,
            color: "var(--cat-1)",
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Food: 100%" }));
    expect(screen.getByText("Food: 1,000 cents · 100%")).toBeInTheDocument();
  });

  /**
   * Reported from the Overview month selector: selecting Food in August
   * (RM 85.90) and switching to July (RM 7.90, Utilities only) left the centre
   * label reading "Food · 1087%" — the stale slice's amount over the new
   * month's total. The selection must not outlive the slices it came from.
   */
  it("drops a selection whose category is absent after the slices change", async () => {
    const august = [
      { id: "food", name: "Food", count: 2, totalCents: 8590, color: "var(--cat-1)" },
    ];
    const july = [
      { id: "utilities", name: "Utilities", count: 1, totalCents: 790, color: "var(--cat-2)" },
    ];

    const { rerender } = render(
      <CategoryDonut slices={august} totalLabel="RM 85.90" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Food: 100%" }));
    expect(screen.getByText("Food: 8,590 cents · 100%")).toBeInTheDocument();

    rerender(<CategoryDonut slices={july} totalLabel="RM 7.90" />);

    // The stale category is gone entirely, not merely re-scaled.
    expect(screen.queryByText(/Food/)).not.toBeInTheDocument();
    // And no impossible share survives anywhere in the chart.
    expect(screen.queryByText(/1087%/)).not.toBeInTheDocument();
    // With nothing selected, the centre falls back to the month's total.
    expect(screen.getByText("RM 7.90")).toBeInTheDocument();
  });

  /** A selection that still exists must re-read the new month's amount. */
  it("re-reads the current amount when the selected category survives", async () => {
    const august = [
      { id: "food", name: "Food", count: 2, totalCents: 8590, color: "var(--cat-1)" },
    ];
    const july = [
      { id: "food", name: "Food", count: 1, totalCents: 790, color: "var(--cat-1)" },
    ];

    const { rerender } = render(
      <CategoryDonut slices={august} totalLabel="RM 85.90" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Food: 100%" }));
    expect(screen.getByText("Food: 8,590 cents · 100%")).toBeInTheDocument();

    rerender(<CategoryDonut slices={july} totalLabel="RM 7.90" />);

    expect(screen.getByText("Food: 790 cents · 100%")).toBeInTheDocument();
    expect(screen.queryByText(/8,590/)).not.toBeInTheDocument();
  });
});
