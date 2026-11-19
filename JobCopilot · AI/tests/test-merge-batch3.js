// ===== 第三批修正测试：历史三档口径（硬历史/软历史指纹绑定/异常不记） =====
'use strict';
const assert = require('assert');
const { define, makeChrome, loadSW, waitFor, makeFetchQueue } = require('./helpers');

const MATCH_JSON = '{"match":true,"reason":"方向匹配"}';
const NO_MATCH_JSON = '{"match":false,"reason":"方向不符"}';
const GARBAGE = '这不是JSON，模型抽风了';

const J1 = { id: 'J1', name: '数据分析师', salary: '10-15K', company: '阿里科技有限公司', tags: ['SQL'], area: '北京·朝阳区', activeState: 'online', inviteCount: 10, link: 'https://www.zhipin.com/job_detail/J1.html?ka=1' };
const J2 = { id: 'J2', name: '前端工程师', salary: '15-25K', company: '字节跳动网络科技', tags: ['JS'], area: '北京', activeState: 'online', inviteCount: 5, link: 'https://www.zhipin.com/job_detail/J2.html?ka=2' };
const J3 = { id: 'J3', name: '测试工程师', salary: '12-20K', company: '正常科技', tags: [], area: '北京', activeState: 'online', inviteCount: 1, link: 'https://www.zhipin.com/job_detail/J3.html?ka=3' };
const J4 = { id: 'J4', name: '算法工程师', salary: '25-40K', company: '正常科技', tags: [], area: '北京', activeState: 'online', inviteCount: 1, link: 'https://www.zhipin.com/job_detail/J4.html?ka=4' };
const J5 = { id: 'J5', name: '产品经理', salary: '20-35K', company: '正常科技', tags: [], area: '北京', activeState: 'online', inviteCount: 1, link: 'https://www.zhipin.com/job_detail/J5.html?ka=5' };
const J6 = { id: 'J6', name: '运营专员', salary: '8-12K', company: '正常科技', tags: [], area: '北京', activeState: 'online', inviteCount: 1, link: 'https://www.zhipin.com/job_detail/J6.html?ka=6' };
const J7 = { id: 'J7', name: '设计师', salary: '15-22K', company: '正常科技', tags: [], area: '北京', activeState: 'online', inviteCount: 1, link: 'https://www.zhipin.com/job_detail/J7.html?ka=7' };

