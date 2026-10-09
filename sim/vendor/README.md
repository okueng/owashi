# Vendored libraries

Copied here so the sim starts with no internet (gigs). Downloaded from cdn.jsdelivr.net and checked against
jsDelivr's SHA-256 hashes. Only the files the sim imports are included.

| Folder | Package | Version | License |
|---|---|---|---|
| `three/` | three | 0.170.0 | MIT |
| `preact/` | preact (+ hooks) | 10.29.8 | MIT |
| `htm/` | htm | 3.1.1 | Apache-2.0 |
| `preact-signals/` | @preact/signals | 2.11.2 | MIT |
| `preact-signals-core/` | @preact/signals-core | 1.14.4 | MIT |

To update one, replace its files with the same paths from the new version and bump the import map in `../index.html`.
