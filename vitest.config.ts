import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Linked UI primitives and this checkout must share the same React hook dispatcher.
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 20_000,
  },
})
