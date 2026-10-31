# ImpulseM Web K

ImpulseM Web K is the web client of the ImpulseM platform, built with Solid.js and TypeScript.
Based on Webogram, patched and improved.

## Build

Requirements: Node.js `^22.18.0 || >=24.11.0` and pnpm.

```bash
pnpm install
pnpm start        # dev server on http://localhost:8080/
pnpm run build    # production build into dist/ (also runs tests and typecheck)
```

Details for contributors are in [AGENTS.md](AGENTS.md). Docker targets are defined in [docker-compose.yaml](docker-compose.yaml).

## Build variables

The build reads these variables. Set them in `.env.local` (git-ignored, see `.env.local.example`) or as environment variables. CI takes them from the organisation variables `vars.IMPULSEM_*`.

| Variable | What it does | When empty |
|---|---|---|
| `IMPULSEM_RPC_URL` | Base URL of the transport host, for example `https://rpc.example.org`. The websocket endpoints are derived from it. | CI app builds fail with a clear message. Local and test builds make no connection attempt and stay not connected. |
| `IMPULSEM_SITE_URL` | Base URL of the project website, without trailing slash, for example `https://example.org`. Website, terms, privacy and download links are built from it. | Menu entries and buttons for website links are hidden; text is shown without links. |
| `IMPULSEM_LINK_HOST` | Host without scheme of public share links (the t.me equivalent), for example `o.example.org`. | No host is recognised statically; link recognition relies on the server prefix and the app URL scheme. UI that needs a host to build a link is hidden. |
| `IMPULSEM_WEB_URL` | URL of this web client, for example `https://web.example.org/k`. | "Open the web version" links are hidden. |
| `IMPULSEM_TRANSLATIONS_URL` | Base URL of the translations export. Used only by `pnpm apply-new-lang`. | Only `pnpm apply-new-lang` needs it. The app build does not. |

## Dependencies

* [BigInteger.js](https://github.com/peterolson/BigInteger.js) ([Unlicense](https://github.com/peterolson/BigInteger.js/blob/master/LICENSE))
* [fflate](https://github.com/101arrowz/fflate) ([MIT License](https://github.com/101arrowz/fflate/blob/master/LICENSE))
* [cryptography](https://github.com/spalt08/cryptography) ([Apache License 2.0](https://github.com/spalt08/cryptography/blob/master/LICENSE))
* [emoji-data](https://github.com/iamcal/emoji-data) ([MIT License](https://github.com/iamcal/emoji-data/blob/master/LICENSE))
* [emoji-test-regex-pattern](https://github.com/mathiasbynens/emoji-test-regex-pattern) ([MIT License](https://github.com/mathiasbynens/emoji-test-regex-pattern/blob/main/LICENSE))
* [tlottie](https://github.com/dkaraush/tlottie) (MIT License)
* [fast-png](https://github.com/image-js/fast-png) ([MIT License](https://github.com/image-js/fast-png/blob/master/LICENSE))
* [opus-recorder](https://github.com/chris-rudmin/opus-recorder) ([BSD License](https://github.com/chris-rudmin/opus-recorder/blob/master/LICENSE.md))
* [Prism](https://github.com/PrismJS/prism) ([MIT License](https://github.com/PrismJS/prism/blob/master/LICENSE))
* [Solid](https://github.com/solidjs/solid) ([MIT License](https://github.com/solidjs/solid/blob/main/LICENSE))
* [TinyLD](https://github.com/komodojp/tinyld) ([MIT License](https://github.com/komodojp/tinyld/blob/develop/license))
* [libwebp.js](https://libwebpjs.appspot.com/)
* fastBlur
* [Mediabunny](https://github.com/Vanilagy/mediabunny) ([Mozilla Public License 2.0](https://github.com/Vanilagy/mediabunny/blob/main/LICENSE))
* [Temml](https://github.com/ronkok/Temml) ([MIT License](https://github.com/ronkok/Temml/blob/main/LICENSE))

## License

The source code is licensed under GPL v3. See [LICENSE](LICENSE).
