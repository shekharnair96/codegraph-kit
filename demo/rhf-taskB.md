# Task: rename the `getFieldValue` function to `readFieldValue`

Repo: react-hook-form (this repo). Source in `src/`, tests in `src/__tests__/`.

Rename the function `getFieldValue` (default export of `src/logic/getFieldValue.ts`) to
`readFieldValue` everywhere it is declared, imported, or called — including in test files.

Constraints:
- Do NOT rename the file `src/logic/getFieldValue.ts` (import paths stay `./getFieldValue`),
  and do NOT rename any test file.
- Do NOT rename `getFieldValueAs` (a different function that lives in the same file) or touch
  any of its call sites or its test file's assertions.

Done means: no identifier `getFieldValue` remains (except in file paths and in the name
`getFieldValueAs`), and the full jest suite passes (1302+ tests).
