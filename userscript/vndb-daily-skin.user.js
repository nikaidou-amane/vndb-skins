// ==UserScript==
// @name         VNDB Daily Skin
// @name:zh-CN   VNDB 每日皮肤
// @namespace    https://github.com/nikaidou-amane/vndb-skins
// @version      1.0.0
// @description  按本地日期在 vndb-skins/custom/ 的多套主题之间轮换，每天 0 点自动换一套
// @author       nikaidou-amane
// @match        https://vndb.org/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      fastly.jsdelivr.net
// @connect      cdn.jsdelivr.net
// @updateURL    https://fastly.jsdelivr.net/gh/nikaidou-amane/vndb-skins@main/userscript/vndb-daily-skin.user.js
// @downloadURL  https://fastly.jsdelivr.net/gh/nikaidou-amane/vndb-skins@main/userscript/vndb-daily-skin.user.js
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

   ⚠️ 三条实测约束，改这个脚本前先看
     1. 必须注入在 VNDB 自己那几份样式表【之后】。官方皮肤里有大量和主题同特异性
        的选择器（body{}、body>header h1{}…），同特异性只能靠"后出现"取胜。
        所以：@run-at document-end + <style> append 到 head 末尾。
        VNDB 的下发顺序是 head 里先 <link> 官方皮肤（t.vndb.org/<skin>.css），
        再 <link> 你的自定义 CSS（/u<uid>.css?<csum>），我们的 <style> 排在最后。
     2. 【不要】在页面上下文里 fetch()。VNDB 的 CSP 是
          style-src 'unsafe-inline' https://vndb.org https://*.vndb.org;
          connect-src 'self' https://api.vndb.org; img-src *
        即：外站样式表会被 CSP 直接拦（实测 jsDelivr → requestfailed "csp"），
        连 fetch 到 jsDelivr 也会被 connect-src 掐掉。
        所以这里用 GM_xmlhttpRequest（走扩展进程，不受页面 CSP / CORS 限制）。
        注入 <style> 本身没问题，因为 style-src 里有 'unsafe-inline'。
     3. 主题里的背景图是外链图片 → CSP 的 img-src * 放行，没问题。

   ⚠️ 维护
     · CDN 里钉的是 commit SHA（immutable，浏览器一年只下一次）。改了 custom/ 里的主题
       样式，记得把下面的 SHA 换成新 commit，再让油猴更新脚本；图片 URL 里也各自钉了 SHA。
     · 不要改成 @main：jsDelivr 对分支引用回 max-age=604800（7 天），更新会延迟一周。
     · raw.githubusercontent.com 在部分网络下直连不通（实测 curl 返回 000），别用。
   ========================================================================== */

(() => {
  'use strict';

  /* ---------------------------------------------------------------------
     配置
     --------------------------------------------------------------------- */

  /** 主题仓库（只有这个仓库的 custom/ 会被加载） */
  const CDN_BASES = [
    'https://fastly.jsdelivr.net/gh/nikaidou-amane/vndb-skins@6f8c30b65897b61947636ad78faa16243361eef9/custom/',
    'https://cdn.jsdelivr.net/gh/nikaidou-amane/vndb-skins@6f8c30b65897b61947636ad78faa16243361eef9/custom/',
  ];

  /** 轮换顺序：THEMES[天数 % THEMES.length]，改顺序 = 改哪天用哪套 */
  const THEMES = [
    { name: 'miyaguni_akari', file: 'miyaguni_akari.css' },
    { name: 'arise_kaguya',   file: 'arise_kaguya.css'   },
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

  const ls = {
    get() { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } },
    set(v) {
      try { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    },
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
          ? resolve(r.responseText)
          : fail(new Error(`${url} → HTTP ${r.status}`)),
        onerror:   () => fail(new Error(`${url} → 网络错误`)),
        ontimeout: () => fail(new Error(`${url} → 超时`)),
      });
    } else {
      // 没有 GM_* 时会大概率被 CSP 拦掉（见文件头第 2 条），这里只是留个兜底
      fetch(url).then(r => r.ok ? r.text() : Promise.reject(new Error(`${url} → HTTP ${r.status}`)))
        .then(resolve, fail);
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

  const removeStyle = () => document.getElementById(STYLE_ID)?.remove();

  const inject = css => {
    removeStyle();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    // document-end 时 head 一定在；append 到末尾 = 排在 VNDB 所有样式表之后
    (document.head || document.documentElement).append(style);
    return style;
  };

  const load = async theme => {
    const urls = CDN_BASES.map(base => base + theme.file);
    inject(await fetchText(urls));
    return theme;
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

  const start = async () => {
    const pick = resolve();

    if (pick.action === 'unknown') {
      console.warn(`${TAG} 没有叫 "${pick.choice}" 的主题，可选：${THEMES.map(t => t.name).join(' / ')}`);
      return;
    }
    if (pick.action === 'off') {
      removeStyle();
      console.info(`${TAG} 已停用（${new URLSearchParams(location.search).get('vskin') ? '?vskin=off' : 'vndbSkin.off()'}）`);
      return;
    }

    try {
      await load(pick.theme);
      console.info(`${TAG} ${pick.theme.name} ← ${pick.why}`);
      const skin = currentSkin();
      if (skin && skin !== EXPECTED_SKIN) {
        console.warn(`${TAG} 当前官方皮肤是 "${skin}"，主题是按 "${EXPECTED_SKIN}" 的变量体系写的，配色可能不对。`);
      }
    } catch (e) {
      // 加载失败就什么都不做：页面落回官方皮肤（+ 你在设置里留着的自定义 CSS，如果有的话）
      console.warn(`${TAG} 主题加载失败，已保持官方皮肤：`, e.message || e);
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
    off:   async () => { ls.set('off'); removeStyle(); console.info(`${TAG} 已停用（vndbSkin.auto() 恢复）`); },
    reload: start,
  };
  try { (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).vndbSkin = api; } catch { /* ignore */ }

  start();
})();
