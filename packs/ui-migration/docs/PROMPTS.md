# Prompts pour un run complet (template -> React + Tailwind + GSAP fidèle)

Ordre d'appel des skills: `ui-localize` -> `ui-audit` -> `ui-map` -> `ui-build` + `ui-parity-loop` -> `ui-parity-verifier` -> motion audit. Orchestrateur: `ui-orchestrator`.

## 0. Préparation (une fois par projet)
```
Lis AGENTS.md, docs/brain/README.md, STATE.md, OPEN.md. Charge les skills ui-orchestrator, ui-parity-loop, template-to-atomic-react-gsap, webflow-to-react-gsap, html-epioso.
Copie packs/ui-migration/tools/* dans ops/e2e/, installe Playwright dans ce dossier, lance compare-server.mjs (port 4190, originaux 4181+).
Règles non négociables: une tâche par section; widths 1440/1024/390; seuil pixel 8%/15%; motion-compare par animation; jamais supprimer un fichier importé avant son remplaçant; reviewers différents des builders.
```

## 1. Localiser + auditer (par template)
```
/ui-localize puis /ui-audit pour <site>. Dans l'audit, pour chaque section: Root selector, copie exacte, tailles mesurées (getBoundingClientRect, getComputedStyle) aux 3 largeurs (>=1440, 810-1439, <810), et pour CHAQUE animation: déclencheur, propriété, début/fin, durée, délai, easing. Sortie: docs/audits/<site>/home.md et _tokens.md.
```

## 2. Planifier (orchestrateur)
```
/ui-map pour <site>. Puis génère une tâche par section avec tools/make-section-tasks.mjs (S-sec-<site>-<section>), scope disjoint par section, data/styles/hook séparés. Un seul lanceur (keeper). Priorité: header, hero, puis le reste dans l'ordre de la page.
```

## 3. Construire (builder, une section)
```
Tâche S-sec-<site>-<section>. Charge ui-build et ui-parity-loop. Mesure l'original, construis depuis les chiffres, racine id + data-section. Preuves obligatoires dans ton rapport: section-compare aux 3 largeurs (score pixel + boîte), motion-compare par animation (load/scroll/hover), gates G1-G11, coupling-check. Ne casse jamais /showcase/<site>. Pas de "ça ressemble": des chiffres.
```

## 4. Accepter (orchestrateur)
```
Pour chaque tâche REVIEW: relance moi-même une commande section-compare et une motion-compare, lance un reviewer d'un autre exécuteur, puis accept ou reject avec liste numérotée. Après acceptation: section-preview.mjs et envoie au propriétaire les liens LIVE http://localhost:4190/compare/<site>/<section> et http://localhost:3001/showcase/<site>#<section> (pas de captures).
```

## 5. Audit mouvement (par template, après le build)
```
node tools/make-motion-tasks.mjs puis lance M-motion-qa-<site>: chaque animation mesurée, verdict (fidèle/différente/absente/non mesurable), liste de corrections priorisée. Chaque ligne "différente" ou "absente" devient une tâche de rework.
```

## 6. Réception propriétaire
```
Quand le propriétaire dit "ça ne ressemble pas": ouvre http://localhost:4190/compare/<site> à sa largeur (souvent ~850 px = tablette), mesure CETTE largeur, ajoute une tâche par section fautive, n'argumente pas à partir d'un score.
```

## Phrase de lancement unique (nouveau projet)
```
Migre <liste des sites> en React + Tailwind + GSAP fidèles, en un run. Suis packs/ui-migration/docs/PROMPTS.md étapes 0 à 5 sans me demander de confirmation, sauf pour les actions irréversibles. Vérifie toutes les 30 s les agents, relance ceux qui ont perdu leur agent, garde au moins 6 agents actifs. Rends compte avec les liens live des sections acceptées.
```
