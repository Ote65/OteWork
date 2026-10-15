/**
 * dsh-element-picker — host half.
 *
 * The feature lives entirely in the browser half. This row exists so the harness
 * serves the package's `dsh.client` bundle into the boot graph; it owns no
 * route, no service and no state, so `apply` is deliberately empty.
 *
 * Only the Cordis plugin name is exported. No `@deepseek-ai/dsh-*` peer is
 * declared, so the runtime's compatibility gate cannot block the install.
 *
 * @module dsh-element-picker
 */

/** Cordis plugin name. */
export const name = 'element-picker'

/**
 * Host plugin body: intentionally empty.
 * @param _ctx - owning Cordis context (unused).
 */
export function apply(_ctx) {
  // No host-side behaviour: the picker runs in the browser half.
}
