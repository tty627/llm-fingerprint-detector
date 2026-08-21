# Third-Party Notices

## PAMELA / Bruckner 2026 author artifacts

This distribution contains a derived, exact Study A prompt profile at
`data/profiles/bruckner-2026-canonical40.json`. Its four system prompts and
ten tasks in four languages are copied exactly from the author's archived
`config/prompts.json`; only the `paper == 1` tasks are retained. The profile's
provenance wrapper is original to this project.

- Copyright © 2026 Tomáš Bruckner
- Software DOI: `10.5281/zenodo.21278793`
- Source prompts version: `1.0.0`
- Source archive: `pamela-publish-code.zip`
- Source archive MD5: `d81de3b8ef5c0bca74fd7c2bdbb41a6b`
- Source archive SHA-256: `8a9c8db47609fd0682a44398e55a4e0b322cf3ae479c3189f0874aae928044ef`
- Archived `config/prompts.json` SHA-256: `32f4fc3ab5077438f362bb4d0c06d1ebbe2bb5d2e0809474045dcd60a6b592c1`
- Derived Study A canonical payload SHA-256: `9ef56c982a503b4dba94710b63866aaff47db1e37cc34538e225acb9f5fe1341`
- Archived `stats/01-normalize.js` SHA-256: `8f755ca604e4814126c253f44135199b1636ddfedcb070fa4ece3368fb858fa8`

`src/normalizers/bruckner2026.ts` is a clean-room implementation of the
documented normalization behavior. It does not copy the archived normalizer's
source text. The exact prompt profile and the clean-room normalizer are kept
separate so consumers can distinguish copied author content from independently
implemented compatibility code.

The archived software package declares the MIT License. The license text is:

> MIT License
>
> Copyright (c) 2026 Tomáš Bruckner
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Bruckner 2026 public dataset excerpts

`test/fixtures/bruckner2026-author-golden.json` contains a small attributed
selection of normalized records from the author's public dataset. The fixture
retains fixed source keys and is used only for offline compatibility tests; it
does not reproduce the paper's ROC or EER analysis.

- Creator: Tomáš Bruckner
- Dataset: *Single-token output distributions as behavioral fingerprints of
  large language models - data*
- DOI: `10.5281/zenodo.21278557`
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- Source archive MD5: `f2ce3fba3081f73e9908179fb2f061b6`
- Source archive SHA-256: `160104321694472ba328d48de6f6b93ee962d0e97fb4d212a023efa5a2de9f7c`
- Source `data/derived/normalized.jsonl` SHA-256:
  `627c00076090f70db2feb154c88eb31eabf804dbbb100e249c2281dfaae5d237`

The excerpts are unchanged apart from selection and JSON fixture grouping.
The full dataset and license record are available from the DOI above.
