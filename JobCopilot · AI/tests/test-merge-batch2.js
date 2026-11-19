// ===== 第二批合并测试：防投错人 fail-closed + 持续收集 + 求职类型 =====
'use strict';
const assert = require('assert');
const vm = require('vm');
const { define, readSrc, makeChrome, loadSW, waitFor, makeFetchQueue, makeDom } = require('./helpers');

const MATCH_JSON = '{"match":true,"reason":"方向匹配"}';

function loadBgCtx() {
  const chrome = makeChrome({});
  const ctx = loadSW(chrome, makeFetchQueue([]));
  return { chrome, ctx };
}

// ---------- 纯函数 ----------
define('merge-batch2 纯函数（精确链接/关键词/合并/搜索URL）', t => {
  t('getExactJobUrl 合法链接原样返回', () => {
    const { ctx } = loadBgCtx();
    const job = { id: 'abc123', link: 'https://www.zhipin.com/job_detail/abc123.html?ka=1' };
    assert.strictEqual(ctx.getExactJobUrl(job), 'https://www.zhipin.com/job_detail/abc123.html?ka=1');
  });
  t('getExactJobUrl id 不符返回空', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.getExactJobUrl({ id: 'abc123', link: 'https://www.zhipin.com/job_detail/zzz999.html' }), '');
  });
  t('getExactJobUrl 外域返回空', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.getExactJobUrl({ id: 'abc123', link: 'https://evil-zhipin.com/job_detail/abc123.html' }), '');
    assert.strictEqual(ctx.getExactJobUrl({ id: 'abc123', link: 'https://zhipin.com.evil.com/job_detail/abc123.html' }), '');
  });
  t('getExactJobUrl 无 link 返回空', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(ctx.getExactJobUrl({ id: 'abc123' }), '');
    assert.strictEqual(ctx.getExactJobUrl(null), '');
  });
  t('parseKeywords 切分去重', () => {
    const { ctx } = loadBgCtx();
    assert.strictEqual(JSON.stringify(ctx.parseKeywords('数据分析、前端, AI；测试\n数据分析')), JSON.stringify(['数据分析', '前端', 'AI', '测试']));
    assert.strictEqual(JSON.stringify(ctx.parseKeywords('数据分析')), JSON.stringify(['数据分析']));
    assert.strictEqual(JSON.stringify(ctx.parseKeywords('')), '[]');
  });
  t('mergeJobs 跨入口按 id 去重', () => {
    const { ctx } = loadBgCtx();
    const r = ctx.mergeJobs([{ id: 'A' }, { id: 'B' }], [{ id: 'B' }, { id: 'C' }]);
    assert.strictEqual(JSON.stringify(r.merged.map(j => j.id)), JSON.stringify(['A', 'B', 'C']));
    assert.strictEqual(r.added, 1);
    const r2 = ctx.mergeJobs([], [{ id: 'A' }, { id: 'A' }]);
    assert.strictEqual(r2.merged.length, 1);
    assert.strictEqual(r2.added, 1);
  });
  t('buildSearchUrl jobType=1902 带参数', () => {
    const { ctx } = loadBgCtx();
    const u = ctx.buildSearchUrl({ keyword: '数据分析', city: '北京', jobType: '1902' });
    assert.ok(u.indexOf('jobType=1902') >= 0, u);
  });
  t('buildSearchUrl jobType 为空不带参数', () => {
    const { ctx } = loadBgCtx();
    const u = ctx.buildSearchUrl({ keyword: '数据分析', city: '北京', jobType: '' });
    assert.ok(u.indexOf('jobType') < 0, u);
  });
  t('buildSearchUrl jobType 非法值不带参数', () => {
    const { ctx } = loadBgCtx();
    const u = ctx.buildSearchUrl({ keyword: '数据分析', city: '北京', jobType: '9999' });
    assert.ok(u.indexOf('jobType') < 0, u);
  });
});

