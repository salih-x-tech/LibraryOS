import { expect, test } from "@playwright/test";

test("the startup page loads without browser errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("LibraryOS");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("main").getByRole("heading", { name: "LibraryOS", level: 1 }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("unknown routes return the not-found page", async ({ page }) => {
  const response = await page.goto("/missing-startup-route");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "404", level: 1 })).toBeVisible();
});
