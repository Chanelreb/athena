# Tests

Plain node, no dependencies, no build. Run them all:

    node tests/run.cjs

Or one on its own:

    node tests/duplicates.test.cjs

They read `app.js` and `api/ai.js` off disk and check properties of the
source, rather than importing it: `app.js` is one large IIFE with no exports,
so there is nothing to import. That sounds weak and is not, for the things it
is used on here. The bugs worth a test in this project have nearly all been
of the form "this rule is no longer enforced anywhere", and the shape of the
code is exactly what says whether it still is.

These used to live in a temporary folder outside the project and were lost
when it was cleared. That is why they are here now.
