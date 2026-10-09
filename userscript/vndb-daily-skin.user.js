// ==UserScript==
// @name         VNDB Daily Skin
// @name:zh-CN   VNDB 每日皮肤
// @namespace    https://github.com/nikaidou-amane/vndb-skins
// @version      2.7.0
// @description  按本地日期在 vndb-skins/custom/ 的多套主题之间轮换；document-start 同步注入，不再先闪默认皮肤
// @author       nikaidou-amane
// @match        https://vndb.org/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      fastly.jsdelivr.net
// @connect      cdn.jsdelivr.net
// @updateURL    https://raw.githubusercontent.com/nikaidou-amane/vndb-skins/main/userscript/vndb-daily-skin.user.js
// @downloadURL  https://raw.githubusercontent.com/nikaidou-amane/vndb-skins/main/userscript/vndb-daily-skin.user.js
// ==/UserScript==

/* ==========================================================================
   用法
   --------------------------------------------------------------------------
   默认：按配置的「轮换间隔 + 时间点」换皮肤（见 ROTATION），同一时间段内所有页面/刷新都是同一套。
   选序规则（**不是**固定顺序）：每 N 次换肤算一个「块」（N = 主题数量，现为 20），
   块内是全部主题的随机排列 → 每 N 次里每套主题正好出现一次，但块与块之间的先后顺序都不一样；
   并且保证【相邻两次不会是同一套】。

   轮换间隔：按「间隔 + 时间点」换皮肤（改配置里的 ROTATION，用 vndbSkin.rotation() 核对）。
   当前设置：间隔 8h + 时间点 12:00 → 每天 04:00 / 12:00 / 20:00 各换一次
   （24 小时制，以系统本地时间为准）。想要"每天一套"就改成 intervalHours: 24, anchorHour: 0。

   手动指定（按优先级，URL 参数 > 控制台持久设置）：
     · URL 参数（只影响当次加载）
         https://vndb.org/?vskin=arise_kaguya     指定这一套
         https://vndb.org/?vskin=random           这次随机一套
         https://vndb.org/?vskin=off              本页不加载任何主题
     · 控制台（持久，存在 localStorage）
         vndbSkin.list()                列出可选主题
         vndbSkin.apply('arise_kaguya') 固定用这一套
         vndbSkin.auto()                回到自动轮换（按 ROTATION 的设置）
         vndbSkin.now()                 现在这套叫什么
         vndbSkin.rotation()            看轮换设置 + 当前/下一个时间点
         vndbSkin.off()                 停用（清掉注入的样式）

   ⚠️ 四条实测约束，改这个脚本前先看
     0. 【为什么会先闪一下、怎么消掉的】老版本 document-end + 等异步请求回来才注入：
        默认皮肤先画出来、主题后盖上去，必然闪。现在改成 document-start，靠两件事消掉：
        · **同步缓存**：主题文本存在本地（GM_getValue / localStorage），文档还没开始解析
          就能拿到，不用等网络。缓存键就是完整 URL（含 pinned SHA）→ 换 SHA 自动失效，
          不用手动清（vndbSkin.cache() 看状态、clearCache() 手动清）。
        · **document.adoptedStyleSheets**（constructable stylesheet）：实测在真站上它排在
          文档自带样式表【之后】，所以“最早注入”和“压过官方同特异性规则”可以兼得。
        ⚠️ 代价：没缓存时（刚装 / 换 SHA / 跨天第一页）要先下载，这期间会把页面
           visibility:hidden 藏起来（HIDE_TIMEOUT_MS 兜底显示），所以那一次是“空白一下”
           而不是“先默认后覆盖”。命中缓存后会预取【明天】那套，第二天首次打开也不闪。
           不想要这种“空白一下”就把 HIDE_WHILE_LOADING 改成 false。
     1. 【退化路径】不支持 adoptedStyleSheets 时只能回到老办法：把 <style> 挂在 VNDB
        自己那几份样式表【之后】—— 官方皮肤里有大量和主题同特异性（body{}、
        body>header h1{}…）的规则，同特异性只能靠“后出现”取胜。
        那时必须等 DOMContentLoaded 再往 head 末尾挂，否则会排在官方皮肤前面、打不过它。
        VNDB 的下发顺序是 head 里先 <link> 官方皮肤（t.vndb.org/<skin>.css），
        再 <link> 你的自定义 CSS（/u<uid>.css?<csum>）。
     2. 【不要】在页面上下文里 fetch()。VNDB 的 CSP 是
          style-src 'unsafe-inline' https://vndb.org https://*.vndb.org;
          connect-src 'self' https://api.vndb.org; img-src *
        即：外站样式表会被 CSP 直接拦（实测 jsDelivr → requestfailed "csp"），
        连 fetch 到 jsDelivr 也会被 connect-src 掐掉。
        所以这里用 GM_xmlhttpRequest（走扩展进程，不受页面 CSP / CORS 限制）。
        注入 <style> 本身没问题，因为 style-src 里有 'unsafe-inline'。
     3. 主题里的背景图是外链图片 → CSP 的 img-src * 放行，没问题。
     4. 【轮换间隔怎么算】以「固定日期 + 配置的时间点」为锚，每 intervalMs 一个“槽位”，
        当前槽位号决定用哪套。
        ⚠️ 间隔**建议取能整除 24 的值**（1/2/3/4/6/8/12/24），否则时间点会一天天在时钟上漂移。
        ⚠️ 改间隔/时间点会重排之后**所有**槽位的安排（槽位号变了 = 抽签序列变了），这是必然的，不是 bug。
        ⚠️ 页面一直开着时，到下一个时间点会自动换下一套（定时器最长排 24h）。

   ⚠️ 维护
     · 【加减主题】只改配置里的 THEMES 数组（name = custom/ 下的文件名去掉 .css），
       再把 CDN_BASES 的 SHA 换成包含新文件的 commit（文件已在当前 commit 里时不用换）。
       ⚠️ 新增/删除主题会让"什么时候用哪套"整体重排（块长 = 主题数量，会跟着变），这是必然的，不是 bug。
     · 【主题 CSS】CDN 里钉的是 commit SHA：jsDelivr 对 @<sha> 回 max-age=31536000 immutable
       （浏览器一年只下一次，性能最好），代价是改了主题样式要手动把下面的 SHA 换成新 commit。
       ⚠️ 别给主题改成 @main：分支引用是 7 天缓存，改了要等一周；本脚本又会把 CSS 缓存在
          本地，会把这个延迟再"锁"住一段时间。
     · 【改轮换频率】改配置里的 ROTATION（间隔小时数 + 时间点），然后用 vndbSkin.rotation() 核对。
       ⚠️ 改完会重排之后所有槽位的安排（槽位号变了 = 抽签序列变了），这是必然的，不是 bug。
     · 【本脚本自己怎么更新】@updateURL/@downloadURL 故意【不】走 jsDelivr：
       jsDelivr 的 @main 是 7 天缓存、@<sha> 是 1 年 immutable —— 改一次脚本要等一周以上才推得动，
       而“改主题 CSS 就得改脚本里的 SHA”会和它叠在一起，把整个迭代卡住。
       所以改用 raw.githubusercontent.com（Cache-Control: max-age=300，**5 分钟**）：
         https://raw.githubusercontent.com/nikaidou-amane/vndb-skins/main/userscript/vndb-daily-skin.user.js
       ⚠️ 只影响【脚本自身】的更新，与主题 CSS / 背景图无关（那些仍走 jsDelivr）。
       ⚠️ raw 的 content-type 是 text/plain：从链接点安装会被 Chrome 按 MIME 拦掉（更新检查不受
          影响，油猴是自己发请求）。要重装就从油猴面板「从 URL 安装」，或把本地文件拖进油猴。
       ⚠️ 每次改脚本记得升 @version（油猴只在远端版本号更高时才更新）。
       ⚠️ 万一 raw 又不通了：把这两行换回 jsDelivr @main，手动重装一次即可。
   ========================================================================== */

