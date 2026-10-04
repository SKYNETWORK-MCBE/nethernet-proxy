import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: true,
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ['bds/**', 'cache/**', 'dist/**'],
  },
  fmt: {
    semi: false,
    singleQuote: true,
    ignorePatterns: ['bds/**', 'cache/**', 'dist/**', 'pnpm-lock.yaml', 'docs/api-design.md'],
  },
})
