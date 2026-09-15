/**
 * tsdown preset for dsh-sidechain: an ESM node half with declarations plus a
 * browser half (lib/client.js) wrapped for the harness client-plugin loader.
 * The node half keeps Schemastery unbundled because the Loader validates the
 * plugin's `Config` schema and must see its own Schemastery instance; the
 * browser half keeps the platform module table external (React, Cordis,
 * loader seeds) and
 * bundles everything else inline.
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-sidechain'

/** Module specifiers the dsh web shell shares into its frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/**
 * Externals resolved from the loader module table. The table answers exactly
 * the platform seed words: every other package is either inlined here or
 * reached through a cordis service, so the browser half never requires a
 * specifier the shell cannot answer.
 */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      // Schemastery stays unbundled because the Loader validates the plugin's
      // `Config` schema and must see its own Schemastery instance; Cordis is
      // type-only in this bundle.
      neverBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cordis'],
    },
  },
  {
    // Browser bundle: lib/client.js, served by the harness at /plugins/<id>/client.js.
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
