import { test, expect } from "@playwright/test";

test("homepage renders the title, search bar, and footer", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Claude Stocks App" })
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
});
