/**
 * dsh-governor-mode —— 宿主半。
 *
 * 功能全部在浏览器半：这一行存在的唯一目的是让宿主下发本包的 `dsh.client` bundle。
 *
 * @module dsh-governor-mode
 */

/** Cordis 插件名（loader 行 id）。 */
export const name = 'governor-mode'

export function apply(_ctx) {
  // 无宿主侧行为：总督模式完全跑在浏览器半。
}
