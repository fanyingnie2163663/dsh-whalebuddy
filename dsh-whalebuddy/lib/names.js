/**
 * The default colleague name pool. A name carries a temperament, so picking a
 * name is picking a personality (design §7.3). Every entry is deliberately
 * spelled out here: the order is the order shown to the user.
 *
 * @typedef {object} DefaultName
 * @property {string} name
 * @property {string} nameEn
 * @property {string} temperament
 */

/** @type {DefaultName[]} */
export const DEFAULT_NAMES = [
  { name: '小白', nameEn: 'Beluga', temperament: '温和、耐心，适合日常与陪伴' },
  { name: '逆戟', nameEn: 'Orca', temperament: '锋利、直接、话少，适合写码与挑错' },
  { name: '座头', nameEn: 'Humpback', temperament: '爱唱爱总结，适合复盘与讲故事' },
  { name: '一角', nameEn: 'Narwhal', temperament: '钻研、刨根问底，适合研究与查资料' },
  { name: '蓝鲸', nameEn: 'Blue', temperament: '大、稳、扛重活' },
]
