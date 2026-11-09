/**
 * Client half placeholder: this lazy factory is loaded by the DSH Web module
 * loader and its id must equal the package name. It renders nothing yet;
 * later tasks register the colleague UI here through `ctx.slots`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-whalebuddy',
  factory() {
    return {
      inject: [],
      apply() {},
    }
  },
})
