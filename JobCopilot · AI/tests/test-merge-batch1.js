// ===== 第一批合并测试：薪资字体解码 + HR 称呼 + GET_STATE 恢复 =====
'use strict';
const assert = require('assert');
const vm = require('vm');
const { define, readSrc, makeChrome, loadSW, makeFetchQueue, makeDom } = require('./helpers');

function loadFilters() {
  const module_ = { exports: {} };
  const fn = new Function('module', 'exports', 'self', 'window', readSrc('filters.js'));
  fn(module_, module_.exports, globalThis, globalThis);
  return module_.exports;
}

function loadSalary() {
  const module_ = { exports: {} };
  const fn = new Function('module', 'exports', 'self', 'window', readSrc('salary.js'));
  fn(module_, module_.exports, {}, {});
  return module_.exports;
}

// PUA salary digit for codepoint U+E031+n (built via fromCharCode to keep this file plain ASCII here)
function E(n) { return String.fromCharCode(0xe031 + n); }

function loadBgCtx() {
  const chrome = makeChrome({});
  const ctx = loadSW(chrome, makeFetchQueue([]));
  return { chrome, ctx };
}

define('merge-batch1 薪资字体解码', t => {
  const F = loadFilters();
  const S = loadSalary();

  t('parseSalary 解码私有字体 4-5K', () => {
    assert.deepStrictEqual(F.parseSalary(E(4) + '-' + E(5) + 'K'), { min: 4, max: 5 });
  });
  t('parseSalary 解码私有字体 15-20K 13薪', () => {
    assert.deepStrictEqual(F.parseSalary(E(1) + E(5) + '-' + E(2) + E(0) + 'K·13薪'), { min: 15, max: 20 });
  });
  t('BOSS_SALARY.normalize 解码 3-4K', () => {
    assert.strictEqual(S.normalize(E(3) + '-' + E(4) + 'K'), '3-4K');
  });
  t('BOSS_SALARY.decodeDigits 只映射数字', () => {
    assert.strictEqual(S.decodeDigits(E(0) + E(9)), '09');
    assert.strictEqual(S.decodeDigits('10-15K'), '10-15K');
  });
  t('content-search parseCard 先解码再清洗薪资', async () => {
    const dom = makeDom();
    const list = dom.makeEl('div', 'job-list-box');
    dom.body.appendChild(list);
    const li = dom.makeEl('li', 'job-card-box');
    const a = dom.makeEl('a', '', '', { href: 'https://www.zhipin.com/job_detail/J9.html?ka=1' });
    a.appendChild(dom.makeEl('span', 'job-name', '数据分析师'));
    a.appendChild(dom.makeEl('span', 'job-salary', E(4) + '-' + E(5) + 'K'));
    li.appendChild(a);
    list.appendChild(li);
    const listeners = [];
    const chromeStub = { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } };
    const ctx = { console, chrome: chromeStub, document: dom.document, window: dom.window, setTimeout, clearTimeout, setInterval, clearInterval };
    ctx.self = ctx; ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(readSrc('selectors.js'), ctx, { filename: 'selectors.js' });
    vm.runInContext(readSrc('salary.js'), ctx, { filename: 'salary.js' });
    vm.runInContext(readSrc('content-search.js'), ctx, { filename: 'content-search.js' });
    const r = await new Promise(resolve => {
      for (const fn of listeners) fn({ type: 'SCRAPE', count: 5 }, {}, resolve);
    });
    assert.ok(r && r.success);
    assert.strictEqual(r.jobs[0].salary, '4-5K');
  });
});

define('merge-batch1 HR 称呼', t => {
  t('deriveCallName 女士后缀', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.deriveCallName({ hrName: '李女士' }), '李姐');
  });
  t('deriveCallName 先生后缀', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.deriveCallName({ hrName: '王先生' }), '王哥');
  });
  t('deriveCallName 纯姓名男性用字', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.deriveCallName({ hrName: '张伟' }), '张哥');
  });
  t('deriveCallName 纯姓名女性用字', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.deriveCallName({ hrName: '李静' }), '李姐');
  });
  t('deriveCallName 性别不确定返回 null', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.deriveCallName({ hrName: '王小明' }), null);
  });
  t('deriveCallName 空名返回 null', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.deriveCallName({ hrName: '' }), null);
  });
  t('withCallName 拼称呼且不重复您好', () => {
    const { ctx } = loadBgCtx();
    const out = ctx.withCallName('您好，我熟悉SQL，做过数据分析', '李姐');
    assert.ok(out.indexOf('李姐，您好！') === 0, '应以称呼开头: ' + out);
    assert.strictEqual(out, '李姐，您好！我熟悉SQL，做过数据分析');
  });
  t('withCallName 空入参返回空', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.withCallName('', '李姐'), '');
    assert.strictEqual(ctx.withCallName(null, '李姐'), '');
  });
  t('abortPendingLLM 已导出且无在途时不报错', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(typeof ctx.abortPendingLLM, 'function');
    ctx.abortPendingLLM();
  });
});

define('merge-batch1 GET_STATE 恢复', t => {
  t('内存无筛选结果时从存盘回填并回复 review', async () => {
    const { chrome, ctx } = loadBgCtx();
    await chrome.storage.local.set({
      sw_jobs: [{ id: 'J1', name: '数据分析师' }],
      sw_screened: [{ id: 'J1', name: '数据分析师', match: true, reason: '匹配' }]
    });
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    assert.ok(s, '应有回复');
    assert.strictEqual(s.phase, 'review');
    assert.strictEqual(s.screened.length, 1);
    assert.strictEqual(s.screened[0].id, 'J1');
  });
});
