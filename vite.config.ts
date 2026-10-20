import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [{
    name: 'native-file-entry',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html
          .replace(/<script\b([^>]*?)\btype=["']module["']([^>]*)>/gi, '<script$1defer$2>')
          .replace(/<link\b[^>]*\brel=["']modulepreload["'][^>]*>\s*/gi, '')
          .replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
      },
    },
  }],
  build: {
    outDir: 'dist',
    cssCodeSplit: false,
    assetsInlineLimit: (path) => /\.(woff2?|ttf|otf)$/i.test(path) ? true : undefined,
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5173,
  },
});
