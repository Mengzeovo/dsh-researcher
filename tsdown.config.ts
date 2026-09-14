import { defineConfig } from 'tsdown'

const id = 'dsh-profile-researcher'
const clientExternals = new Set([
  '@deepseek-ai/cordis',
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-commands',
])

export default defineConfig({
  entry: ['lib/client/index.js'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: source => clientExternals.has(source),
    alwaysBundle: source => !clientExternals.has(source),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
