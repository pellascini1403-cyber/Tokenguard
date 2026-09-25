import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DashboardLoading from "@/app/(dashboard)/loading";
import DashboardError from "@/app/(dashboard)/error";
import RequestsLoading from "@/app/(dashboard)/requests/loading";

describe("dashboard loading boundary", () => {
  it("renders a status region", () => {
    render(<DashboardLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });
});

describe("requests loading boundary", () => {
  it("renders a status region", () => {
    render(<RequestsLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading requests");
  });
});

describe("dashboard error boundary", () => {
  it("renders the error and calls reset() on retry", () => {
    const reset = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<DashboardError error={new Error("boom")} reset={reset} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });
});
