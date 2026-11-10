// One build task per section of the Chalant and Dewskincare home pages (the owner asked for a section by section rework).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
process.chdir('C:/Users/OMEN/OneDrive/Documents/projects/MoreneParfums');
const APPLY = process.argv.includes('--apply');

const SITES = {
  chalant: {
    name: 'Chalant', prefix: 'Chalant', audit: 'docs/audits/chalant/home.md', rules: 'chalant',
    sections: [
      { id: 'navbar', anchor: 'chalant/home#navbar', files: ['ChalantNavbar'] },
      { id: 'hero', anchor: 'chalant/home#hero', files: ['ChalantHero'] },
      { id: 'metrics', anchor: 'chalant/home#metrics', files: ['ChalantMetricsSection'] },
      { id: 'product', anchor: 'chalant/home#product', files: ['ChalantProductSpotlight'] },
      { id: 'mix', anchor: 'chalant/home#mix', files: ['ChalantMixSection'] },
      { id: 'testimonial', anchor: 'chalant/home#testimonial', files: ['ChalantTestimonialsSection'] },
      { id: 'faq', anchor: 'chalant/home#faq', files: ['ChalantFaqSection'] },
      { id: 'footer', anchor: 'chalant/home#footer', files: ['ChalantNewsletterFooter'] },
    ],
  },
  dewskincare: {
    name: 'Dewskincare', prefix: 'Dew', audit: 'docs/audits/dewskincare/home.md', rules: 'safah',
    sections: [
      { id: 'navbar', anchor: 'dewskincare/home#navbar', files: ['DewHeader'] },
      { id: 'hero', anchor: 'dewskincare/home#hero', files: ['DewHero'] },
      { id: 'ticker', anchor: 'dewskincare/home#ticker', files: ['DewMarquee'] },
      { id: 'manifesto', anchor: 'dewskincare/home#manifesto', files: ['DewManifestoSection'] },
      { id: 'zoom', anchor: 'dewskincare/home#zoom', files: ['DewZoomSection'] },
      { id: 'products', anchor: 'dewskincare/home#products', files: ['DewProductsCarousel'] },
      { id: 'ingredients', anchor: 'dewskincare/home#ingredients', files: ['DewBentoSection'] },
      { id: 'story', anchor: 'dewskincare/home#rituals, #gallery and #about', files: ['DewStoryRitualSection'] },
      { id: 'reviews-faq', anchor: 'dewskincare/home#reviews and #faq', files: ['DewTestimonialsFaqSection'] },
      { id: 'closing-footer', anchor: 'dewskincare/home#closing and #footer (and #effects for global effects)', files: ['DewFooter'] },
    ],
  },
};

Object.assign(SITES, {
  safah: {
    name: 'Safah', prefix: 'Safah', audit: 'docs/audits/safah/home.md', rules: 'safah',
    sections: [
      { id: 'header', anchor: 'safah/home#announcement-bar and #navbar', files: ['SafahHeader', 'SafahTicker'] },
      { id: 'hero', anchor: 'safah/home#hero', files: ['SafahHero'] },
      { id: 'about', anchor: 'safah/home#about-us', files: ['SafahAboutSection'] },
      { id: 'collection', anchor: 'safah/home#collection', files: ['SafahPrestigeSection', 'SafahCollectionSection'] },
      { id: 'products', anchor: 'safah/home#products', files: ['SafahCategorySection'] },
      { id: 'testimonials', anchor: 'safah/home#testimonials', files: ['SafahTestimonialsSection'] },
      { id: 'footer', anchor: 'safah/home#newsletter and #footer', files: ['SafahFooter'] },
    ],
  },
  mirea: {
    name: 'Mirea', prefix: 'Mirea', audit: 'docs/audits/mirea/home.md', rules: 'safah',
    sections: [
      { id: 'navbar', anchor: 'mirea/home#navbar', files: ['MireaHeader'] },
      { id: 'hero', anchor: 'mirea/home#hero', files: ['MireaHero'] },
      { id: 'statement', anchor: 'mirea/home#statement', files: ['MireaStatementSection'] },
      { id: 'products', anchor: 'mirea/home#products', files: ['MireaProductsSection'] },
      { id: 'formula', anchor: 'mirea/home#formula', files: ['MireaFormulaSection'] },
      { id: 'ritual', anchor: 'mirea/home#ritual', files: ['MireaRitualSection'] },
      { id: 'story', anchor: 'mirea/home#story', files: ['MireaStorySection'] },
      { id: 'people', anchor: 'mirea/home#people', files: ['MireaPeopleSection'] },
      { id: 'journal', anchor: 'mirea/home#journal', files: ['MireaJournalHomeSection'] },
      { id: 'cta-footer', anchor: 'mirea/home#cta and #footer', files: ['MireaFooter'] },
    ],
  },
  raydiant: {
    name: 'Raydiant', prefix: 'Raydiant', audit: 'docs/audits/raydiant/home.md', rules: 'raydiant',
    sections: [
      { id: 'navbar', anchor: 'raydiant/home#navbar', files: ['RaydiantHeader'] },
      { id: 'hero', anchor: 'raydiant/home#hero', files: ['RaydiantHero'] },
      { id: 'benefits', anchor: 'raydiant/home#benefits', files: ['RaydiantBentoBenefitsSection'] },
      { id: 'collage', anchor: 'raydiant/home#ingredients, #howitworks, #comparison and #gallery', files: ['RaydiantCollageSection'] },
      { id: 'testimonial-faq', anchor: 'raydiant/home#testimonial and #faq', files: ['RaydiantTestimonialsFaqSection'] },
      { id: 'cta-footer', anchor: 'raydiant/home#cta, #footer and #effects', files: ['RaydiantFooter'] },
    ],
  },
});

