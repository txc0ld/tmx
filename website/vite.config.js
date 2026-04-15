// When deployed to GitHub Pages under https://txc0ld.github.io/tmx/
// the site lives at /tmx/. In dev / with a custom domain, base is '/'.
// The GH_PAGES env var is set by the deploy workflow.
const base = process.env.GH_PAGES === 'true' ? '/tmx/' : '/';

export default {
  base,
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
};
