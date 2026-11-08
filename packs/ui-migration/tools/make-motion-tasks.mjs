// One motion QA audit task per template: runs motion-compare on every animation of the audit and writes the mismatches.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
process.chdir('C:/Users/OMEN/OneDrive/Documents/projects/MoreneParfums');
const SITES = { chalant: 'Chalant', safah: 'Safah', dewskincare: 'Dewskincare', mirea: 'Mirea', raydiant: 'Raydiant' };
const env = { ...process.env, AGENT_ID: 'orchestrator' };
for (const [site, name] of Object.entries(SITES)) {
  const id = `M-motion-qa-${site}`;
  const brief = `# ${id} · audit · ${name}: audit des micro-interactions et animations (original contre reconstruction)

> **Commands (D-env):** documentation seulement. Ne modifie AUCUN fichier de code. Le serveur \`MORENE UI\` tourne déjà sur http://localhost:3001 (ne le redémarre pas). Playwright est dans \`MORENE/ops/e2e\`. Les sections de ${name} sont en cours de reconstruction par d'autres agents: si une page casse (erreur 500), attends 2 minutes et relance, ne touche à rien.

> Proof: le fichier existe et \`git status --short\` ne montre rien hors de ton périmètre.

Allowed scope: \`docs/audits/${site}/motion-qa.md\` (new). Anything else: say to the orchestrator first.

Dependencies: none.

## But
Le propriétaire a regardé la reconstruction: les sections sont assez proches de l'original mais **les micro-interactions et les animations ne sont pas assez fidèles**. Tu audites chaque animation de ${name} et tu dis, chiffres à l'appui, ce qui diffère. Tu ne corriges rien: ton rapport servira à écrire les tâches de correction.

## Outils
- L'audit de l'original: \`docs/audits/${site}/home.md\`. Chaque section a des lignes « Interactive » et « Motion » (déclencheur, propriété, durée, délai, easing, valeurs de début et de fin).
- \`node MORENE/ops/e2e/motion-compare.mjs ${site} --orig "<sélecteur de l'original>" --rebuild "<sélecteur de la reconstruction>" --trigger load|scroll|hover [--target "<enfant>"] --width 1440\`: déclenche le mouvement des deux côtés et imprime quand il commence, combien de temps il dure, sa force, et « motion matches the original » ou « MOTION DIFFERS » avec les écarts. Lis \`MORENE/ops/e2e/motion-compare.mjs\` pour les options. Sélecteur de l'original: celui de l'audit (« Root selector »). Sélecteur de la reconstruction: \`[data-section="${site}-<section>"]\` quand il existe, sinon la classe ou l'identifiant de la section dans \`MORENE UI/src/features/${site}/ui/\`.
- Pour comprendre ce que fait l'original, lis son code (\`MORENE UI/localized/${site}/index.html\` et ses scripts) et regarde les valeurs de départ et de fin, pas seulement la durée.

## Étapes
1. Pour CHAQUE section de l'audit, liste toutes ses animations et interactions (entrée au chargement, révélation au défilement, défilement lié au scroll, survol de bouton, survol de carte, menu qui s'ouvre, curseur, bandeau défilant, carrousel, accordéon, formulaire, etc.).
2. Pour chacune, lance \`motion-compare.mjs\` avec le bon déclencheur, à 1440 puis une fois à 390 pour les tactiles. Si la reconstruction n'a pas l'animation, note « absente ». Si l'outil ne peut pas la mesurer (ex. défilement continu), dis pourquoi et compare le code (valeurs GSAP contre valeurs de l'original).
3. Écris \`docs/audits/${site}/motion-qa.md\` avec un tableau: section | animation | déclencheur | original (début, fin, force) | reconstruction (début, fin, force) | verdict (fidèle, différente, absente, non mesurable) | cause probable (une ligne, avec le fichier de la reconstruction).
4. Termine par une liste priorisée des corrections (bloquant, important, confort) que les constructeurs de sections devront faire, avec pour chacune le fichier à modifier.
5. N'invente rien: chaque ligne cite la sortie réelle de l'outil ou la ligne de code.

## Done when
- \`node -e "require('fs').accessSync('docs/audits/${site}/motion-qa.md')"\` exits 0
- Le tableau contient une ligne par animation de l'audit (cite leur nombre) et la liste priorisée de corrections.
- Une ligne par section dans ton résumé: combien d'animations fidèles, différentes, absentes.

## Skills
- \`gsap-scrolltrigger\`: scroll-driven animation
- \`gsap-react\`: useGSAP, refs, context, cleanup
- \`webflow-to-react-gsap\`: section analysis and animation verification protocol
`;
  fs.writeFileSync(`.agent-hub/tasks/${id}.md`, brief);
  try {
    console.log(execFileSync(process.execPath, ['.agent-hub/hub.mjs', 'add', id, '--phase', 'audit', '--title', `${name}: motion and micro-interaction audit`, '--scope', `docs/audits/${site}/motion-qa.md`], { encoding: 'utf8', env }).trim().split('\n').pop());
  } catch (e) { console.log('FAIL', id, String(e.stderr || e.message).split('\n')[0]); }
}
