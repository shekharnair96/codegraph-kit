# Task: guard `has()` against prototype-pollution paths

Repo: react-hook-form (this repo). Source in `src/`, tests in `src/__tests__/`.

`src/utils/get.ts`, `src/utils/set.ts`, and `src/utils/unset.ts` all reject paths containing
prototype keywords using the `PROTOTYPE_KEYWORDS` constant from `src/constants.ts`.
`src/utils/has.ts` does not use that constant.

Make this change:

1. In `src/utils/has.ts`: import `PROTOTYPE_KEYWORDS` from `../constants` and return `false`
   early when any segment of the resolved path (the same `isKey(path) ? [path] : stringToPath(path)`
   segments the function already iterates) is included in `PROTOTYPE_KEYWORDS`. The guard must run
   before any property lookups.
2. In `src/__tests__/utils/has.test.ts`: add assertions that `has({}, 'a.constructor.b')`,
   `has({}, 'a.prototype.b')`, and `has({ a: {} }, 'a.__proto__')` are all falsy.

Do NOT modify `src/utils/get.ts`, `src/utils/set.ts`, `src/utils/unset.ts`, or `src/constants.ts`.

Done means: the full jest suite passes (1302+ tests, including your new assertions).
