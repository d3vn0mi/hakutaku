// The stylesheet main.ts imports for its side effect: esbuild bundles it into app.css, and the
// typechecker, which resolves every side-effect import, takes it as a module with no exports.
declare module "*.css";
