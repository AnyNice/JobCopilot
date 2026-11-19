// ===== BOSS 薪资字体解码：纯函数、无 DOM/Storage 依赖（可单测） =====
// 来源：kunshanyep-beep 版 salary.js 的 normalize 实现（第一批合并移植）
// BOSS 列表 kanzhun 私有字体：U+E031…U+E03A 显示为 0…9，页面 textContent 拿到的是
// 私用区字符，若直接清洗会被当成图标字体删掉，薪资数字就丢了，必须先解码再清洗。
(function (root) {
  'use strict';

  function normalize(value) {
    // BOSS 列表 kanzhun 字体：U+E031…U+E03A 显示为 0…9。
    // 只转换已知数字区间；其他私有字符不猜测。
    return String(value || '').normalize('NFKC').replace(/[\ue031-\ue03a]/g, c => String(c.charCodeAt(0) - 0xe031)).trim();
  }

  // 只做 E031-E03A → 0-9 的映射，不做 NFKC / 去空白等其他处理
  function decodeDigits(value) {
    return String(value || '').replace(/[\ue031-\ue03a]/g, c => String(c.charCodeAt(0) - 0xe031));
  }

  const BOSS_SALARY = {
    normalize: normalize,
    decodeDigits: decodeDigits
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BOSS_SALARY;
  root.BOSS_SALARY = BOSS_SALARY;
})(typeof self !== 'undefined' ? self : this);
