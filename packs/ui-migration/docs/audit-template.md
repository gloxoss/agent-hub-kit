# Audit: <site>/<page>

Source: `<localized path>` - Audited: <date> - Sections: <n>

## Page summary
Page type, purpose in one sentence, sections in order (ids only).

## Shared chrome
`navbar` and `footer`: "see `docs/audits/<site>/home.md`" on every page except the first.

## Sections

### <site>/<page>#<slug>
- **Root selector:** `.section.top-section` (for locating it again in the HTML)
- **Layout:** e.g. two columns 7/5 on desktop, image right, stacks image-first under 768px
- **Layout fingerprint:** short structural signature used for dedupe, e.g. `container > [eyebrow, h1, p, cta-pair] + media(2 overlapping images) + mini-card`
- **Content shape:**
  ```
  eyebrow: string
  heading: string (1 line, ~40 chars)
  body: string
  ctas: LinkRef[2]
  media: ImageRef[2]
  ```
- **Source copy:** exact strings, kept short, used for fixtures
- **Interactive:** tabs, accordion, slider, form, hover states (describe behavior, not code)
- **Motion:** one line per animation
  `trigger (load|scroll-into-view|scroll-scrub|hover|click) - target - from -> to - duration - delay - easing - stagger` or `UNDECODED <element>`
- **Assets:** local paths of images, videos, icons, with intrinsic size
- **Colors used:** token suggestion per color (`#1c1c1c -> foreground`)
- **Notes:** anything odd (overlaps, negative margins, sticky, z-index tricks, CMS collection lists)

## Not portable without approval
Items needing a new dependency (Vimeo player, Lottie, Swiper) or that rely on Webflow Ecommerce runtime, with a suggested native alternative.
