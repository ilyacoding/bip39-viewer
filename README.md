# BIP39 Wordlist

A single page that lists all 2048 words of the BIP39 English wordlist, so you can check whether a
word from a recovery phrase is on the list without typing it anywhere. It is live at https://bip39.uuid.me.

It is a static site with plain HTML, CSS and JavaScript and no libraries. The build inlines everything into one
`index.html`.

## Why there's no search box

Typing a seed word into a search box can leak it. Keyboards learn and sync words, and autofill,
history and analytics can store them. This page gives you nothing to type into:

- **Scrolling only.** There are no inputs, buttons, forms or links, and nothing happens when you tap or click.
- **Nothing you look at is saved or sent.** There are no cookies, no local storage, no analytics and no third-party
  requests. The URL and history never change, scroll position is not restored, and every load starts at "abandon".
  The only stored data is the service worker's offline copy of the page and its icons.
- **Strict Content Security Policy.** The one inline script and the one inline stylesheet are allowed by their
  SHA-256 hashes. Apart from the site's own icons, manifest and service worker, everything is blocked. The page can't
  open network connections (`connect-src 'none'`).
- **Trusted Types.** They are enforced. The only policy (`bip39`) can create nothing except the URL `./sw.js`, so no
  script can inject HTML strings into the page.
- **Integrity check in your browser.** The page computes the SHA-256 of the words it actually shows and compares it
  with the official list (see [Verify it yourself](#verify-it-yourself)).
- **Works offline.** After the first visit, a service worker keeps a copy of the page and its icons. You can turn
  on airplane mode before you look anything up.
- **No translation or text selection.** `translate="no"` keeps browser translation from sending the page text to a
  service. Text can't be selected, so no copy menu, Look Up or Touch to Search can pick up a word.
- **Hidden when away.** The list is blanked while the page is hidden, so app-switcher snapshots stay empty (best
  effort). GitHub Pages can't send headers, so the CSP is a `<meta>` tag and can't block framing. Instead, the page
  hides itself when it is loaded in a frame.

## How to use

- Scroll the list. The word in the centered lens is highlighted, along with its number (1–2048) and its 11-bit
  binary value (abandon is `00000000000`, zoo is `11111111111`).
- Scroll the letter strip on the right to jump between first letters. The list moves to the first word of the
  letter in the lens, and the strip follows as you scroll the list.
- The first four letters of each word are emphasized. In BIP39, the first four letters are enough to identify a word.

## Develop

There are no dependencies and no `npm install`. You need Node ≥ 20.

```sh
npm test          # unit and build tests (node --test)
npm run build     # build into dist/
npm run serve     # serve dist/ at http://127.0.0.1:8080
npm run e2e       # end-to-end tests in headless Chrome (needs Google Chrome)
npm run ios       # screenshots in Safari on an iOS Simulator (macOS with Xcode)
npm run dev       # build, then serve
npm run icons     # redraw the PNG icons into src/static/ (the output is committed)
```

## Project structure

```
src/
  index.html          page template; the build fills in its {{MARKERS}}
  styles.css          styles (inlined by the build)
  lib.js              pure logic, unit-tested
  app.js              DOM wiring: scrolling, lens, letter strip, integrity check
  sw.js               service worker template
  static/             copied to dist/ as is: icons, manifest, robots.txt, CNAME
wordlist/english.txt  the official BIP39 English wordlist
scripts/              build, serve, icons, e2e
test/                 tests run by node --test
.github/workflows/    test, build and deploy to GitHub Pages
```

## Deploy

`.github/workflows/pages.yml` runs the tests and the build for every push and pull request. It deploys `dist/` to
GitHub Pages on pushes to `main` or `master` and on manual runs. Actions are pinned to commit SHAs, and each job
gets only the token permissions it needs.

One-time setup:

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Settings → Pages → Custom domain: `bip39.uuid.me`, then Save. For Actions deployments GitHub ignores the `CNAME`
   file in the build, so the domain must be set here.
3. At the DNS provider for uuid.me, add a CNAME record `bip39` → `ilyacoding.github.io`.
4. Once the DNS check passes, tick **Enforce HTTPS**. The certificate can take a while.

Notes:

- GitHub recommends first verifying `uuid.me` under your account's Settings → Pages, which prevents domain takeover.
- GitHub Pages for a private repository needs a paid plan.
- Deployments go through the `github-pages` environment. If its protection rules reject a branch, allow the branch
  under Settings → Environments.

## Verify it yourself

The wordlist is the official one:

```sh
shasum -a 256 wordlist/english.txt
curl -s https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt | shasum -a 256
# both: 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
```

The deployed page is built from this code. The build is reproducible: it has no timestamps, and the same commit
always produces the same bytes. All the CSS, JavaScript and words are inside `index.html`:

```sh
npm run build && shasum -a 256 dist/index.html
curl -s https://bip39.uuid.me/ | shasum -a 256    # should match when built from the deployed commit
```

The in-page check runs on every load. Your browser computes a SHA-256 with Web Crypto over the words the page
actually rendered, joined by newlines with a trailing newline, which is byte for byte `english.txt`. It compares the
result with the hash embedded at build time. The result appears at the end of the list, next to the expected hash
in groups of eight characters. On a mismatch, the page shows a warning not to use it.

The check catches build and rendering mistakes. A malicious server could change both the words and the expected
hash, so compare the displayed hash with the one above and with the reproducible build.
