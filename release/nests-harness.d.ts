// The in-source tests' harness modules (tests/nests/*.harness.ts) are in the development
// checkout only, like suede.nests itself (nests.d.ts beside this). Tests import them as types,
// which node erases, so the release needs them only to type-check: there, where the import
// finds no file, this shorthand declaration makes everything it names `any`. In the
// development checkout the real module is found first, and this is never consulted.
declare module "*.harness.ts";