// ---------- background 集成：投递守卫 / 持续收集 ----------
const J1 = { id: 'J1', name: '数据分析师', salary: '10-15K', company: '阿里科技有限公司', tags: ['SQL'], area: '北京·朝阳区', activeState: 'online', inviteCount: 10, link: 'https://www.zhipin.com/job_detail/J1.html?ka=1' };
const J2 = { id: 'J2', name: '前端工程师', salary: '15-25K', company: '字节跳动网络科技', tags: ['JS'], area: '北京', activeState: 'online', inviteCount: 5, link: 'https://www.zhipin.com/job_detail/J2.html?ka=2' };
const J3 = { id: 'J3', name: '测试工程师', salary: '12-20K', company: '正常科技', tags: [], area: '北京', activeState: 'online', inviteCount: 1, link: 'https://www.zhipin.com/job_detail/J3.html?ka=3' };

function baseCfg(extra) {
  return Object.assign({
    apiBaseUrl: 'https://api.test/v1/chat/completions', apiKey: 'sk-test', apiModel: 'test-model',
    resumeText: '熟练 SQL、Python，3 年数据分析经验', keyword: '数据分析', city: '北京', count: '5',
    filterConfig: { listMode: 'off', blacklist: [], whitelist: [] }
  }, extra || {});
}

function setupBg(opts) {
  opts = opts || {};
  const sent = [];
  const chrome = makeChrome({
    chatUrl: 'https://www.zhipin.com/web/geek/chat/1001',
    contentHandler: (tabId, msg) => {
      sent.push(msg);
      if (opts.onMessage) { const r = opts.onMessage(msg, sent); if (r !== undefined) return r; }
      if (msg.type === 'PING') return { success: true, alive: true };
      if (msg.type === 'SCRAPE') return { success: true, jobs: opts.jobs || [J1] };
      if (msg.type === 'OPEN_JD') return Object.assign({ success: true, jd: '岗位JD：负责数据分析', hrName: '王女士', addr: '', fundText: '' }, opts.openJd || {});
      if (msg.type === 'GO_CHAT') return Object.assign({ success: true, navigated: true }, opts.goChat || {});
      if (msg.type === 'SEND_ACTIVE') return { success: true, imageOk: true };
      return { success: false, error: 'unexpected: ' + msg.type };
    }
  });
  if (opts.cfg) for (const k of Object.keys(opts.cfg)) chrome._storageData.set(k, JSON.parse(JSON.stringify(opts.cfg[k])));
  if (opts.seed) for (const k of Object.keys(opts.seed)) chrome._storageData.set(k, JSON.parse(JSON.stringify(opts.seed[k])));
  const fetch_ = makeFetchQueue(opts.responses || []);
  loadSW(chrome, fetch_);
  return { chrome, fetch: fetch_, sent };
}

async function collectToReview(chrome) {
  const resp = await chrome.panelSend({ type: 'START_COLLECT' });
  assert.strictEqual(resp && resp.ok, true, 'START_COLLECT 应返回 ok');
  await waitFor(async () => {
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    return s && s.phase === 'review';
  }, 8000);
}
async function deliverAndWait(chrome, ids) {
  const resp = await chrome.panelSend({ type: 'START_DELIVER', jobIds: ids });
  assert.ok(resp && resp.ok);
  await waitFor(async () => {
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    return s && s.phase === 'done';
  }, 8000);
}
function logTexts(chrome) {
  return chrome.runtime._runtimeMessages.filter(m => m.type === 'LOG').map(m => m.text);
}

