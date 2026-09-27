# Security

This page shows the 2048 BIP39 English words so you can check a word from a recovery phrase without typing it
anywhere. This document covers what the page protects, how each protection is enforced and tested, and what it
cannot protect. It is written for users and for anyone auditing the code.

No website can be guaranteed unhackable. The page controls only its own code. Your device, browser, extensions,
operating system, network and the hosting service are outside its control, and the risks they bring are listed
below.

## Threat model

**What is at stake.** The words of your recovery phrase. The list itself is public and identical for everyone, so
the secret is *which* word you look at and when: your scroll position and the moment you stop scrolling.

**Who might want it.**

- The network and the host: your ISP, Wi-Fi operator, DNS resolver, GitHub Pages and its CDN (Fastly).
- Other websites that link to, frame or open this page.
- Software on your device that can see pages or the screen: browser features, extensions, assistants,
  accessibility services, screenshot and screen-history tools, and OS logs.
- Someone who uses your device later and looks at history, tab thumbnails or caches.
- Anyone able to change what is deployed: the repository, the CI pipeline, the GitHub account or DNS.

**Trust boundaries.** Everything runs in your browser. The server delivers static files, and nothing is sent
back. When you use the site you trust your device, your browser, GitHub (the code and the hosting) and the TLS
certificate system. You can remove GitHub and the network from that list by using a verified copy saved to your
device (see [Safest way to use it](#safest-way-to-use-it)).

## What the page guarantees

These guarantees cover the page's own code in current Chrome and Safari. The next section lists what they cannot
cover. Every row has an automated check in `scripts/e2e.mjs` (IDs in brackets), run in headless Chrome by
`npm run e2e`. The key checks were also repeated by hand in iOS 27 Safari in the iOS Simulator: request log,
storage, Trusted Types, CSP, selection and framing.

| Guarantee | How it is enforced | Tested by |
|---|---|---|
| Nothing you look at leaves the device. Loading the page fetches only its own static files, and nothing is requested afterwards. | One inline script and one inline stylesheet, pinned by their SHA-256 in a Content Security Policy: `default-src 'none'`, `connect-src 'none'`, no third-party sources. The code listens only to scroll, viewport and visibility events, plus passive pointer, touch, wheel and key listeners that note which strip you are using. It never reads pointer or touch coordinates. | [b] [p1] [p16]: no request while scrolling, flinging, using the keyboard, wheel or rotation, or while in the background. [p4]: a runtime spy wraps more than 40 network, storage, history and URL APIs, and page code calls none of them except `serviceWorker.register('./sw.js')`. [p5]: static scan of the shipped code. |
| Nothing is stored about what you looked at. | No cookies, localStorage, sessionStorage or IndexedDB. The URL, title and history are never changed, and scroll restoration is off. The service worker stores only the static files listed in `sw.js`. It refreshes its copy of the page only from a visit to the bare address, never from one with a query such as `?utm_…`. | [p2]: storage is empty after heavy use, and Cache Storage holds exactly the `sw.js` asset list. [p3]: URL, title, `window.name` and session history are unchanged. [p15]: returning via back/forward shows "abandon", not the last word. |
| No word is highlighted. | All rows are styled identically. A screen recording or screenshot shows a screenful of equally styled words, and only the letter strip shows the current letter. | [n]: DOM, computed styles, overlapping elements and screen pixels of the centred row compared with other rows. |
| There is nothing to type, tap, select, copy or translate. | No inputs, buttons, forms or links. `user-select: none` and `-webkit-touch-callout: none` everywhere, so no copy menu, Look Up or Touch to Search can pick up a word. `translate="no"` and `<meta name="google" content="notranslate">` keep the text away from translation services, which would otherwise receive the words near your scroll position. | [c] [p10]: double and triple click, drag, right click, select-all, long-press and `execCommand` all select nothing, and a clipboard sentinel survives Cmd/Ctrl+C. |
| No code but the site's runs. | Script and style are allowed only by hash. Trusted Types are enforced, and the single policy `bip39` allows only the URL `./sw.js`. | [p8]: 12 HTML and script string sinks, 2 foreign policy names, `eval` and `new Function` are all refused. [p9]: injected fetch, XHR, beacon, WebSocket, EventSource, image, CSS, font, `import()`, iframe and form never reach a test attacker server. [a]: no CSP violation in normal use. |
| Hostile links are inert. | The page never reads its URL, query, hash, referrer, `window.name` or messages. | [p5] [p7]: script, image and `javascript:` payloads in the query, hash, referrer and `window.name` leave the DOM byte-identical. |
| Other sites cannot read the page. | Inside a frame, the page hides itself and skips the service worker. A site that opens it gets no access (same-origin policy). | [p11]: framed pixels are blank, and no worker is registered in the framing site's storage. [p12]: the opener gets SecurityError on every read, and `javascript:` navigation is refused. |
| It works offline and as a single saved file. | Everything is inside `index.html`. | [p13]: `file://`, network off, 2048 words, integrity check ok. [j] [p6]: offline reload is served by the service worker. |
| The list is the official one. | On every load, the page hashes the words it rendered and compares the result with the SHA-256 of `english.txt` from bitcoin/bips, embedded at build time. On a mismatch it shows a warning. This catches build and rendering errors. It does not protect against a malicious server, which could change both the words and the hash. | [d], unit and build tests |

## What it cannot protect against

- **Anything that sees your screen sees the words on it.** This includes screenshots, screen recording and
  sharing, cameras and people nearby, and assistants that read the screen: Gemini, Apple Intelligence, Circle to
  Search, and screen-history tools such as Windows Recall. Because no word is highlighted, they see a screenful of
  equal words. The section you are viewing, and the moment you stop scrolling, are still visible, as with any list.
- **App-switcher and tab snapshots.** The page blanks itself when it is hidden, but this is best effort. In the
  iOS 27 simulator, Safari saved its app-switcher snapshot before the page could react, and the snapshot on disk
  shows the list. The same applies to Chrome tab thumbnails, back-swipe previews and Android's recent-apps screen.
  Scroll back to the top, or close the tab, before switching apps.
- **Browser and OS features that read or log pages.** These are outside the site's control:
  - extensions allowed on all sites;
  - accessibility services;
  - crash reports;
  - safe-browsing and other telemetry;
  - history and history sync.
  In the iOS 27 simulator, iOS stored this page's full text and URL in its on-device logs for Siri and Spotlight.
  The text is the public list, so the log shows that you opened the page, not which word you looked at. The page
  never puts anything in its URL, partly because operating systems record visited URLs.
- **Your own typing elsewhere.** Typing a word into the browser's find-in-page bar, a search engine or a note puts
  the word back into the keyboard, autofill and history risks this page avoids.
- **The network and the host.** Your DNS resolver, ISP and Wi-Fi operator see that you visited `bip39.uuid.me`,
  through the DNS lookup and the unencrypted hostname (SNI) in the TLS handshake. GitHub Pages and Fastly see your
  IP address, the time and your browser for each page load, and GitHub logs visitor IPs. None of them see which
  word you look at, because no request is made while you use the page. A reload fetches the page again, and the
  browser then re-checks `sw.js`.
- **First visit over `http://`.** There is no HSTS header and no preload entry for this domain, so on a hostile
  network a visit typed as `http://bip39.uuid.me` could be downgraded and served a fake page. Type `https://` or
  use a bookmark.
- **Headers GitHub Pages cannot send.** Without `frame-ancestors`, X-Frame-Options, Cross-Origin-Opener-Policy or
  Permissions-Policy:
  - An `<iframe sandbox>` without `allow-scripts` stops the page's frame check, so the list renders inside the
    other site ([r1]). There is nothing to click, the content is public, and the framing site cannot read it.
  - On a slow network, a framed copy can show the first rows until the script at the end of the file arrives.
  - A site that opened this page with `window.open()` can later send the tab to another address ([r2]), for
    example a look-alike page with a search box. Open the page yourself, typed or from a bookmark.
- **Limits of CSP.** CSP stops fetch-style requests. It does not govern navigations, WebRTC, preconnect or DNS
  prefetch; a meta CSP cannot restrict them, and Chrome rejects the `webrtc` directive. Using them would require
  script that is already running, which the hash-only CSP and Trusted Types prevent.
- **JavaScript turned off.** The list still scrolls and snaps ([p14]), but there is no frame hiding, no blanking
  when hidden, and no integrity check.
- **Crafted links.** A link with a `#fragment`, such as `#h-m` or a `#:~:text=` text fragment, can open the list at
  a place the link's author chose. This is a browser feature. Nothing flows back to the author, but such a link
  does not start at "abandon". Start from the bare address.
- **Supply chain.** Someone who controls the GitHub account, the repository, the CI workflow or the DNS could
  deploy a malicious page. Browsers that load it would keep its service worker until a fixed `sw.js` replaces it.
  Verify what you run (see below), or use a verified saved copy.
- **A compromised device.** Malware, a malicious keyboard, browser or OS, or a rooted or jailbroken phone can read
  anything. No web page can defend against that.

## Safest way to use it

1. Get a copy you have verified: build it yourself from a commit, or download `index.html` and compare its SHA-256
   with your own build or with the hashes in the workflow run (see below).
2. Save that single `index.html` on the device you will use. It contains everything and needs no network.
3. Turn on airplane mode.
4. Open the file in a private window. Extensions are usually off there, and the visit is kept out of the browser
   history.
5. Take no screenshots or recordings, don't share the screen, don't invoke assistants, and don't use find-in-page.
6. After checking your word, scroll back to the top and close the window before switching apps. Then reconnect.

On a phone where a saved file is impractical:

1. Open `https://bip39.uuid.me/` in a private tab, typed or from a bookmark.
2. Wait until it has loaded. The page is one file and needs nothing more.
3. Turn on airplane mode, then follow steps 5 and 6.

## Verifying a build

- **Wordlist.** `wordlist/english.txt` has the SHA-256 `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`,
  the same as `bip-0039/english.txt` in bitcoin/bips.
- **Reproducible build.** The build has no timestamps, and the same commit gives the same bytes on any machine. CI
  rebuilds under another time zone and locale and compares byte for byte. Each workflow run summary lists the
  SHA-256 of every built file. The deployed files are byte-identical to a local build of the deployed commit
  (Deployments → github-pages):
  ```sh
  npm run build && shasum -a 256 dist/index.html
  curl -s https://bip39.uuid.me/ | shasum -a 256
  ```
- **Signed provenance.** Deployments from a public repository carry a GitHub artifact attestation, recorded in
  Sigstore's public log, that ties each file's hash to the commit and workflow run that built it:
  ```sh
  curl -s https://bip39.uuid.me/ -o index.html
  gh attestation verify index.html --repo ilyacoding/bip39-viewer
  ```
  Commit `f361bbb`, live at the time of writing, predates this, so its hashes can only be checked by rebuilding.
- **Tests.** `npm test` runs the unit and build tests. `npm run e2e` runs the browser checks, including the privacy
  checks `p1`–`p16` above.

## Service worker kill switch (maintainers)

If the offline copy ever has to go:

1. Deploy a `sw.js` whose `activate` handler deletes every `bip39-*` cache and calls
   `self.registration.unregister()`. It must have no `fetch` handler.
2. Remove the registration call from `app.js`.
3. Keep that `sw.js` deployed for months. Browsers re-check `sw.js` at least every 24 hours, but only when the
   site is visited.

## Reporting a vulnerability

Please report security problems privately through GitHub: go to the
[Security tab of ilyacoding/bip39-viewer](https://github.com/ilyacoding/bip39-viewer/security/advisories/new) and
choose "Report a vulnerability". Do not open a public issue.

Include:

- the browser, its version and the OS;
- the steps to reproduce;
- what leaks or persists, and to whom.

Never include real recovery words. Use made-up examples.

In scope: this repository's code, build, service worker and deployment workflow. Out of scope: bugs in browsers,
operating systems, GitHub or Fastly (report those to their vendors), and attacks that need an already compromised
device. Please allow reasonable time for a fix before publishing details.
