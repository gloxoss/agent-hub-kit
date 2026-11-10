# MOTION-LIBRARY : toute animation d'un site migré devient une brique réutilisable

Ajouté le 2026-11-10 (décision D-018). Objectif du propriétaire : après chaque migration, il garde une **bibliothèque** de hooks, de composants et de styles qu'il réutilise pour ses propres sites. Le style change d'un site à l'autre ; la mécanique d'animation, non.

## Règle d'or
**Aucune animation n'est écrite en dur dans une section.** Une section appelle un hook ou un composant de la bibliothèque et lui passe les valeurs de CE site (durée, délai, easing, distance, décalage) plus des variables de style (couleurs, polices, rayons). Si l'effet n'existe pas encore dans la bibliothèque, le builder l'y **ajoute d'abord**, puis l'appelle. La section ne contient que la configuration.

## Ce que la bibliothèque couvre (catalogue minimal, un hook ou composant par ligne)
| Famille | Exemples à capturer | Nom type |
|---|---|---|
| Chargement | préchargeur, rideau d'intro, compteur de chargement, entrée de page | `usePreloader`, `useIntroCurtain` |
| Entrée au défilement | apparition, montée, fondu, révélation de mots/lignes/lettres, décalage en cascade | `useReveal`, `useSplitReveal`, `useStagger` |
| Défilement | parallaxe, épinglage, défilement horizontal, barre de progression, section collante, zoom au défilement | `useParallax`, `usePin`, `useHorizontalScroll`, `useScrollZoom` |
| Survol | bouton (remplissage, flèche, magnétique), carte (soulèvement, inclinaison), image (zoom, révélation), lien (soulignement) | `useHoverLift`, `useMagnetic`, `useImageZoom`, `useLinkUnderline` |
| Curseur | curseur personnalisé, suiveur, curseur contextuel (voir, glisser), effet de traînée | `useCustomCursor`, `useCursorState` |
| Mouvement continu | bandeau défilant (marquee, ticker), flottement, rotation, tracé de ligne SVG | `useMarquee`, `useFloat`, `useSvgDraw` |
| Interface | menu et tiroir, accordéon, onglets, carrousel, modale, notification, compteur animé | `useDrawer`, `useAccordion`, `useCarousel`, `useCountUp` |
| Transition de page | fondu, rideau, partage d'élément | `usePageTransition` |

## Contrat d'une brique
1. **Paramétrable :** options typées avec des valeurs par défaut (`duration`, `delay`, `ease`, `distance`, `stagger`, `trigger`, `once`). Aucune valeur propre à un site dans le code de la brique.
2. **Stylable par variables :** couleurs, polices, rayons, ombres viennent de variables CSS (`--motion-*`, `--color-*`) définies dans le fichier de jetons du site. Changer de site = changer les jetons, pas le hook.
3. **Sûre :** nettoyage à la destruction (`useGSAP` avec portée), `prefers-reduced-motion` respecté, aucun contenu masqué par défaut (règle 8), pas de coût caché au défilement.
4. **Mesurée :** chaque brique porte, dans le catalogue, la mesure qui l'a validée (`motion-compare` : départ, durée, force) pour au moins un site.
5. **Documentée :** une ligne dans `docs/migration/MOTION-CATALOG.md` : nom, famille, options, jetons de style, sites où elle a été mesurée, exemple d'appel.

## Où ça vit (projet)
- Code : `src/libs/motion/` (un fichier par brique, `index.ts` exporte tout). Les sections n'importent GSAP que via cette bibliothèque.
- Styles : une feuille de jetons de mouvement partagée (`src/styles/motion-tokens.css`) + un fichier de jetons par site qui la surcharge.
- Catalogue : `docs/migration/MOTION-CATALOG.md` (tenu à jour à chaque tâche acceptée).

## Portes de contrôle
- **P4 réutilisation :** `node tools/motion-reuse-check.mjs <site> --task <id>` : refuse un fichier de section qui appelle `gsap.` ou `ScrollTrigger.create(` directement, ou qui duplique un effet déjà catalogué. Le builder doit appeler la bibliothèque.
- **P5 catalogue :** la tâche ne passe pas tant que les effets nouveaux ne figurent pas dans `MOTION-CATALOG.md` avec leur mesure.
- Le relecteur vérifie à l'œil : chaque effet vu dans le navigateur correspond à une ligne du catalogue.

## Ordre de travail pour un builder
1. Lire le catalogue ; pour chaque animation de la section, chercher la brique qui convient.
2. Absente : créer la brique dans `libs/motion` (paramétrable, tests de nettoyage), l'ajouter au catalogue, **puis** l'appeler.
3. Mesurer avec `motion-compare` (règle 5) : la brique doit reproduire le site original avec les valeurs de ce site.
4. Ne jamais copier-coller un hook d'un autre site : généraliser la brique existante.

## Tolérance visuelle (rappel)
Une petite différence de pixels est acceptée : moins de 8 % en moyenne et 15 % de pixels nettement différents à 1440, 1024 et 390. La fidélité exacte de chaque pixel n'est pas exigée ; la fidélité de **comportement** (déclencheur, durée, easing, états) l'est.