define('merge-batch2 投递 fail-closed 守卫', t => {
  t('OPEN_JD 失败：不生成招呼语、不建联、不发送', async () => {
    const { chrome, fetch, sent } = setupBg({
      cfg: baseCfg({}),
      responses: [MATCH_JSON],
      openJd: { success: false, error: '未找到岗位卡片', jd: '', hrName: '' }
    });
    await collectToReview(chrome);
    await deliverAndWait(chrome, ['J1']);
    assert.strictEqual(fetch._calls.length, 1, '只有 1 次筛选调用，招呼语不应生成');
    assert.ok(!sent.some(m => m.type === 'GO_CHAT'), '不应发 GO_CHAT');
    assert.ok(!sent.some(m => m.type === 'SEND_ACTIVE'), '不应发 SEND_ACTIVE');
    assert.ok(logTexts(chrome).some(x => x.indexOf('避免误投') >= 0), '应有避免误投日志');
  });

  t('OPEN_JD cardId 不一致：同样跳过不投', async () => {
    const { chrome, fetch, sent } = setupBg({
      cfg: baseCfg({}),
      responses: [MATCH_JSON],
      openJd: { cardId: 'OTHER' }
    });
    await collectToReview(chrome);
    await deliverAndWait(chrome, ['J1']);
    assert.strictEqual(fetch._calls.length, 1, '招呼语不应生成');
    assert.ok(!sent.some(m => m.type === 'GO_CHAT'), '不应发 GO_CHAT');
    assert.ok(logTexts(chrome).some(x => x.indexOf('卡片与所选岗位不一致') >= 0), '应有卡片不一致日志');
  });

  t('GO_CHAT cardId 不一致：招呼语已生成但绝不发送', async () => {
    const { chrome, fetch, sent } = setupBg({
      cfg: baseCfg({}),
      responses: [MATCH_JSON, '您好，熟悉SQL，做过数据分析。'],
      openJd: { cardId: 'J1' },
      goChat: { cardId: 'OTHER' }
    });
    await collectToReview(chrome);
    await deliverAndWait(chrome, ['J1']);
    assert.strictEqual(fetch._calls.length, 2, '筛选 + 招呼语各 1 次');
    assert.ok(!sent.some(m => m.type === 'SEND_ACTIVE'), '不应发 SEND_ACTIVE');
    assert.ok(logTexts(chrome).some(x => x.indexOf('建联的卡片与所选岗位不一致') >= 0), '应有建联不一致日志');
  });

  t('cardId 全程一致：正常投递且 SEND_ACTIVE 带身份字段', async () => {
    const { chrome, sent } = setupBg({
      cfg: baseCfg({}),
      responses: [MATCH_JSON, '您好，熟悉SQL，做过数据分析。'],
      openJd: { cardId: 'J1' },
      goChat: { cardId: 'J1' }
    });
    await collectToReview(chrome);
    await deliverAndWait(chrome, ['J1']);
    const sa = sent.find(m => m.type === 'SEND_ACTIVE');
    assert.ok(sa, '应发 SEND_ACTIVE');
    assert.strictEqual(sa.jobId, 'J1');
    assert.strictEqual(sa.company, '阿里科技有限公司');
    assert.strictEqual(sa.position, '数据分析师');
    const processed = await chrome.storage.local.get('processed');
    assert.ok(processed.processed.J1, '应记录已投');
  });
});

