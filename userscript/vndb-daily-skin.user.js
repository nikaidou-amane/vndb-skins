// ==UserScript==
// @name         VNDB Daily Skin
// @name:zh-CN   VNDB 每日皮肤
// @namespace    https://github.com/nikaidou-amane/vndb-skins
// @version      2.0.1
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
   默认：按「本地日期」轮换。同一天内所有页面/刷新都是同一套，跨过本地 0 点换下一套。

   手动指定（按优先级，URL 参数 > 控制台持久设置）：
     · URL 参数（只影响当次加载）
         https://vndb.org/?vskin=arise_kaguya     指定这一套
         https://vndb.org/?vskin=random           这次随机一套
         https://vndb.org/?vskin=off              本页不加载任何主题
     · 控制台（持久，存在 localStorage）
         vndbSkin.list()                列出可选主题
         vndbSkin.apply('arise_kaguya') 固定用这一套
         vndbSkin.auto()                回到按天轮换
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

   ⚠️ 维护
     · 【主题 CSS】CDN 里钉的是 commit SHA：jsDelivr 对 @<sha> 回 max-age=31536000 immutable
       （浏览器一年只下一次，性能最好），代价是改了主题样式要手动把下面的 SHA 换成新 commit。
       ⚠️ 别给主题改成 @main：分支引用是 7 天缓存，改了要等一周；本脚本 v2 又会把 CSS 缓存在
          本地，会把这个延迟再“锁”住一天。
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
      改动 custom/ 里的主题后要一起换（当前 = "feat: add css"）。 */
  const CDN_BASES = [
    'https://fastly.jsdelivr.net/gh/nikaidou-amane/vndb-skins@83ce9f53d649e1c9f15a4469e8e01a5ab422183b/custom/',
    'https://cdn.jsdelivr.net/gh/nikaidou-amane/vndb-skins@83ce9f53d649e1c9f15a4469e8e01a5ab422183b/custom/',
  ];

  /** 轮换顺序：THEMES[天数 % THEMES.length]，改顺序 = 改哪天用哪套。
      注意加主题会重排整个周期（因为是 day % N），不是只在末尾多一天。
      按目录名排序，和 custom/ 下的文件名一致。 */
  const THEMES = [
    { name: 'arise_kaguya',   file: 'arise_kaguya.css'   },
    { name: 'himeno_towa',    file: 'himeno_towa.css'    },
    { name: 'izumi_hiyori',   file: 'izumi_hiyori.css'   },
    { name: 'miyaguni_akari', file: 'miyaguni_akari.css' },
    { name: 'nabari_anju',    file: 'nabari_anju.css'    },
  ];

  /** 官方皮肤名。三套主题都是照着它（Angelic Serenade）的变量体系写的，
      换别的官方皮肤时变量名/结构对不上，脚本会提醒一句。 */
  const EXPECTED_SKIN = 'angel';

  const LS_KEY   = 'vndb-daily-skin:override';
  const STYLE_ID = 'vndb-daily-skin';
  const TAG      = '[vndb-daily-skin]';

  /* ---------------------------------------------------------------------
     工具
     --------------------------------------------------------------------- */

  /** 本地日期 → 天数序号。用本地 0 点切日，不用 UTC（UTC 会让北京时间早上 8 点换主题） */
  const localDayIndex = () => {
    const tzOffsetMs = new Date().getTimezoneOffset() * 60 * 1000;
    return Math.floor((Date.now() - tzOffsetMs) / 86400000);
  };

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

  /* 缓存键 = 完整 URL（含 pinned SHA）→ 主题一改（换 SHA）自动失效 */
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
    const day = localDayIndex();
    return { action: 'load', theme: THEMES[day % THEMES.length], why: `按天轮换（第 ${day} 天 % ${THEMES.length}）` };
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

    // 只在“按天轮换”时预取：手动固定了某一套就没必要（那套已经在缓存里了）
    if (!pick.why.startsWith('按天轮换')) return;
    const next = THEMES[(localDayIndex() + 1) % THEMES.length];
    const urls = CDN_BASES.map(base => base + next.file);
    if (urls.some(u => cacheGet(u))) return;
    const go = () => fetchText(urls).then(r => cacheSet(r.url, r.text)).catch(() => { /* ignore */ });
    (window.requestIdleCallback || (f => setTimeout(f, 1500)))(go);
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
        return;
      }
    }

    // ② 没缓存（刚装 / 换 SHA / 跨天第一页）：先藏起来再下载
    hide();
    try {
      const { url, text } = await fetchText(urls);
      cacheSet(url, text);
      applyCss(text);
      console.info(`${TAG} ${pick.theme.name}（下载）← ${pick.why}`);
      afterApply(pick);
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
    today: () => THEMES[localDayIndex() % THEMES.length].name,
    apply: async name => { ls.set(name); await start(); },
    auto:  async () => { ls.set(''); await start(); },
    off:   async () => { ls.set('off'); removeStyle(); reveal(); console.info(`${TAG} 已停用（vndbSkin.auto() 恢复）`); },
    reload: start,
    /** 看每套主题有没有本地缓存 */
    cache: () => THEMES.map(t =>
      `${t.name}: ` + (CDN_BASES.map(b => b + t.file).some(u => cacheGet(u)) ? '已缓存' : '未缓存')).join('\n'),
    /** 清掉所有缓存（换 SHA / 想强制重新下载时用），之后 vndbSkin.reload() 重新拉 */
    clearCache: () => {
      for (const t of THEMES) for (const b of CDN_BASES) store.set(CACHE_PREFIX + b + t.file, '');
      return '缓存已清，vndbSkin.reload() 重新下载';
    },
  };
  try { (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).vndbSkin = api; } catch { /* ignore */ }

  start();
})();