function baseCfg(extra) {
  return Object.assign({
    apiBaseUrl: 'https://api.test/v1/chat/completions', apiKey: 'sk-test', apiModel: 'test-model',
    resumeText: '熟练 SQL、Python，3 年数据分析经验', keyword: '数据分析', city: '北京', count: '20',
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
  const fetch_ = opts.fetch || makeFetchQueue(opts.responses || []);
  const ctx = loadSW(chrome, fetch_);
  return { chrome, fetch: fetch_, sent, ctx };
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
async function getSoft(chrome) {
  const d = await chrome.storage.local.get('collectedSoft');
  return d.collectedSoft || {};
}
async function getHard(chrome) {
  const d = await chrome.storage.local.get('collectedIds');
  return d.collectedIds || [];
}

// ---------- 指纹纯函数 ----------
define('merge-batch3 筛选条件指纹', t => {
  t('screenFingerprint 同条件稳定、任一条件变化即不同', () => {
    const { ctx } = setupBg({ cfg: baseCfg({}) });
    const fp = ctx.screenFingerprint;
    const a = fp(baseCfg({}));
    assert.ok(/^fp[0-9a-z]+$/.test(a), '指纹格式应为 fp+36进制哈希：' + a);
    assert.strictEqual(fp(baseCfg({})), a, '同条件指纹必须一致');
    assert.notStrictEqual(fp(baseCfg({ resumeText: '另一份简历' })), a, '换简历应变指纹');
    assert.notStrictEqual(fp(baseCfg({ keyword: '前端' })), a, '换关键词应变指纹');
    assert.notStrictEqual(fp(baseCfg({ city: '上海' })), a, '换城市应变指纹');
    assert.notStrictEqual(fp(baseCfg({ jobType: '1902' })), a, '换求职类型应变指纹');
    assert.notStrictEqual(
      fp(baseCfg({ filterConfig: { listMode: 'off', blacklist: [], whitelist: [], screenLevel: 'strict' } })),
      a, '换 AI 严格度应变指纹');
    assert.notStrictEqual(
      fp(baseCfg({ filterConfig: { listMode: 'black', blacklist: ['某公司'], whitelist: [] } })),
      a, '改过滤规则应变指纹');
  });
});

// ---------- 三档口径集成 ----------
define('merge-batch3 历史三档口径', t => {
  t('① 解析失败/筛选异常不记任何历史，正常剔除才记软历史', async () => {
    const { chrome } = setupBg({
      cfg: baseCfg({}),
      jobs: [J1, J2, J3],
      // 队列依次对应三岗的筛选调用：乱码（解析失败）/ HTTP 500（筛选异常）/ 正常不匹配
      responses: [GARBAGE, 500, NO_MATCH_JSON]
    });
    await collectToReview(chrome);
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    const byReason = {};
    s.screened.forEach(j => { byReason[j.id] = j; });
    const errJobs = s.screened.filter(j => j.screenError === true);
    const okJobs = s.screened.filter(j => !j.screenError);
    assert.strictEqual(errJobs.length, 2, '两个异常岗位应被打上 screenError 标记');
    assert.ok(errJobs.some(j => j.reason === 'AI解析失败'), '应含解析失败');
    assert.ok(errJobs.some(j => String(j.reason).indexOf('筛选异常') === 0), '应含筛选异常');
    assert.strictEqual(okJobs.length, 1, '只有一个正常剔除');
    assert.strictEqual(okJobs[0].match, false);
    const soft = await getSoft(chrome);
    assert.deepStrictEqual(Object.keys(soft), [okJobs[0].id], '软历史只应含正常剔除的那个岗位');
    assert.deepStrictEqual(await getHard(chrome), [], '硬历史应为空');
    void byReason;
  });

  t('② 规则剔除进软历史，同指纹下轮被排除', async () => {
    const { chrome, fetch } = setupBg({
      cfg: baseCfg({ filterConfig: { listMode: 'black', blacklist: [{ name: '阿里', mode: 'keyword' }], whitelist: [], jobHandle: 'collect' } }),
      jobs: [J1, J2],
      responses: [MATCH_JSON, MATCH_JSON] // 两轮各筛一次 J2
    });
    await collectToReview(chrome);
    const soft = await getSoft(chrome);
    assert.deepStrictEqual(Object.keys(soft), ['J1'], '规则剔除的 J1 应进软历史，匹配的 J2 不应进');
    assert.deepStrictEqual(await getHard(chrome), [], '硬历史应为空');
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    await waitFor(() => logTexts(chrome).some(x => x.indexOf('已跳过同条件已筛岗位 1 个') >= 0), 8000);
    // 不用 GET_STATE 轮询判完成（其存盘回填会干扰轮次中状态），改看存盘的 sw_screened 落定
    await waitFor(async () => {
      const d = await chrome.storage.local.get('sw_screened');
      return Array.isArray(d.sw_screened) && d.sw_screened.length === 1 && d.sw_screened[0].id === 'J2';
    }, 8000);
    assert.strictEqual(fetch._calls.length, 2, '两轮各只有 J2 的一次 AI 调用');
  });

  t('③ 改简历（指纹变）后软历史失效，岗位重新被筛', async () => {
    const { chrome, fetch } = setupBg({
      cfg: baseCfg({}),
      jobs: [J1],
      responses: [NO_MATCH_JSON, NO_MATCH_JSON]
    });
    await collectToReview(chrome);
    const soft1 = await getSoft(chrome);
    assert.ok(soft1.J1, '第一轮 J1 应进软历史');
    chrome._storageData.set('resumeText', '全新简历：5 年前端开发经验，熟悉 React');
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    // 等第二轮筛选完成（两轮各一条「筛选完成」日志）且存盘名单落定
    await waitFor(() => logTexts(chrome).filter(x => x.indexOf('筛选完成') >= 0).length >= 2 && fetch._calls.length === 2, 8000);
    const d = await chrome.storage.local.get('sw_screened');
    assert.deepStrictEqual((d.sw_screened || []).map(j => j.id), ['J1'], '换简历后 J1 应重新参与筛选');
    const soft2 = await getSoft(chrome);
    assert.ok(soft2.J1 && soft2.J1 !== soft1.J1, '软历史指纹应更新为新条件指纹');
  });

  t('④ 投递成功进硬历史，换条件仍永久排除', async () => {
    const { chrome, fetch } = setupBg({
      cfg: baseCfg({}),
      jobs: [J1],
      responses: [MATCH_JSON, '您好，熟悉SQL，做过数据分析。']
    });
    await collectToReview(chrome);
    assert.deepStrictEqual(await getHard(chrome), [], '未投递前硬历史应为空');
    await deliverAndWait(chrome, ['J1']);
    assert.deepStrictEqual(await getHard(chrome), ['J1'], '投递成功应记入硬历史');
    chrome._storageData.set('resumeText', '另一份完全不同的简历');
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    await waitFor(() => logTexts(chrome).some(x => x.indexOf('已排除已投岗位 1 个') >= 0), 8000);
    assert.strictEqual(fetch._calls.length, 2, '硬历史排除不应产生新的 AI 调用（无新筛选即岗位未进筛选）');
    assert.deepStrictEqual(await getHard(chrome), ['J1'], '硬历史应保持不变');
  });

  t('⑤ 中途停止：未筛到的岗位不进软历史', async () => {
    let releaseGate;
    const gate = new Promise(r => { releaseGate = r; });
    const calls = [];
    const gatedFetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      await gate;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: NO_MATCH_JSON } }] }) };
    };
    gatedFetch._calls = calls;
    const { chrome } = setupBg({
      cfg: baseCfg({}),
      jobs: [J1, J2, J3, J4, J5, J6, J7],
      fetch: gatedFetch
    });
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    // 第一批（并发 3）在途时发停止
    await waitFor(() => calls.length >= 3, 8000);
    await chrome.panelSend({ type: 'STOP' });
    releaseGate();
    await waitFor(async () => {
      const s = await chrome.panelSend({ type: 'GET_STATE' });
      return s && s.phase === 'review';
    }, 8000);
    const soft = await getSoft(chrome);
    assert.deepStrictEqual(Object.keys(soft).sort(), ['J1', 'J2', 'J3'], '只有已筛完的第一批应进软历史');
    assert.deepStrictEqual(await getHard(chrome), [], '硬历史应为空');
  });

  t('⑥ RESET 同时清硬历史、软历史与进度', async () => {
    const { chrome } = setupBg({
      cfg: baseCfg({}),
      seed: {
        collectedIds: ['HX1'],
        collectedSoft: { SX1: 'fpzzz' },
        searchProgress: { planKey: '数据分析|北京|', nextEntryIndex: 1 }
      }
    });
    await chrome.panelSend({ type: 'RESET' });
    const d = await chrome.storage.local.get(['collectedIds', 'collectedSoft', 'searchProgress']);
    assert.ok(!d.collectedIds, 'RESET 应清硬历史');
    assert.ok(!d.collectedSoft, 'RESET 应清软历史');
    assert.ok(!d.searchProgress, 'RESET 应清搜索进度');
  });
});
