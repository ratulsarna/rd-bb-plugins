# Third-party notices

This package ships code and artwork from the projects below. Licence details
are listed with each project.

## web-push

- Package: `web-push`
- Version: `^3.6.7`
- Licence: Mozilla Public License 2.0
- Copyright 2015 Marco Castelluccio
- Home: https://github.com/web-push-libs/web-push
- Where it ships: the build inlines the Web Push encryption and sender code in
  `dist/server.js`.

The package carries this notice:

> This Source Code Form is subject to the terms of the Mozilla Public License,
> v. 2.0. If a copy of the MPL was not distributed with this file, You can
> obtain one at https://mozilla.org/MPL/2.0/.

Its bundled runtime dependencies are MIT licensed: `asn1.js`, `bn.js`,
`inherits`, `minimalistic-assert`, `safer-buffer`, `http_ece`,
`https-proxy-agent`, `agent-base`, `debug`, `ms`, `jws`, `jwa`,
`buffer-equal-constant-time`, `ecdsa-sig-formatter`, `safe-buffer`, and
`minimist`. The MIT text below applies to them.

## Zod

- Package: `zod`
- Version: `^4.3.6`
- Licence: MIT
- Copyright (c) 2025 Colin McDonnell
- Home: https://github.com/colinhacks/zod
- Where it ships: the build inlines Zod into `dist/server.js`.

## Hugeicons Free Icons

- Package: `@hugeicons/core-free-icons`
- Version: `4.2.3`
- Licence: MIT, as declared in the package metadata
- Copyright (c) Hugeicons
- Home: https://hugeicons.com
- Where it ships: the path data of the `BellIcon` glyph is copied into
  `assets/icon.svg`, `assets/logo.svg`, and `assets/logo-dark.svg`.

## Tailwind CSS

- Package: `tailwindcss`
- Version: `4.3.0`
- Licence: MIT
- Copyright (c) Tailwind Labs, Inc.
- Home: https://tailwindcss.com
- Where it ships: the bb plugin build generates `dist/app.css` with Tailwind
  CSS. That file keeps the Tailwind licence banner on its first line.

## MIT licence text

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
