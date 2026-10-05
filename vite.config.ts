import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ['bds/**', 'cache/**', '**/dist/**'],
  },
  fmt: {
    semi: false,
    singleQuote: true,
    ignorePatterns: ['bds/**', 'cache/**', '**/dist/**', 'pnpm-lock.yaml', 'docs/api-design.md'],
  },
})
