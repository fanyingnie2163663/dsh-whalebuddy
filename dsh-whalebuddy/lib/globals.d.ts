/**
 * DSH Web client runtime global: the module loader that bootstraps client
 * plugins. Declared here so `tsc --checkJs` knows its shape.
 */
declare global {
  interface Window {
    __ModuleLoader__: {
      load(module: { id: string; factory(): unknown }): void
    }
  }
}

export {}
