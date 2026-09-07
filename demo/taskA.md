In this repository (react-hot-toast), change two default timing values in the library source under src/:

1. The default delay before a dismissed toast is removed from the DOM is 1000 ms. Change it to 1500 ms. This default is defined by more than one constant in src/ (one in the toaster hook, one in the store); change every definition so they stay consistent.
2. The default auto-dismiss duration for `success` toasts is 2000 ms. Change it to 3000 ms. Leave the other toast types' durations alone.

Do not touch the site/ docs, and do not change the promise-related delays in the tests. The existing test suite in test/toast.test.tsx must still pass; update it only if a test hard-codes one of the old values.