define('merge-batch2 持续收集（多入口/历史/进度）', t => {
  t('多关键词两入口跨入口去重合并', async () => {
    const scrapeCounts = [];
    const { chrome } = setupBg({
      cfg: baseCfg({ keyword: '甲、乙', count: '20' }),
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON],
      onMessage: (msg) => {
        if (msg.type === 'SCRAPE') {
          scrapeCounts.push(msg.count);
          return scrapeCounts.length === 1
            ? { success: true, jobs: [J1, J2] }
            : { success: true, jobs: [J2, J3] };
        }
      }
    });
    await collectToReview(chrome);
    assert.deepStrictEqual(scrapeCounts, [20, 18], '第二入口只补剩余数量');
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    assert.strictEqual(JSON.stringify(s.screened.map(j => j.id).sort()), JSON.stringify(['J1', 'J2', 'J3']));
    // batch3 口径：未投递不记硬历史；全部匹配不记软历史
    const hist = await chrome.storage.local.get(['collectedIds', 'collectedSoft']);
    assert.ok(!(hist.collectedIds || []).length, '未投递不应记硬历史');
    assert.ok(!hist.collectedSoft || !Object.keys(hist.collectedSoft).length, '全部匹配不应记软历史');
    const prog = await chrome.storage.local.get('searchProgress');
    assert.ok(!prog.searchProgress, '计划完成应清除进度');
  });

  t('软历史排除：同条件第二轮跳过已筛岗位且不调 AI，RESET 后清除', async () => {
    // batch3 口径：AI 正常剔除（match:false）只记软历史（绑定条件指纹），不记硬历史
    const NO_MATCH = '{"match":false,"reason":"方向不符"}';
    const { chrome, fetch } = setupBg({
      cfg: baseCfg({}),
      jobs: [J1, J2],
      responses: [NO_MATCH, NO_MATCH]
    });
    await collectToReview(chrome);
    const soft = await chrome.storage.local.get('collectedSoft');
    assert.deepStrictEqual(Object.keys(soft.collectedSoft || {}).sort(), ['J1', 'J2'], 'AI 正常剔除应记入软历史');
    const hard = await chrome.storage.local.get('collectedIds');
    assert.ok(!(hard.collectedIds || []).length, '未投递不应记硬历史');
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    await waitFor(() => logTexts(chrome).some(x => x.indexOf('已跳过同条件已筛岗位 2 个') >= 0), 8000);
    assert.strictEqual(fetch._calls.length, 2, '第二轮不应产生新的 AI 调用');
    await chrome.panelSend({ type: 'RESET' });
    const hist2 = await chrome.storage.local.get(['collectedIds', 'collectedSoft', 'searchProgress']);
    assert.ok(!hist2.collectedIds && !hist2.collectedSoft && !hist2.searchProgress, 'RESET 应清除硬/软历史与进度');
  });

  t('进度恢复：同 planKey 从未搜完的入口继续', async () => {
    const scrapeCounts = [];
    const { chrome } = setupBg({
      cfg: baseCfg({ keyword: '甲、乙', count: '20' }),
      seed: { searchProgress: { planKey: '甲、乙|北京|', nextEntryIndex: 1 } },
      responses: [MATCH_JSON],
      onMessage: (msg) => {
        if (msg.type === 'SCRAPE') { scrapeCounts.push(msg.count); return { success: true, jobs: [J2] }; }
      }
    });
    await collectToReview(chrome);
    assert.deepStrictEqual(scrapeCounts, [20], '只应搜第二个入口一次');
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    assert.strictEqual(JSON.stringify(s.screened.map(j => j.id)), JSON.stringify(['J2']));
    assert.ok(logTexts(chrome).some(x => x.indexOf('从第 2 个继续') >= 0), '应有续搜日志');
  });

  t('中止存进度：第一入口后停止，下轮入口下标被保存', async () => {
    let first = true;
    const env = setupBg({
      cfg: baseCfg({ keyword: '甲、乙', count: '20' }),
      responses: [],
      onMessage: (msg) => {
        if (msg.type === 'SCRAPE' && first) {
          first = false;
          env.chrome.panelSend({ type: 'STOP' });
          return { success: true, jobs: [J1] };
        }
        if (msg.type === 'SCRAPE') return { success: true, jobs: [J2] };
      }
    });
    const resp = await env.chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    await waitFor(async () => {
      const d = await env.chrome.storage.local.get('searchProgress');
      return d.searchProgress && d.searchProgress.nextEntryIndex === 1;
    }, 8000);
    const d = await env.chrome.storage.local.get('searchProgress');
    assert.strictEqual(d.searchProgress.planKey, '甲、乙|北京|');
  });
});

// ---------- content-search：cardId / 分页 ----------
function buildCard(dom, spec) {
  const li = dom.makeEl('li', 'job-card-box');
  const a = dom.makeEl('a', '', '', { href: 'https://www.zhipin.com/job_detail/' + spec.id + '.html?ka=search_list', ka: 'search_list_job' });
  a.offsetParent = {};
  a.appendChild(dom.makeEl('span', 'job-name', spec.name));
  a.appendChild(dom.makeEl('span', 'job-salary', spec.salary));
  li.appendChild(a);
  const footer = dom.makeEl('div', 'job-card-footer');
  const cinfo = dom.makeEl('div', 'company-info');
  cinfo.appendChild(dom.makeEl('a', 'company-name', spec.company));
  footer.appendChild(cinfo);
  li.appendChild(footer);
  li.offsetParent = {};
  return li;
}

