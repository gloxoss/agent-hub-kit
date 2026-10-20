# Architecture: the unified section library

Goal: any page of any source site can be rebuilt as an ordered list of `{ type, variant, props }` blocks, every block renders from shared atoms and tokens, and the same blocks restyle to the merge target by switching a theme preset. A CMS later produces the same JSON the fixtures produce today.

## 1. Layers (bottom up, each layer only imports from layers below)

| Layer | Folder | What lives there | Example |
|---|---|---|---|
| Tokens | `src/app/globals.css` | 19 contract color tokens, `[data-theme]` presets, non-color scales in `@theme` | `--primary`, `--radius`, `--font-heading`, `--section-y` |
| Atoms | `src/components/ui/` | Smallest styled primitives, no content | `button`, `link-button`, `heading`, `text`, `eyebrow`, `badge`, `container`, `section-shell`, `media`, `price`, `rating`, `icon` |
| Blocks | `src/components/blocks/` | Repeated units inside sections | `product-card`, `feature-card`, `testimonial-card`, `stat`, `logo-item`, `accordion-item`, `nav-menu` |
| Motion | `src/components/motion/` | Shared client islands | `reveal.tsx` (data-attribute driven scroll reveals), `presets.ts` |
| Sections | `src/sections/<type>/` | Full-width page sections, one folder per type, one file per variant | `hero/split-media.tsx`, `faq/two-column.tsx` |
| Render | `src/render/` | Registry lookup and page renderer | `page-renderer.tsx` |
| Content | `src/content/` | Page documents, UI strings, content adapter (mock now, CMS later) | `pages/<site>/home.ts`, `ui-strings.ts`, `adapter.ts` |
| Commerce | `src/lib/`, `src/stores/`, `src/features/` | Contract files: `ecom-types.ts`, mock `engine.ts`, `mock-actions.ts`, cart store, functional commerce UI (cart drawer, checkout steps, account) | `features/cart/ui/cart-drawer-client.tsx` |
| Routes | `src/app/` | Contract route map plus the lab | `(shop)/page.tsx`, `(lab)/sections/page.tsx` |

Rule: a section never contains raw markup that already exists as an atom or block. If two sections share more than a heading plus a button, the shared part becomes a block.

## 2. Section folder contract

```
src/sections/hero/
├── schema.ts              HeroProps (shared fields for every hero) + per-variant prop types + variant name union
├── split-media.tsx        server component, variant "split-media"
├── split-media-client.tsx only when the variant needs bespoke motion or state
├── stacked-center.tsx     another variant
├── fixtures.ts            one typed fixture per variant, copy taken from the source page
└── index.ts               this type's registry entries
```

Each type owns its entries in `src/sections/<type>/index.ts`:

```ts
export const heroEntries = {
  'hero:split-media': {
    component: HeroSplitMedia,
    fixture: heroFixtures.splitMedia,
    sources: ['<site>/<page>#hero'],
  },
} satisfies RegistryEntries;
```

`src/sections/registry.generated.ts` spreads every per-type map. It is written by `scripts/gen-registry.mjs` (run by `predev` and `prebuild`), gitignored, and never edited by hand, so builders working on different types never touch the same file. Status lives in the ledger, not in code.

The registry key `type:variant` is what a page document references, what the lab renders, and what becomes a `templates` entry in the merge target theme at merge.

### Shared files and who owns them

| File | Changed by | Why one owner |
|---|---|---|
| `src/sections/registry.generated.ts` | nobody (generated) | avoids a shared hot file |
| `src/sections/<type>/schema.ts`, `fixtures.ts`, `index.ts` | one `B-` task per type at a time | the hub serializes claims |
| `src/app/globals.css` | `T-<site>` tokens task | palette and presets |
| `src/content/pages/<site>/<page>.ts` | `P-<site>-<page>` assemble task | page order |
| `src/content/ui-strings/<namespace>.ts` | the task that owns that atom, block, or section (one file per namespace, e.g. `cart.ts`, `footer.ts`) | separate files, so parallel tasks never collide |