const skills = `## Skills
- \`webflow-to-react-gsap\`: section analysis, pure Tailwind transpilation, GSAP engine, verification protocol
- \`html-epioso\`: HTML to React reconstruction, pixel by pixel
- \`template-to-atomic-react-gsap\`: atomic React + Tailwind + GSAP workflow and the zero-coupling verifier
- \`ui-map\`: dedupe gate: map the section to a shared section type:variant (REUSE, EXTEND, NEW-VARIANT) before writing a near copy
- \`gsap-react\`: useGSAP, refs, context, cleanup
- \`gsap-scrolltrigger\`: scroll-driven animation
- \`tailwind-design-system\`: Tailwind tokens
`;

const made = [];
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);
for (const [site, S] of Object.entries(SITES)) {
  if (ONLY.length && !ONLY.includes(site)) continue;
  for (const sec of S.sections) {
    if (fs.existsSync(`.agent-hub/tasks/S-sec-${site}-${sec.id}.md`) && ONLY.length === 0) continue;
    const id = `S-sec-${site}-${sec.id}`;
    const comp = sec.files.map((f) => `MORENE UI/src/features/${site}/ui/${f}.tsx`);
    const own = [
      ...comp,
      `MORENE UI/src/features/${site}/ui/sections/${sec.id}`,
      `MORENE UI/src/features/${site}/hooks/use${S.prefix}${sec.id.replace(/(^|-)(\w)/g, (_m, _a, c) => c.toUpperCase())}.ts`,
      `MORENE UI/src/features/${site}/data/${sec.id}.ts`,
      `MORENE UI/src/styles/${site}/${sec.id}.css`,
    ];
    const brief = `# ${id} · build · ${S.name} home: section « ${sec.id} », reconstruction fidèle à l'original

> **Commands (D-env):** ne lance jamais \`next build\`. Le serveur \`MORENE UI\` tourne déjà sur http://localhost:3001 (ne le redémarre pas). Playwright est installé dans \`MORENE/ops/e2e\` (aucun \`npm install\`). Pas de modification du backend.

> Proof: \`node .agent-hub/tools/scoped-tsc.mjs ui --task ${id}\` exit 0, \`node .agent-hub/tools/coupling-check.mjs ${site} --task ${id}\` exit 0, et la comparaison de section aux trois largeurs (voir « Done when »). \`git status --short\` ne montre rien hors de ton périmètre.

Allowed scope: ${own.map((p) => `\`${p}\``).join(', ')}. N'édite PAS les fichiers partagés (\`${S.prefix}PageView.tsx\`, \`home.ts\`, \`tokens.css\`, \`globals.css\`, le fichier de hooks existant): si un fichier partagé doit changer, dis-le à l'orchestrateur avec la ligne exacte. Les styles de ta section vont dans \`MORENE UI/src/styles/${site}/${sec.id}.css\` (importé depuis ton composant), tes animations dans ton propre hook, ton contenu dans ton fichier de données. Anything else: say to the orchestrator first.

Dependencies: none.

## But
Le propriétaire a regardé la reconstruction de ${S.name} et la trouve très éloignée de l'original: elle doit être refaite section par section. Cette tâche reconstruit UNE section: **${sec.id}**, identique à l'original (pixels, polices, couleurs, espacements, animations, interactions), en React + Tailwind + GSAP, avec des composants réutilisables (atomes et molécules), des styles centralisés (jetons) et des animations dans un hook.

## Source de vérité
1. L'audit de la section: \`${S.audit}\`, section(s) **${sec.anchor}**: sélecteur racine de l'original, disposition, copie source exacte, interactions, animations avec durées et easings, assets, couleurs.
2. Le code de l'original: \`MORENE UI/localized/${site}/index.html\` et ses scripts. Lis-le section par section; ne devine rien. Si l'audit et le code de l'original se contredisent, le code de l'original gagne et tu le dis dans ton résumé.
3. Règles d'architecture: \`.agent-hub/pages/${S.rules}-migration-rules.md\` (mêmes règles pour tous les gabarits).

## Outil de comparaison d'une section
\`node MORENE/ops/e2e/section-compare.mjs ${site} --orig "<sélecteur de l'original, pris dans l'audit>" --rebuild '[data-section="${site}-${sec.id}"]' --width 1440\`
Il écrit une capture de la section originale et de la tienne côte à côte, et imprime les deux boîtes (largeur et hauteur) avec l'écart. **Ton composant racine doit porter \`data-section="${site}-${sec.id}"\`.** Lance-le aux trois largeurs 1440, 768 et 390 et regarde les images (ouvre les PNG).

## Étapes
1. Lis la section de l'audit et le code de l'original. Mesure l'original à 1440, 768 et 390 px (position, taille, polices, couleurs exactes, rayons, ombres, espacements). Fais défiler par paliers avant de mesurer: l'original révèle du contenu au défilement.
2. Décide avec \`ui-map\` (regarde \`MORENE UI/src/sections/\` et \`MORENE UI/src/components/ui/\`): réutiliser, étendre ou créer. Écris la décision en une ligne dans ton résumé.
3. Reconstruis la section: structure, texte exact de l'audit (jamais de texte inventé), médias de \`public/media/${site}/\` (aucune URL externe), jetons CSS dans ta feuille de style, atomes réutilisables. Aucun hex ni \`style={{}}\` dans les \`.tsx\`, aucun \`window.addEventListener('scroll')\`, aucune importation depuis \`localized/\`, aucune classe de l'original.
4. Animations: dans un hook GSAP (\`useGSAP\`, \`ScrollTrigger\`), mêmes déclencheurs, durées, délais, easings et valeurs que l'original, avec nettoyage et \`prefers-reduced-motion\`. Reproduis aussi les micro-interactions (survols de boutons et de cartes, curseur, etc.). **Bibliothèque d'animations (obligatoire):** toute animation (chargement, défilement, survol, curseur, bandeau, menu, accordéon, carrousel…) est une brique réutilisable de \`src/libs/motion\` (hook ou composant paramétrable, style par variables CSS). Ta section n'appelle QUE la bibliothèque avec les valeurs de ce site, sans \`gsap.\` ni \`ScrollTrigger.\` en direct. Si la brique manque, ajoute-la d'abord (options, nettoyage, \`prefers-reduced-motion\`), inscris-la dans \`docs/migration/MOTION-CATALOG.md\` avec ta mesure, puis appelle-la. Vérifie: \`node tools/motion-reuse-check.mjs ${site} --task <ta tâche>\` doit sortir à 0. Une petite différence de pixels est tolérée (moins de 8 % de moyenne), la fidélité du comportement ne l'est pas.
5. Compare aux trois largeurs et corrige jusqu'à ce que la boîte de ta section soit à moins de 2 % de l'original en largeur et en hauteur ET que les images côte à côte montrent la même mise en page, les mêmes couleurs de fond, la même typographie.
6. Écris dans ton résumé une ligne par différence relevée et corrigée (avant/après chiffré), et une ligne par différence restante avec la raison. Ne dis pas avoir vu un résultat que tu n'as pas vu.

## Done when
- \`node .agent-hub/tools/scoped-tsc.mjs ui --task ${id}\` exits 0
- \`node .agent-hub/tools/coupling-check.mjs ${site} --task ${id}\` exits 0
- Les trois sorties de \`section-compare.mjs\` (1440, 768, 390) sont citées avec l'écart de largeur et de hauteur de la section.
- Une ligne par différence corrigée ou restante dans ton résumé.

${skills}`;
    fs.writeFileSync(`.agent-hub/tasks/${id}.md`, brief);
    made.push({ id, own, title: `${S.name} home section ${sec.id}: faithful rebuild` });
  }
}
console.log(`briefs written: ${made.length}`);
if (APPLY) {
  const env = { ...process.env, AGENT_ID: 'orchestrator' };
  for (const m of made) {
    try {
      execFileSync(process.execPath, ['.agent-hub/hub.mjs', 'add', m.id, '--phase', 'build', '--title', m.title, '--scope', m.own.join(',')], { encoding: 'utf8', env });
      console.log('added', m.id);
    } catch (e) { console.log('FAIL', m.id, String(e.stderr || e.message).split('\n')[0]); }
  }
}
