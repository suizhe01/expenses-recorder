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
});
