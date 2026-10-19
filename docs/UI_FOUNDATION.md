# Visual shell — Task 1.3

This is a reusable layout foundation, not a functional library dashboard. It contains no tenant data, authentication or library operations. Upcoming modules are text labels, not links to unimplemented routes. Real routes must obtain backend authorization before serving tenant content.

## Files and boundaries

- `src/app/page.tsx`: server-rendered overview content and honest upcoming-feature descriptions.
- `src/components/shell/app-shell.tsx`: client-only mobile disclosure state and Motion preference handling; accepts server-rendered children.
- `src/components/shell/icon.tsx`: small typed, decorative SVG icon set.
- `src/components/ui/{button,card}.tsx`: locally owned shadcn/ui adaptations. Button remains a native button, defaults to type=button and accepts React 19 ref props. CardTitle uses a real heading.
- `src/lib/utils.ts`: standard class merging for UI primitives, not business logic.
- `src/app/globals.css`: semantic color tokens, Tailwind theme mapping, layout and reduced-motion rules.
- `components.json`, `postcss.config.mjs`: shadcn aliases/theme location and Tailwind PostCSS integration. Future generated components need review; not every upstream dependency is needed for these simple primitives.

## Palette

| Token | Color | Use |
| --- | --- | --- |
| background | #f8f7f2 | Ivory canvas |
| foreground | #233c30 | Main reading text |
| primary | #183e30 | Forest green controls |
| primary-foreground | #fffaf0 | Text on primary |
| card | #fffefa | Warm white cards |
| muted-foreground | #626b60 | Supporting text |
| gold | #b18b4b | Decorative antique gold |
| gold-foreground | #73531c | Readable gold-toned text on ivory |
| ring | #8a6224 | Focus on light surfaces |

The sidebar uses a deep forest surface and a lighter focus ring. Do not use decorative gold indiscriminately as small body text. Main headings use local Georgia with serif fallbacks; UI text uses local Arial/Helvetica, avoiding external font requests. This is Baroque-inspired through serif typography, fine borders and restrained ornament, not heavy decoration.

## Responsive and accessible behavior

At widths above 900px the sidebar is fixed. Smaller screens use a native-button disclosure with aria-expanded/aria-controls. Escape closes it and returns focus; section links close it and target focusable sections. It is an inline disclosure, not a modal: it needs no artificial focus trap. Upcoming tools are not keyboard stops.

The first keyboard link skips to focusable main content. Landmarks/headings establish reading order; decorative SVGs/illustration are hidden from assistive technology. Focus rings remain visible on both light and dark backgrounds. Interactive menu/navigation targets are at least 44px tall. Anchor scroll padding accounts for the sticky mobile header.

MotionConfig follows user preference and the logo hover explicitly checks useReducedMotion. CSS also disables smooth scrolling/transitions for reduced motion. Server-rendered content is never initially hidden by an entrance animation.

Automated Chromium checks cover 320, 768 and 1440px widths, no horizontal overflow, axe WCAG A/AA rule sets, open mobile navigation, skip focus and reduced motion. Desktop and mobile full-page screenshots are reviewed. These checks do not establish full screen-reader, cross-browser or WCAG 2.2 AA conformance; those remain release work. See THIRD_PARTY_NOTICES.md for UI source licensing.