function loadSearch(build) {
  const dom = makeDom();
  if (build) build(dom);
  const listeners = [];
  const chromeStub = { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } };
  const ctx = {
    console, chrome: chromeStub, document: dom.document, window: dom.window,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSrc('selectors.js'), ctx, { filename: 'selectors.js' });
  vm.runInContext(readSrc('content-search.js'), ctx, { filename: 'content-search.js' });
  return {
    dom,
    send(msg) {
      return new Promise(resolve => {
        let done = false;
        for (const fn of listeners) {
          const keep = fn(msg, {}, r => { if (!done) { done = true; resolve(r); } });
          if (keep !== true && !done) resolve(undefined);
        }
      });
    }
  };
}

define('merge-batch2 content-search cardId 与分页', t => {
  t('OPEN_JD 返回实际点开卡片的 cardId', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      list.appendChild(buildCard(dom, { id: 'J1', name: '数据分析师', salary: '10-15K', company: '阿里科技有限公司' }));
      const det = dom.makeEl('div', 'job-detail-box');
      det.appendChild(dom.makeEl('div', 'job-sec-text', '岗位职责：负责数据分析'));
      dom.body.appendChild(det);
    });
    const r = await env.send({ type: 'OPEN_JD', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success);
    assert.strictEqual(r.cardId, 'J1');
  });

  t('OPEN_JD 模糊定位到别的卡时 cardId 如实回传（供后台拦截）', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      list.appendChild(buildCard(dom, { id: 'J4', name: '算法工程师', salary: '25-40K', company: '正常科技' }));
      const det = dom.makeEl('div', 'job-detail-box');
      det.appendChild(dom.makeEl('div', 'job-sec-text', '岗位职责：算法'));
      dom.body.appendChild(det);
    });
    const r = await env.send({ type: 'OPEN_JD', job: { id: 'UNKNOWN-ID', name: '算法工程师', company: '正常科技' } });
    assert.ok(r && r.success, '定位层仍可找到卡片');
    assert.strictEqual(r.cardId, 'J4', 'cardId 必须是实际卡片 id，后台据此拦截');
  });

  t('GO_CHAT 返回 cardId', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      const card = buildCard(dom, { id: 'J1', name: '数据分析师', salary: '10-15K', company: '阿里科技有限公司' });
      list.appendChild(card);
      const btn = dom.makeEl('a', 'op-btn-chat', '立即沟通');
      btn.offsetParent = {};
      card.appendChild(btn);
      const go = dom.makeEl('span', 'dialog-btn', '继续沟通');
      go.offsetParent = {};
      dom.body.appendChild(go);
    });
    const r = await env.send({ type: 'GO_CHAT', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success && r.navigated === true);
    assert.strictEqual(r.cardId, 'J1');
  });

  t('SCRAPE 分页：滚动停滞后点下一页拿到新卡', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      list.appendChild(buildCard(dom, { id: 'PA', name: '岗位A', salary: '10-15K', company: '甲公司' }));
      const pager = dom.makeEl('div', 'options-pages');
      const next = dom.makeEl('a', 'next', '下一页');
      next.offsetParent = {};
      next.onclick = () => {
        list.children.length = 0;
        list.appendChild(buildCard(dom, { id: 'PB', name: '岗位B', salary: '12-18K', company: '乙公司' }));
      };
      pager.appendChild(next);
      dom.body.appendChild(pager);
    });
    const r = await env.send({ type: 'SCRAPE', count: 2 });
    assert.ok(r && r.success);
    assert.strictEqual(JSON.stringify(r.jobs.map(j => j.id)), JSON.stringify(['PA', 'PB']));
    assert.strictEqual(r.pages, 2, '应记录翻过 2 页');
  });
});

