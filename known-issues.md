# Known Issues

## Header shift on dropdown open (low priority)

**Branch:** `feature/homepage-improvements`
**File:** `app/layout.tsx`, `app/globals.css`

When a Shadcn `Select` dropdown is opened on the dashboard, the fixed header wordmark shifts horizontally and a scrollbar briefly appears.

**Root cause (suspected):** Radix UI locks body scroll (`overflow: hidden`) when a dropdown opens, removing the scrollbar and widening the viewport by ~15px. The `fixed w-full` header reflows to fill the extra space.

**Attempted fix:** `scrollbar-gutter: stable` on `html` in `globals.css` — did not resolve the issue.

**Next steps to investigate:**
- Check whether Radix is also applying a `padding-right` compensation to `body` that conflicts with the fixed header
- Inspect the `data-scroll-locked` attribute Radix sets on `body` when the dropdown is open
- Consider overriding Radix's body padding compensation via a CSS rule targeting `body[data-scroll-locked]`
