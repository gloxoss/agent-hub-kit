---
name: ui-localize
description: Phase 1 of a UI migration workspace. Produces an offline, self-contained clone of one Webflow source site in localized/<site>/ without changing content, structure, or interactions, so it can serve as the visual and motion reference for rebuilding. Use when the orchestrator reaches a site with status todo, or when the user says "localize <site>", "make the source offline", or "clone the site locally".
---

# ui-localize

Wraps the global `web-localizer` skill, steps 1 to 4 and 7 only (see `docs/system/SKILL-OVERRIDES.md`). No content edits, no branding, no deploy.

## Inputs

Site entry from `docs/migration/sources.json`: `rawRoot`, `pagesRoot`, `localizedRoot`, `pages`.

## Facts about these sources

The raw folders are site-downloader captures: one folder per host (`cdn.prod.website-files.com/`, `fonts.gstatic.com/`, `d3e54v103j8qbb.cloudfront.net/`, ...) next to the pages folder. Many assets are already on disk, but the HTML still points at absolute `https://` URLs, filenames are URL-encoded (`%20`), and `srcset` lists several sizes.

## Steps

1. **Copy, never edit raw.** Copy `rawRoot` to `localizedRoot` keeping the host folder structure. All later edits happen in the copy.
2. **Inventory references.** For every page in the site, collect URLs from `href`, `src`, `srcset`, `poster`, `data-src`, inline `style` `url()`, and CSS `@import`/`url()` in every local CSS file. Write the list to `localizedRoot/_localize/refs.json` with `{ url, foundIn, localPath, exists }`.
3. **Resolve.** Map each URL to its host-folder path (decode `%20`, strip query strings only when the file on disk has none). Mark missing files.
4. **Fetch missing only.** Download only refs marked missing that are runtime-critical (CSS, JS, fonts, images, video posters). Record failures; never skip silently.
5. **Relink.** Rewrite references in HTML, CSS, and JS to relative local paths. Handle each `srcset` candidate. Keep outbound links (social, mailto, external pages) untouched.
6. **Runtime compatibility.** Localize Google Fonts CSS and font files and point `webfont.js` loading at the local CSS. Remove `integrity`/`crossorigin` attributes that block local loading. Keep script order and every `data-w-id`, class, and id unchanged.
7. **Write the report** to `localizedRoot/_localize/REPORT.md`: file count, refs found, refs relinked, unresolved refs, deliberate external leftovers (Vimeo, Turnstile, analytics), anything that will not work offline.

Steps 1 to 5 and 7 are automated: `node scripts/localize/localize.mjs <siteId>` (add `--no-fetch` to skip downloads). It reads `sources.json`, rebuilds `localizedRoot` from scratch, and checks the raw folder is unchanged. Fix bugs in that script rather than writing a new one.

Known gotchas:
- Filenames with parentheses (`Author Image (2).png`) must survive URL matching; the script allows balanced parens.
- Serve with `npx http-server localized/<site> -p 4310 -s -c-1` from the workspace root. Starting the server from inside the folder locks it on Windows and the next run fails with EPERM.
- Stopping the background task does not kill the `npx http-server` child on Windows. Find the PID listening on the port (`netstat -ano`) and stop it, or the next localize run hits EPERM.
- Scripts relink URLs inside HTML and CSS, not inside JS bundles. A script that injects an asset at runtime (badges, placeholders) keeps its external URL and must be listed in the report as an external leftover.
- For the offline gate, block all non-localhost requests in Playwright (`page.route`). Without blocking, fonts can silently load from Google and the check passes falsely.
- Elements left at opacity 0 after scrolling are often hover reveals. Hover the parent before calling them stuck.

## Gate

1. `refs.json` shows zero unresolved runtime-critical refs, or each one is listed in the report with a reason.
2. Serve `localizedRoot` with a static server and open every page with network logging: no request leaves localhost except the listed leftovers.
3. Webflow interactions still fire (scroll a page, confirm a `data-w-id` element changes opacity or transform).
4. Raw folder unchanged: compare file count and total size before and after.

## Close

Report with hub `done` (see `agents/ui-site-localizer.md`). The orchestrator audits the result and sets the ledger site row to `localized`.
