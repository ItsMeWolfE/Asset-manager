# Working on Asset Manager

## Ship every change

Every change goes to `main` and gets deployed, unless I say otherwise. Do not
leave work sitting on a branch waiting to be asked.

    tools/release.sh <version> "<title>" "<note>"
    git push origin main

`tools/release.sh` keeps `version.json`, `assets/js/core/version.js`, `sw.js`,
`CHANGELOG.md` and `assets/js/data/changelog.js` in step, then commits and tags.
The Pages workflow deploys on any push to `main` and fails the deploy if those
version numbers disagree, so never edit them by hand.

- Bug fix: bump the patch (3.3.1 -> 3.3.2). A new tool or a visible new
  behaviour is a minor. Do not reach for a bigger bump than the change earns.
- A change to documentation alone needs no release: push it to `main` and stop.
  The build id is a hash of the shipped files, so a docs-only push leaves
  `sw.js` untouched and prompts nobody.
- Tag pushes are refused from the Claude Code sandbox. Say so rather than
  retrying; the deploy runs on the push to `main` regardless.
- Confirm the deploy finished (the "Deploy to GitHub Pages" run) before saying
  it is live. `itsmewolfe.github.io` is unreachable from the sandbox, so the
  workflow run is the strongest evidence available there.

## Fix what was asked, and nothing else

Do not add handling for a case I did not raise, and do not widen a fix to
cover problems I have not hit. If something else looks wrong, say so in one
line and leave it alone until I ask.

## Prove it against the real thing

Reproduce the actual failure with the actual file before changing anything,
and re-run it afterwards. The worker can be driven directly from Node, and the
whole app can be driven in Chromium with Playwright over a local `http.server`
- a passing unit-level test is not evidence that the app works.
