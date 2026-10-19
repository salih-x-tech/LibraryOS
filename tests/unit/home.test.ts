import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/page";

describe("startup page", () => {
  it("renders the app entry point in the Node test environment", () => {
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(process.env.NODE_ENV).toBe("test");
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain("Your library,");
    expect(markup).toContain("thoughtfully organized.");
  });
});
