import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("the startup page loads without browser errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("LibraryOS");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("main").getByRole("heading", { name: "Your library, thoughtfully organized.", level: 1 }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("unknown routes return the not-found page", async ({ page }) => {
  const response = await page.goto("/missing-startup-route");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "404", level: 1 })).toBeVisible();
});

for (const width of [320, 768, 1440]) {
  test(`shell is accessible and fits a ${width}px viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");

    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflows).toBe(false);
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`shell-${width}.png`), fullPage: true });
  });
}

test("keyboard users can skip directly to the main content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("mobile navigation expands, closes with Escape and follows section links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(navigation).toBeVisible();
  await expect(page.getByRole("button", { name: "Close navigation" })).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
  await page.getByRole("button", { name: "Open navigation" }).click();
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(audit.violations).toEqual([]);
  await navigation.getByRole("link", { name: "Getting started" }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(/#getting-started$/);
  await expect(page.locator("#getting-started")).toBeFocused();
});

test("reduced motion disables smooth scrolling and logo movement", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveCSS("scroll-behavior", "auto");
  const brand = page.getByRole("link", { name: /LibraryOS.*A place for every chapter/ });
  await brand.hover();
  await expect(brand).toHaveCSS("transform", "none");
});
