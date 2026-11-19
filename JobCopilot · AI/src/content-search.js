// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── 文本清洗：BOSS 大量用图标字体，textContent 会夹带私用区(PUA)/零宽/控制字符，显示成乱码 ──
  // 统一剔除这些字符并规整空白，避免污染审核列表和 AI 提示词。
  const GARBAGE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/g;
  const ICON_GLYPHS = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
  function stripGarbage(s) {
    return String(s == null ? '' : s).replace(GARBAGE, '').replace(ICON_GLYPHS, '');
  }
  function cleanText(s) {
    return stripGarbage(s).replace(/[\u00A0\u3000]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function cleanMultiline(s) {
    return stripGarbage(s).replace(/[\u00A0\u3000]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  // 按选择器优先级取第一个非空文本（避免 querySelector 的树序把外层包裹元素选中）
  function firstText(root, sels) {
    for (const sel of sels) {
      const el = root.querySelector(sel);
      if (!el) continue;
      const t = cleanText(el.textContent);
      if (t) return t;
    }
    return '';
  }

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }

  function parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const linkEl = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const name = cleanText(nameEl && nameEl.textContent) || '未知岗位';
    // 薪资数字被 BOSS 私有字体编码在 U+E031-E03A，必须先解码再 cleanText，
    // 否则 cleanText 会把私用区字符当图标字体删掉、薪资数字直接丢失（顺序不能反）
    const salaryRaw = salEl ? salEl.textContent : '';
    const salaryDecoded = (typeof BOSS_SALARY !== 'undefined' && BOSS_SALARY && typeof BOSS_SALARY.decodeDigits === 'function')
      ? BOSS_SALARY.decodeDigits(salaryRaw || '') : (salaryRaw || '');
    const salary = cleanText(salaryDecoded);
    const id = (m && m[1]) || (name + '|' + salary);
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList))
      .map(t => cleanText(t.textContent)).filter(Boolean);
    const company = firstText(card, [
      '.company-name', '.company-info .company-name', '.company-info a',
      '.boss-info .company-name', '[class*="company-name"]', '[class*="company"] a'
    ]);
    const areaEl = card.querySelector('.job-area') || card.querySelector(SELECTORS.jobs.area);
    const area = cleanText(areaEl && areaEl.textContent);
    let activeState = 'unknown';
    const actEls = card.querySelectorAll(SELECTORS.jobs.activeTag);
    for (const el of actEls) {
      const t = cleanText(el.textContent);
      if (!t) continue;
      if (/本月|本月活跃/.test(t)) { activeState = 'month'; break; }
      if (/本周|周内/.test(t)) { activeState = 'week'; break; }
      if (/在线|刚刚活跃|今日活跃/.test(t)) { activeState = 'online'; break; }
    }
    let inviteCount = -1;
    const iv = cleanText(card.textContent).match(/(\d+)\s*人\s*(投递|沟通|邀请)/);
    if (iv) inviteCount = parseInt(iv[1], 10);
    return {
      id: id,
      name: name,
      salary: salary,
      tags: tags,
      company: company,
      link: link,
      area: area,
      activeState: activeState,
      inviteCount: inviteCount
    };
  }

  // batch2 pagination (selector set adapted from kunshan content-search pagination()/disabled())
  function findNextPageBtn() {
    const candidates = Array.from(document.querySelectorAll('.options-pages .next, .page-next, .pagination .next, .pagination-next, .ui-pagination-next, .el-pagination .btn-next, .ant-pagination-next, [title="下一页"], [aria-label="下一页"], a[rel="next"]'));
    const byText = Array.from(document.querySelectorAll('.options-pages a, .options-pages button, [class*="pagination"] a, [class*="pagination"] button'))
      .filter(el => /^(下一页|下页|Next)$/i.test((el.textContent || '').trim()));
    const next = candidates.concat(byText).find(el => isVisible(el));
    if (!next) return null;
    return (typeof next.matches === 'function' && next.matches('a, button')) ? next : (next.querySelector ? (next.querySelector('a, button') || next) : next);
  }
  function nextPageDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    if (/(^|\s)(disabled|is-disabled)(\s|$)/.test(String(el.className || ''))) return true;
    if (el.parent && /(^|\s)(disabled|is-disabled)(\s|$)/.test(String(el.parent.className || ''))) return true;
    return false;
  }

  async function scrape(count) {
    const seen = {};
    const jobs = [];
    let stall = 0;
    let pages = 1;
    // 慢网络/页面刚渲染完：先等首批卡片出现（最多 4 秒），避免"0 卡片"被误判成无岗
    await waitCardsGrow(0, 4000);
    for (let loop = 0; loop < 60 && jobs.length < count && stall < 4; loop++) {
      const cards = getCards();
      let added = 0;
      for (const c of cards) {
        const j = parseCard(c);
        if (j.id && !seen[j.id]) { seen[j.id] = 1; jobs.push(j); added++; if (jobs.length >= count) break; }
      }
      if (added === 0) stall++; else stall = 0;
      if (jobs.length >= count) break;
      // batch2: scrolling stalled - follow the pager before giving up (no pager -> unchanged behaviour)
      if (stall >= 2) {
        const nextBtn = findNextPageBtn();
        if (nextBtn && !nextPageDisabled(nextBtn)) {
          const beforeCards = getCards().length;
          nextBtn.click();
          pages++;
          stall = 0;
          await waitCardsGrow(beforeCards, 1500);
          continue;
        }
      }
      window.scrollTo(0, document.body.scrollHeight);
      const container = document.querySelector('.job-list-container, .job-list-box, [class*="job-list"]');
      if (container) container.scrollTop = container.scrollHeight;
      const before = jobs.length;
      await waitCardsGrow(before, 1500);
    }
    return { jobs: jobs.slice(0, count), pages: pages };
  }

  function findCardByJob(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    for (const c of cards) { const j = parseCard(c); if (j.name === job.name && (!job.company || j.company === job.company)) return c; }
    return null;
  }

  // 目标岗位可能排在列表后面还没被渲染：滚动列表直到找到卡片（带上限，避免死循环）
  async function findCardByJobScroll(job) {
    for (let i = 0; i < 15; i++) {
      const c = findCardByJob(job);
      if (c) return c;
      const before = getCards().length;
      window.scrollTo(0, document.body.scrollHeight);
      const container = document.querySelector('.job-list-container, .job-list-box, [class*="job-list"]');
      if (container) container.scrollTop = container.scrollHeight;
      await waitCardsGrow(before, 1100);
    }
    return null;
  }

  // batch2 (from kunshanyep exact-delivery fix): strict finders - id equality only, no fuzzy fallback.
  // parseCard id is deterministic (link id, or name|salary), so strict equality also holds without a link id.
  function findCardByJobStrict(job) {
    if (!job || !job.id) return null;
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (j.id === job.id) return c; }
    return null;
  }

  async function findCardByJobScrollStrict(job) {
    for (let i = 0; i < 15; i++) {
      const c = findCardByJobStrict(job);
      if (c) return c;
      const before = getCards().length;
      window.scrollTo(0, document.body.scrollHeight);
      const container = document.querySelector('.job-list-container, .job-list-box, [class*="job-list"]');
      if (container) container.scrollTop = container.scrollHeight;
      await waitCardsGrow(before, 1100);
    }
    return null;
  }

  // openJD locator: strict first; fuzzy name+company only to locate a card whose real id is
  // then reported back as cardId - the background hard-checks it before anything is sent.
  async function findCardForOpenJD(job) {
    let c = findCardByJobStrict(job);
    if (c) return c;
    c = findCardByJob(job);
    if (c) return c;
    for (let i = 0; i < 15; i++) {
      const before = getCards().length;
      window.scrollTo(0, document.body.scrollHeight);
      const container = document.querySelector('.job-list-container, .job-list-box, [class*="job-list"]');
      if (container) container.scrollTop = container.scrollHeight;
      await waitCardsGrow(before, 1100);
      c = findCardByJobStrict(job);
      if (c) return c;
      c = findCardByJob(job);
      if (c) return c;
    }
    return null;
  }

  // 等待岗位卡片数量超过 prev（滚动后等新卡片渲染），超时返回当前数量
  function waitCardsGrow(prevCount, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const n = getCards().length;
        if (n > prevCount || Date.now() - t0 > timeout) { clearInterval(iv); resolve(n); }
      }, 250);
    });
  }

  // 可见性判断：Chrome 下 position:fixed 元素 offsetParent 恒为 null（弹窗/详情面板常是 fixed），
  // 只看 offsetParent 会把可见弹窗误判成隐藏 → 配额永远识别不到。补 computed style 分支。
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    try {
      const gcs = (typeof getComputedStyle === 'function') ? getComputedStyle
        : (typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle : null);
      if (!gcs) return false;
      const st = gcs(el) || {};
      if (st.position !== 'fixed' || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return !r || r.width > 0 || r.height > 0;
    } catch (e) { return false; }
  }

  // 安全验证组件检测：URL 不一定变，页面内弹滑块/验证码时靠它兜底
  function detectVerifyDom() {
    const sels = ['[class*="captcha"]', '#captcha', '.geetest_panel', '.geetest_holder', '.yidun_panel', '.yidun_intellisense', '[class*="security-check"]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && isVisible(el)) return true;
    }
    return false;
  }

  // 等待详情面板出现（点开卡片后 JD 面板渲染，替代固定 sleep）
  function waitDetailPanel(timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
        if (det && isVisible(det)) { clearInterval(iv); resolve(det); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // ── BOSS 平台配额弹窗识别：当日 100/120/150 沟通名额用完时，弹的是"开通服务"框而非"继续沟通" ──
  const QUOTA_RE = /今日[^。]{0,10}(沟通|聊天)[^。]{0,10}(上限|名额|次数)|名额已用完|今日额度|沟通次数(已)?达|明日再(来|试)/;
  const QUOTA_CONTEXT_RE = /沟通|名额|次数/; // 双重条件：防"开通会员"类促销弹窗误伤
  function findQuotaDialog() {
    const boxes = document.querySelectorAll('[class*="dialog"], [class*="modal"], [class*="dialog-wrap"]');
    for (const b of boxes) {
      const t = (b.textContent || '');
      if (t && QUOTA_RE.test(t) && QUOTA_CONTEXT_RE.test(t) && isVisible(b)) return t.slice(0, 120);
    }
    return '';
  }

  // 点了立即沟通后：轮询等待"继续沟通"按钮或配额弹窗（任一先到为准），替代固定 sleep
  function waitContinueOrQuota(timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        // 先看配额弹窗（名额用完时永远不会有"继续沟通"）
        const qt = findQuotaDialog();
        if (qt) { clearInterval(iv); resolve({ quota: true, text: qt }); return; }
        const els = document.querySelectorAll('a, button, span, div');
        for (const el of els) {
          const tx = (el.textContent || '').trim();
          if (tx === '继续沟通' && isVisible(el)) {
            clearInterval(iv); resolve({ go: el }); return;
          }
        }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 250);
    });
  }

  function waitFor(sel, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) { clearInterval(iv); resolve(el); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // 点开卡片 → 抓取右侧详情面板的完整JD + HR名
  async function openJD(job) {
    const card = await findCardForOpenJD(job);
    if (!card) return { success: false, error: '未找到岗位卡片' };
    const cardId = parseCard(card).id;
    card.scrollIntoView({ block: 'center' });
    await sleep(200);
    card.click();
    // 条件等待详情面板渲染完成（替代固定 sleep；面板已在也确认一次内容非空）
    const detEl = await waitDetailPanel(4000);
    await sleep(300);
    let jd = '';
    const det = detEl || document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    if (det) jd = cleanMultiline(det.innerText);
    if (!jd) {
      const secs = document.querySelectorAll('.job-sec-text, [class*="job-sec"], [class*="job-desc"]');
      jd = Array.from(secs).map(s => cleanMultiline(s.innerText)).filter(Boolean).join('\n');
    }
    // 抓取 HR 名（精确去重需要）
    let hrName = '';
    const hrCandidates = document.querySelectorAll(
      '.job-detail-box [class*="hr-name"], .job-detail-box [class*="boss-name"], ' +
      '.job-detail [class*="hr-name"], [class*="job-banner"] [class*="name"], ' +
      '.boss-info .name, [class*="hr-info"] [class*="name"], ' +
      '.job-detail-box .name, .job-detail .name'
    );
    for (const el of hrCandidates) {
      const t = cleanText(el.textContent);
      if (t && t.length <= 20) { hrName = t; break; }
    }
    // 兜底：详情面板前 3 行文本里挑短的那行作为 HR
    if (!hrName && det) {
      const lines = cleanMultiline(det.innerText).split('\n').map(s => s.trim()).filter(Boolean);
      for (const ln of lines) {
        if (ln.length >= 2 && ln.length <= 8 && !/公司|有限|股份|集团|科技|网络|经验|学历|薪资|岗位/.test(ln)) { hrName = ln; break; }
      }
    }
    // 去掉"先生/女士"等称谓，保证匹配键一致
    hrName = cleanText(hrName).replace(/\s*(先生|女士|老师|sir|mr|ms)\s*$/i, '').trim();
    let addr = '';
    let fundText = '';
    const infoText = det ? cleanMultiline(det.innerText) : '';
    if (infoText) {
      const lines = infoText.split('\n').map(s => s.trim()).filter(Boolean);
      for (const ln of lines) {
        if (!addr && /工作(地址|地点)|附近/.test(ln) && ln.length <= 40) addr = ln;
        if (!fundText && /注册资本/.test(ln)) fundText = ln;
      }
    }
    return { success: true, jd: jd.slice(0, 1800), hrName: hrName, addr: addr, fundText: fundText, cardId: cardId };
  }

  // batch2: the chat button is only ever searched inside the detail panel or the exact
  // reviewed card - never by scanning the whole page (that could hit another job's button).
  function findDetailPanel() {
    return document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content');
  }
  function findChatBtnIn(root) {
    if (!root) return null;
    const direct = root.querySelector(SELECTORS.jobs.immediateChatBtn);
    if (direct && isVisible(direct)) return direct;
    const els = root.querySelectorAll('a, button, span');
    for (const el of els) {
      const tx = (el.textContent || '').trim();
      if ((tx === '立即沟通' || tx === '继续沟通') && isVisible(el)) return el;
    }
    return null;
  }
  async function waitChatBtn(card, timeout) {
    const t0 = Date.now();
    for (;;) {
      const btn = findChatBtnIn(findDetailPanel()) || findChatBtnIn(card);
      if (btn) return btn;
      if (Date.now() - t0 > timeout) return null;
      await sleep(200);
    }
  }

  // 卡片已打开 → 点立即沟通 → 弹窗点"继续沟通"（跳转聊天页）；识别平台配额弹窗
  async function goChat(job) {
    const card = await findCardByJobScrollStrict(job);
    const cardId = card ? parseCard(card).id : '';
    let btn = await waitChatBtn(card, 5000);
    if (!btn && card) { // 面板可能关了，严格重开同一张卡再试一次
      card.scrollIntoView({ block: 'center' });
      card.click();
      await sleep(800);
      btn = await waitChatBtn(card, 4000);
    }
    if (!btn) return { success: false, error: '未找到立即沟通按钮' };
    btn.click();
    // 条件等待：先到先得——"继续沟通"按钮 / 平台配额弹窗 / 超时
    const r = await waitContinueOrQuota(6000);
    if (r && r.quota) {
      const outQ = { success: false, quota: true, error: '平台提示：' + (r.text || '今日沟通名额已用完') };
      if (cardId) outQ.cardId = cardId;
      return outQ;
    }
    const out = { success: true, navigated: !!(r && r.go) };
    if (r && r.go) r.go.click();
    if (cardId) out.cardId = cardId;
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ success: true, alive: true, verify: detectVerifyDom() }); return; }
    if (msg.type === 'SCRAPE') {
      scrape(msg.count || 20).then(res => sendResponse({ success: true, jobs: res.jobs, pages: res.pages })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD') {
      openJD(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT' || msg.type === 'INITIATE' || msg.type === 'CREATE_CONV') {
      goChat(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
