/**
 * dsh-picker-probe — throwaway diagnostic.
 *
 * Beacons the moment its client half evaluates, so a missing beacon means the
 * client graph never delivered the bundle (rather than the plugin failing).
 *
 * @module dsh-picker-probe/client
 */

/** The local test server that collects beacons. */
var SERVER = 'http://127.0.0.1:5399'

/** Send one trace line through an <img>, which needs no CORS. */
function beacon(message) {
  try {
    var image = new Image()
    image.src = SERVER + '/beacon?m=' + encodeURIComponent(message)
  } catch (error) { /* tracing must never break the probe */ }
}

beacon('probe-client-evaluated')

window.__ModuleLoader__.load({
  id: 'dsh-picker-probe',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    beacon('probe-factory-entered')

    function apply() {
      beacon('probe-apply-entered')
    }

    exports.name = 'picker-probe'
    exports.apply = apply
    exports.inject = []
    beacon('probe-exports-set')
    return module.exports
  },
})