// ---------- content-chat：会话身份核验 ----------
function loadChat(buildDom, href) {
  const dom = makeDom();
  if (buildDom) buildDom(dom);
  const listeners = [];
  const chromeStub = { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } };
  let clock = 0;
  const FakeDate = { now: () => (clock += 250) };
  function FakeEvent(type, init) { this.type = type; Object.assign(this, init || {}); }
  const ctx = {
    console, chrome: chromeStub, document: dom.document, window: dom.window,
    Date: FakeDate, Event: FakeEvent, InputEvent: FakeEvent, KeyboardEvent: FakeEvent,
    URLSearchParams, location: { href: href || 'https://www.zhipin.com/web/geek/chat/1001' },
    setTimeout: (fn, ms) => setTimeout(fn, 1),
    clearTimeout, setInterval: (fn, ms) => setInterval(fn, 1), clearInterval
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSrc('selectors.js'), ctx, { filename: 'selectors.js' });
  vm.runInContext(readSrc('content-chat.js'), ctx, { filename: 'content-chat.js' });
  return {
    dom,
    send(msg) {
      return new Promise(resolve => {
        let done = false;
        for (const fn of listeners) {
          const keep = fn(msg, {}, r => { if (!done) { done = true; resolve(r); } });
          if (keep !== true && !done) resolve(undefined);
        }
      });
    }
  };
}

function buildChatInput(dom) {
  const input = dom.makeEl('div', 'chat-input', '', { id: 'chat-input' });
  input.isContentEditable = true;
  input.setAttribute('contenteditable', 'true');
  input.offsetParent = {};
  input.onEvent = ev => { if (ev.type === 'keydown') input.textContent = ''; };
  dom.body.appendChild(input);
  return input;
}

define('merge-batch2 content-chat 会话身份核验', t => {
  t('URL jobId 不一致：拦截不发送', async () => {
    const env = loadChat(dom => {
      buildChatInput(dom);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    }, 'https://www.zhipin.com/web/geek/chat/1001?jobId=OTHER');
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: '您好', jobId: 'J1', company: '阿里科技有限公司', position: '数据分析师' });
    assert.ok(r && r.success === false);
    assert.ok(r.error.indexOf('会话岗位不一致') >= 0, r.error);
  });

  t('URL jobId 一致：放行发送', async () => {
    const env = loadChat(dom => {
      buildChatInput(dom);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    }, 'https://www.zhipin.com/web/geek/chat/1001?jobId=J1');
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: '您好', jobId: 'J1', company: '阿里科技有限公司', position: '数据分析师' });
    assert.ok(r && r.success, '应发送成功：' + (r && r.error));
  });

  t('无任何身份线索：放行（不误杀）', async () => {
    const env = loadChat(dom => {
      buildChatInput(dom);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    }, 'https://www.zhipin.com/web/geek/chat/1001');
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: '您好', jobId: 'J1', company: '阿里科技有限公司', position: '数据分析师' });
    assert.ok(r && r.success, '读不到证据时应放行：' + (r && r.error));
  });

  t('会话标题公司与岗位都不符：拦截', async () => {
    const env = loadChat(dom => {
      buildChatInput(dom);
      const tb = dom.makeEl('div', 'title-box');
      tb.appendChild(dom.makeEl('div', 'name-box', '字节跳动网络科技'));
      dom.body.appendChild(tb);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    }, 'https://www.zhipin.com/web/geek/chat/1001');
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: '您好', jobId: '', company: '阿里科技有限公司', position: '数据分析师' });
    assert.ok(r && r.success === false);
    assert.ok(r.error.indexOf('会话岗位不一致') >= 0, r.error);
  });

  t('会话标题含岗位名：放行发送', async () => {
    const env = loadChat(dom => {
      buildChatInput(dom);
      const tb = dom.makeEl('div', 'title-box');
      tb.appendChild(dom.makeEl('div', 'name-box', '数据分析师'));
      dom.body.appendChild(tb);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    }, 'https://www.zhipin.com/web/geek/chat/1001');
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: '您好', jobId: '', company: '阿里科技有限公司', position: '数据分析师' });
    assert.ok(r && r.success, '标题含岗位名应放行：' + (r && r.error));
  });
});