(() => {
  'use strict';

  /* ---------------------------------------------------------------------
     配置
     --------------------------------------------------------------------- */

  /** 主题仓库（只有这个仓库的 custom/ 会被加载）。SHA 要对上 commit，
      改动 custom/ 里的主题后要一起换（当前 = "fix: adjust img size logic"，
      已包含全部 20 套主题）。 */
  const CDN_BASES = [
    'https://fastly.jsdelivr.net/gh/nikaidou-amane/vndb-skins@4e6497e39e75aae3f2d9508fb9caa274913c1586/custom/',
    'https://cdn.jsdelivr.net/gh/nikaidou-amane/vndb-skins@4e6497e39e75aae3f2d9508fb9caa274913c1586/custom/',
  ];

  /** 主题清单：name 就是 custom/ 下的文件名去掉 .css，按目录名排序（现为 20 套）。
      加/删主题只改这个数组；⚠️ 主题数量 N 参与选序，增删会重排之后所有时段的安排
      （必然如此：要让"相邻两次不同"，选序就得知道 N）。 */
  const THEMES = [
    'araya_touka',
    'arise_kaguya',
    'ayase_aisa',
    'enamori_senri',
    'himeno_towa',
    'izumi_hiyori',
    'kazami_yui',
    'koizuka_mana',
    'misakura_rin',
    'miyaguni_akari',
    'mochizuki_amane',
    'nabari_anju',
    'naitou_maia',
    'niimi_sora',
    'nikaidou_shinku',
    'sorakado_ao',
    'tobisawa_misaki',
    'umino_miyako',
    'yonagi',
    'yugyouji_yoruko',
  ].map(name => ({ name, file: `${name}.css` }));

  /** 官方皮肤名。三套主题都是照着它（Angelic Serenade）的变量体系写的，
      换别的官方皮肤时变量名/结构对不上，脚本会提醒一句。 */
  const EXPECTED_SKIN = 'angel';

  const LS_KEY   = 'vndb-daily-skin:override';
  const STYLE_ID = 'vndb-daily-skin';
  const TAG      = '[vndb-daily-skin]';

  /* ---------------------------------------------------------------------
     轮换间隔：多久换一套皮肤
     · intervalHours：间隔小时数（24 = 每天一套，8 = 每天三套）。
                      写小数也可以（0.5 = 半小时，最小 1 分钟），方便测试。
                      **建议取能整除 24 的值**（1/2/3/4/6/8/12/24），否则时间点会漂移。
     · anchorHour   ：时间点，24 小时制、按【系统本地时间】。
                      例：intervalHours=8 + anchorHour=12 → 每天 04:00 / 12:00 / 20:00 各换一次
                      例：intervalHours=24 + anchorHour=0  → 每天 00:00 换
     · 判定基于“槽位号”：以固定时刻为锚、每 rotationMs 一个槽，槽位号单调递增；
       选序（分块置乱）作用在槽位号上，所以“每 N 次各出现一次 + 相邻两次不同”依然成立。
     --------------------------------------------------------------------- */
  const ROTATION = {
    intervalHours: 8,      // 每多少小时换一套（24 = 每天一套；0.5 = 半小时）
    anchorHour: 12,        // 间隔的起点（0-23，本地时间）→ 8h + 12:00 = 每天 04/12/20 点
  };

  /** 间隔毫秒数（最小 1 分钟，防止写成 0 之后疯狂轮换） */
  const rotationMs = Math.max(1 / 60, ROTATION.intervalHours) * 3600 * 1000;
  /** 槽位锚点：固定日期 + 配置的时间点（本地时间）。用固定时刻做锚，槽位号才单调 */
  const SLOT_ANCHOR = new Date(2015, 0, 1, ROTATION.anchorHour, 0, 0, 0).getTime();

  /** 当前槽位号（一个槽位 = 一次换肤时间点） */
  const slotIndex = () => Math.floor((Date.now() - SLOT_ANCHOR) / rotationMs);
  /** 某个槽位开始的时间戳（用来显示“这套从几点开始用”） */
  const slotStart = (s = slotIndex()) => SLOT_ANCHOR + s * rotationMs;
  /** 下一个换肤时间点的时间戳 */
  const nextSlotAt = () => slotStart(slotIndex() + 1);

  /* ---------------------------------------------------------------------
     选序：每个槽位用哪一套
     · 分块置乱：每 THEME_COUNT 个槽位算一个「块」，块内是全部主题的一个**随机排列**
       → 每 N 次里每套主题正好出现一次，但先后顺序每块都不一样（不是固定列表）。
     · 相邻两次必然不同：块内是排列，天然不重复；跨块边界时如果“下一块第一次”
       正好等于“上一块最后一次”，就把下一块的头两个换一下（交换后仍是合法排列）。
     · 代价：块边界要依赖上一块的结果，所以从锚点（第 0 块）推过来。
       块内用 mulberry32 + Fisher-Yates，N=10 时约 2000 块 × 10 次交换。
     · 同一个槽位永远是同一套（完全可复现，不用 Math.random）。
     --------------------------------------------------------------------- */

  /** 32 位整数 hash：给每块生成 PRNG 种子（纯整数运算、可复现） */
  const hash32 = n => {
    let x = n | 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return (x ^ (x >>> 16)) >>> 0;
  };

  const THEME_COUNT = THEMES.length;

  /** mulberry32：由种子决定一个可复现的 [0,1) 伪随机序列 */
  const rng = seed => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** 第 block 块的主题下标排列（Fisher-Yates，种子 = 块号） */
  const blockOrder = block => {
    const rand = rng(hash32(block));
    const a = Array.from({ length: THEME_COUNT }, (_, i) => i);
    for (let i = THEME_COUNT - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  /** 第 slot 个槽位用第几套（0-based） */
  const pickIndex = slot => {
    if (THEME_COUNT < 2 || slot < 0) return 0;
    const block = Math.floor(slot / THEME_COUNT);
    let prevLast = -1;
    for (let b = 0; b <= block; b++) {
      const order = blockOrder(b);
      if (order[0] === prevLast) {                  // 跨块撞了 → 换头两个，仍保证相邻两次不同
        [order[0], order[1]] = [order[1], order[0]];
      }
      prevLast = order[THEME_COUNT - 1];
      if (b === block) return order[slot % THEME_COUNT];
    }
    return 0;
  };

  /** 第 slot 个槽位该用哪一套主题 */
  const themeForSlot = slot => THEMES[pickIndex(slot)];
  /** 现在该用哪一套主题 */
  const themeNow = () => themeForSlot(slotIndex());

  /** 没缓存、需要下载时：先把页面藏起来（避免露默认皮肤）；false = 宁可闪一下也不要空白 */
  const HIDE_WHILE_LOADING = true;
  const HIDE_TIMEOUT_MS  = 2500;
  const CACHE_PREFIX     = 'vndb-daily-skin:css:';

  const ls = {
    get() { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } },
    set(v) {
      try { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    },
  };

  /** 同步键值存储：优先 GM（油猴自带存储），退化为 localStorage。
      必须是【同步】的 —— document-start 就要拿到文本，才能赶在首帧前注入。 */
  const store = {
    get(key) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(key, '') || ''; } catch { /* ignore */ }
      try { return localStorage.getItem(key) || ''; } catch { return ''; }
    },
    set(key, val) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; } } catch { /* ignore */ }
      try { localStorage.setItem(key, val); } catch { /* ignore */ }
    },
  };

  /* 缓存键 = 完整 URL（含 pinned SHA）→ 主题内容一改（换 SHA）自动失效，不用手动清 */
  const cacheGet = url => store.get(CACHE_PREFIX + url);
  const cacheSet = (url, css) => { if (css) store.set(CACHE_PREFIX + url, css); };

  /* 下载期间隐藏页面（并在 HIDE_TIMEOUT_MS 后无条件显示，避免网络卡死时一直白屏） */
  let revealTimer = 0;
  const reveal = () => {
    clearTimeout(revealTimer);
    const h = document.documentElement;
    if (h && h.style.visibility === 'hidden') h.style.visibility = '';
  };
  const hide = () => {
    if (!HIDE_WHILE_LOADING) return;
    const h = document.documentElement;
    if (!h) return;                      // 极早期拿不到 <html> 就只能不藏
    h.style.visibility = 'hidden';
    clearTimeout(revealTimer);
    revealTimer = setTimeout(reveal, HIDE_TIMEOUT_MS);
  };

  /** 跨域取文本：优先 GM_xmlhttpRequest（绕开页面 CSP/CORS），退化为 fetch */
  const fetchText = (urls, i = 0) => new Promise((resolve, reject) => {
    const url = urls[i];
    const fail = err => (i + 1 < urls.length ? fetchText(urls, i + 1).then(resolve, reject) : reject(err));

    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload: r => (r.status >= 200 && r.status < 300 && r.responseText)
          ? resolve({ url, text: r.responseText })
          : fail(new Error(`${url} → HTTP ${r.status}`)),
        onerror:   () => fail(new Error(`${url} → 网络错误`)),
        ontimeout: () => fail(new Error(`${url} → 超时`)),
      });
    } else {
      // 没有 GM_* 时会大概率被 CSP 拦掉（见文件头第 2 条），这里只是留个兜底
      fetch(url).then(r => r.ok ? r.text() : Promise.reject(new Error(`${url} → HTTP ${r.status}`)))
        .then(text => resolve({ url, text }), fail);
    }
  });

  /** 读出当前页用的官方皮肤名（用于和 EXPECTED_SKIN 对比） */
  const currentSkin = () => {
    for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const p = new URL(link.href, location.href).pathname;   // /angel.css 或 /u1234.css
      if (/^\/u\d+\.css$/.test(p)) continue;                  // 跳过自定义 CSS 本身
      const m = p.match(/^\/([A-Za-z0-9_-]+)\.css$/);
      if (m) return m[1];
    }
    return '';
  };

  /* ---------------------------------------------------------------------
     注入
     --------------------------------------------------------------------- */

  /* 首选 document.adoptedStyleSheets（constructable stylesheet）：实测在真站上它排在
     文档自带样式表【之后】，所以既能最早注入、又压得过官方皮肤。
     退化时回到「等 DOMContentLoaded 再把 <style> 挂到 head 末尾」。 */
  let sheet = null;          // 复用的 constructable stylesheet
  let sheetsBroken = false;  // adoptedStyleSheets 真出问题时置位，改走退化路径

  const canAdopt = () =>
    !sheetsBroken &&
    typeof CSSStyleSheet === 'function' &&
    typeof CSSStyleSheet.prototype.replaceSync === 'function' &&
    'adoptedStyleSheets' in document;

  /** true = 已同步生效；false = 需要退化路径接管（期间保持隐藏） */
  const adopt = css => {
    try {
      if (!sheet) sheet = new CSSStyleSheet();
      sheet.replaceSync(css);   // ⚠️ @import 会让这里抛错（主题里本来也不允许有）
      document.adoptedStyleSheets = [...document.adoptedStyleSheets].filter(s => s !== sheet).concat(sheet);
      return true;
    } catch (e) {
      sheetsBroken = true;
      console.warn(`${TAG} adoptedStyleSheets 不可用，退回 <style> 路径：`, e.message || e);
      return false;
    }
  };

  const dropAdopted = () => {
    try { document.adoptedStyleSheets = [...document.adoptedStyleSheets].filter(s => s !== sheet); } catch { /* ignore */ }
  };

  /** 退化路径：必须等样式表都解析完（DOMContentLoaded）再挂，否则排在官方皮肤前面会输 */
  const injectStyleTag = css => {
    const put = () => {
      let el = document.getElementById(STYLE_ID);
      if (!el) { el = document.createElement('style'); el.id = STYLE_ID; }
      el.textContent = css;
      (document.head || document.documentElement)?.append(el);   // append 已存在的 = 挪到末尾
      reveal();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put, { once: true });
    else put();
  };

  const removeStyle = () => {
    dropAdopted();
    document.getElementById(STYLE_ID)?.remove();
  };

  /** 统一入口：能同步就同步，否则交给退化路径（那期间保持隐藏，等下完再显示） */
  const applyCss = css => {
    if (canAdopt() && adopt(css)) { reveal(); return true; }
    injectStyleTag(css);
    return false;
  };

  /* ---------------------------------------------------------------------
     选一套 + 跑
     --------------------------------------------------------------------- */

  const resolve = () => {
    const fromUrl = (new URLSearchParams(location.search).get('vskin') || '').trim().toLowerCase();
    const stored  = ls.get().trim().toLowerCase();
    const choice  = fromUrl || stored;

    if (choice === 'off') return { action: 'off' };
    if (choice === 'random') {
      return { action: 'load', theme: THEMES[Math.floor(Math.random() * THEMES.length)], why: 'random（每次刷新变）' };
    }
    if (choice) {
      const theme = THEMES.find(t => t.name === choice);
      return theme
        ? { action: 'load', theme, why: fromUrl ? `URL 指定 (?vskin=${choice})` : `控制台指定 (${LS_KEY})` }
        : { action: 'unknown', choice };
    }
    const slot = slotIndex();
    return {
      action: 'load',
      theme: themeForSlot(slot),
      why: `按间隔轮换（槽位 ${slot}，本套自 ${new Date(slotStart(slot)).toLocaleString()} 起）`,
    };
  };

  /** 注入完之后：检查官方皮肤名（那时 <link> 才存在）+ 后台预取明天那套 */
  const afterApply = pick => {
    const checkSkin = () => {
      const skin = currentSkin();
      if (skin && skin !== EXPECTED_SKIN) {
        console.warn(`${TAG} 当前官方皮肤是 "${skin}"，主题是按 "${EXPECTED_SKIN}" 的变量体系写的，配色可能不对。`);
      }
    };
    // document-start 时 head 里还没有 <link>，所以这个检查必须等 DOM 解析出来
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkSkin, { once: true });
    else checkSkin();

    // 只在“按间隔轮换”时预取：手动固定了某一套就没必要（那套已经在缓存里了）
    if (!pick.why.startsWith('按间隔轮换')) return;
    const next = themeForSlot(slotIndex() + 1);
    const urls = CDN_BASES.map(base => base + next.file);
    if (urls.some(u => cacheGet(u))) return;
    const go = () => fetchText(urls).then(r => cacheSet(r.url, r.text)).catch(() => { /* ignore */ });
    (window.requestIdleCallback || (f => setTimeout(f, 1500)))(go);
  };

  /** 页面一直开着时：到下一个时间点自动换下一套（下次换肤在 24h 之外就不排了） */
  const scheduleNextRotation = () => {
    const ms = nextSlotAt() - Date.now();
    if (ms <= 0 || ms > 24 * 3600 * 1000) return;
    setTimeout(() => { start(); scheduleNextRotation(); }, ms + 1000);
  };

  const start = async () => {
    const pick = resolve();

    if (pick.action === 'unknown') {
      console.warn(`${TAG} 没有叫 "${pick.choice}" 的主题，可选：${THEMES.map(t => t.name).join(' / ')}`);
      return;
    }
    if (pick.action === 'off') {
      removeStyle();
      reveal();
      console.info(`${TAG} 已停用（${new URLSearchParams(location.search).get('vskin') ? '?vskin=off' : 'vndbSkin.off()'}）`);
      return;
    }

    const urls = CDN_BASES.map(base => base + pick.theme.file);

    // ① 同步缓存命中 → 首帧之前就注入完，零闪烁（装好之后的绝大多数情况）
    for (const url of urls) {
      const cached = cacheGet(url);
      if (cached) {
        applyCss(cached);
        console.info(`${TAG} ${pick.theme.name}（本地缓存）← ${pick.why}`);
        afterApply(pick);
        scheduleNextRotation();
        return;
      }
    }

    // ② 没缓存（刚装 / 换了 SHA / 某个时间点的第一页）：先藏起来再下载
    hide();
    try {
      const { url, text } = await fetchText(urls);
      cacheSet(url, text);
      applyCss(text);
      console.info(`${TAG} ${pick.theme.name}（下载）← ${pick.why}`);
      afterApply(pick);
      scheduleNextRotation();
    } catch (e) {
      // 加载失败就什么都不做：页面落回官方皮肤（+ 你在设置里留着的自定义 CSS，如果有的话）
      console.warn(`${TAG} 主题加载失败，已保持官方皮肤：`, e.message || e);
      reveal();
    }
  };

  /* ---------------------------------------------------------------------
     控制台 API（TM 沙箱里挂在 unsafeWindow 上，方便在 F12 Console 直接敲）
     --------------------------------------------------------------------- */

  const api = {
    list:  () => THEMES.map(t => t.name),
    now:  () => themeNow().name,
    today: () => themeNow().name,          // 老名字，保留兼容
    apply: async name => { ls.set(name); await start(); },
    auto:  async () => { ls.set(''); await start(); },
    off:   async () => { ls.set('off'); removeStyle(); reveal(); console.info(`${TAG} 已停用（vndbSkin.auto() 恢复）`); },
    reload: start,
    /** 每套主题的缓存状态 */
    cache: () => THEMES.map(t =>
      `${t.name}: ` + (CDN_BASES.some(b => cacheGet(b + t.file)) ? '已缓存' : '未缓存')).join('\n'),
    /** 当前轮换设置 + 当前/下一个时间点 */
    rotation: () => {
      const s = slotIndex();
      return `间隔 ${ROTATION.intervalHours}h，时间点 ${ROTATION.anchorHour}:00（本地）\n`
        + `当前：${themeNow().name}（槽位 ${s}，自 ${new Date(slotStart(s)).toLocaleString()} 起）\n`
        + `下一个：${themeForSlot(s + 1).name} @ ${new Date(nextSlotAt()).toLocaleString()}`;
    },
    /** 清掉所有缓存（换 SHA / 想强制重新下载时用），之后 vndbSkin.reload() 重新拉 */
    clearCache: () => {
      for (const t of THEMES) for (const b of CDN_BASES) store.set(CACHE_PREFIX + b + t.file, '');
      return '缓存已清，vndbSkin.reload() 重新下载';
    },
  };
  try { (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).vndbSkin = api; } catch { /* ignore */ }

  start();
})();