## 3. Prop types (CMS-shaped)

Shared building types live in `src/content/types.ts`:

```ts
type ImageRef  = { src: string; alt: string; width: number; height: number };
type LinkRef   = { label: string; href: string; external?: boolean };
type RichText  = string;                       // plain text; inline marks decided in DECISIONS.md before first use
type ProductSource = { kind: 'query'; query: ProductListQuery } | { kind: 'slugs'; slugs: string[] };

type SectionBlock<T extends string = string, P = unknown> = {
  id: string;            // stable, used for anchors and CMS ids
  type: T;               // 'hero'
  variant: string;       // 'split-media'
  props: P;              // plain JSON only
  theme?: 'inverse';     // optional local surface flip; the renderer passes it as the `surface` prop
};

type PageDoc = { slug: string; seo: { title: string; description: string }; sections: SectionBlock[] };
```

Rules:
1. Props are serializable. No ReactNode, functions, Dates, or class instances.
2. Every optional prop has a rendered fallback or the element is omitted. No empty wrappers.
3. Lists are arrays of objects with an `id`, so a CMS can reorder them.
4. Product sections never embed product data. They take a `ProductSource` and the server component resolves it through `getEngine()`.
5. Adding a prop to an existing variant must be optional (backward compatible). A required new prop means a new variant.

## 4. Pages

```tsx
// src/app/(shop)/page.tsx
export default async function HomePage() {
  const page = await getPage('home');          // src/content/adapter.ts, mock today
  return <PageRenderer page={page} />;
}
```

`PageRenderer` maps each block through the registry and passes `surface: 'inverse'` into the props when `block.theme === 'inverse'`; every section forwards `surface` to its `SectionShell`, which sets `data-surface`. `data-theme` is reserved for brand presets (each source site plus the merge target). Unknown `type:variant` renders nothing in production and a visible warning box in development.

## 5. Theming ("reshape as I need")

1. `:root` holds the active brand's 19 HSL triplets, exactly the contract block.
2. Each source brand gets a preset: `[data-theme="<source-site>"]` per site in {{SITES}}, plus `[data-theme="<merge-target>"]` mapped from the merge target design doc ({{MERGE_TARGET}}).
3. Non-color tokens (fonts, radius, shadows, section spacing, container widths, type scale) live in `@theme` and may also be overridden per preset.
4. Fonts load through `next/font` in `layout.tsx` and are exposed as CSS variables. No font CDN links.
5. The lab (`/sections?theme=<merge-target>`) renders every registry entry under any preset. Source parity is checked under the source preset; merge-target fit is checked under the merge-target preset.

## 6. Lab routes

| Route | Purpose |
|---|---|
| `/sections` | Every registered `type:variant` with its fixture, filterable by type, theme switcher |
| `/sources/[site]/[page]` | Source page reassembled from blocks, used for side-by-side parity screenshots |

The `(lab)` route group is excluded at merge.

## 7. Content and localization

1. Page documents in `src/content/pages/<site>/<page>.ts` keep the source copy (English) as fixture text during migration.
2. Merge-target copy (default locale, plus any RTL locale) comes later as `src/content/pages/<merge-target>/*` documents using the same blocks.
3. `ui-strings/<namespace>.ts` files hold microcopy keyed by id (`cart.add`, `nav.search`). At merge it moves into the i18n layer.
4. Nothing in this app assumes a locale. Routes are built without `[locale]` so they drop under `app/[locale]/` at merge.

## 8. Merge path (later, outside this workspace)

Follows the merge contract's merge section. Specific to this library: registry entries become theme `templates` entries, `globals.css` `[data-theme="<merge-target>"]` values lift into the merge target's theme file, page documents feed the content system. The merge is done in {{MERGE_TARGET}} under its agent hub rules.
