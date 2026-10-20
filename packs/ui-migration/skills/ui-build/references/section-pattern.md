# Section pattern (reference code)

Illustrative shapes. Check the installed Next 16 docs for framework APIs before copying anything framework-level.

## schema.ts

```ts
import type { ImageRef, LinkRef } from '@/content/types';

export type HeroBase = {
  eyebrow?: string;
  heading: string;
  body?: string;
  ctas?: LinkRef[];
};

export type HeroSplitMediaProps = HeroBase & {
  media: ImageRef[];            // 1 or 2 images, second one overlaps
  miniCard?: { image: ImageRef; label: string };
};

export type HeroVariant = 'split-media' | 'stacked-center';
```

## Server component: split-media.tsx

```tsx
import { Container } from '@/components/ui/container';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Heading } from '@/components/ui/heading';
import { LinkButton } from '@/components/ui/link-button';
import { Media } from '@/components/ui/media';
import { SectionShell } from '@/components/ui/section-shell';
import type { HeroSplitMediaProps } from './schema';

export function HeroSplitMedia({ eyebrow, heading, body, ctas, media }: HeroSplitMediaProps) {
  return (
    <SectionShell>
      <Container className="grid gap-10 lg:grid-cols-12 lg:items-center">
        <div className="lg:col-span-7" data-reveal="rise">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
          <Heading as="h1" size="display">{heading}</Heading>
          {body ? <p className="mt-6 text-muted-foreground">{body}</p> : null}
          {ctas?.length ? (
            <div className="mt-8 flex flex-wrap gap-3">
              {ctas.map((cta, i) => (
                <LinkButton key={cta.href} link={cta} variant={i === 0 ? 'primary' : 'outline'} />
              ))}
            </div>
          ) : null}
        </div>
        <div className="relative lg:col-span-5" data-reveal="zoom">
          {media.map((img, i) => (
            <Media key={img.src} image={img} priority={i === 0} />
          ))}
        </div>
      </Container>
    </SectionShell>
  );
}
```

Notes: no string literal in JSX, no color class outside tokens, `data-reveal` handled by the shared `Reveal` island mounted once in the layout or section shell.

## Client island (only when Reveal is not enough): tabs-client.tsx

```tsx
'use client';
import { useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';

gsap.registerPlugin(useGSAP);

export function FeatureTabsClient({ items }: { items: { id: string; title: string }[] }) {
  const scope = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('[data-panel]', { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power2.out' });
    });
  }, { scope, dependencies: [active] });

  return <div ref={scope}>{/* tab buttons from items, panel */}</div>;
}
```

## fixtures.ts

```ts
import type { HeroSplitMediaProps } from './schema';

export const heroFixtures = {
  splitMedia: {
    eyebrow: '…source copy…',
    heading: '…source copy…',
    ctas: [{ label: '…', href: '/catalog' }],
    media: [{ src: '/media/<site>/hero.webp', alt: '…', width: 1200, height: 1400 }],
  } satisfies HeroSplitMediaProps,
};
```

## Page document: src/content/pages/<site>/<page>.ts

```ts
import type { PageDoc } from '@/content/types';
import { heroFixtures } from '@/sections/hero/fixtures';

export const sitePage: PageDoc = {
  slug: 'home',
  seo: { title: '…', description: '…' },
  sections: [
    { id: 'hero', type: 'hero', variant: 'split-media', props: heroFixtures.splitMedia },
  ],
};
```

## Product-backed section

Props carry `source: ProductSource`. The server component calls `getEngine()` and resolves it, then passes `Product[]` to `ProductCard` blocks. Prices only through the `Price` atom (`Money`, minor units).

## Webflow easing to GSAP

Webflow IX2 names follow Penner. GSAP power numbers are offset by one: quad = power1, cubic = power2, quart = power3, quint = power4.

| Webflow | GSAP |
|---|---|
| outQuart | power3.out |
| inOutQuint | power4.inOut |
| outQuint | power4.out |
| outCubic | power2.out |
| easeInOut / ease | power1.inOut |
| linear or unset | none |

Check any other mapping with `gsap.parseEase(name)(0.5)` before using it.
