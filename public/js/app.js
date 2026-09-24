/* app.js —— 交互、字宽测量、字号搜索、渲染与打印 */
(function () {
  'use strict';

  var PX_PER_MM = window.LabelLayout.PX_PER_MM;
  var MIN_BODY = 12, MAX_BODY = 24;
  var TITLE_RATIO = 1.4;          // 标题字号 = 正文 × 1.4
  var PADDING_MM = 8;             // 展签内边距
  var COL_GAP_MM = 6;             // 双栏模式下中英两栏的栏间距
  var TITLE_LINE_HEIGHT = 1.3;
  var BODY_LINE_HEIGHT = 1.6;
  var TITLE_GAP_PX_FACTOR = 0.5;  // 标题与正文间距 = 0.5 个正文字号
  var PARA_GAP_PX_FACTOR = 0.6;   // 段间距 = 0.6 个正文字号

  var el = {
    title: document.getElementById('title'),
    body: document.getElementById('body'),
    bodyEn: document.getElementById('bodyEn'),
    bodyRev: document.getElementById('bodyRev'),
    revCount: document.getElementById('revCount'),
    diffWrap: document.getElementById('diffWrap'),
    diffView: document.getElementById('diffView'),
    diffMeta: document.getElementById('diffMeta'),
    verStats: document.getElementById('verStats'),
    versionPick: document.getElementById('versionPick'),
    finalOrig: document.getElementById('finalOrig'),
    finalRev: document.getElementById('finalRev'),
    widthMm: document.getElementById('widthMm'),
    heightMm: document.getElementById('heightMm'),
    printBtn: document.getElementById('printBtn'),
    status: document.getElementById('status'),
    stage: document.getElementById('stage'),
    label: document.getElementById('label'),
    labelTitle: document.getElementById('labelTitle'),
    labelContent: document.getElementById('labelContent'),
    labelBody: document.getElementById('labelBody'),
    labelBodyEn: document.getElementById('labelBodyEn'),
    labelError: document.getElementById('labelError')
  };

  var REV_MAX_CHARS = 300; // 修订稿字数上限（按 Unicode 码位计）

  // ---------- Canvas 实际字宽测量（按 font 分别缓存） ----------
  // 正文与标题（加粗、1.4×）字号不同：每 font 一个独立 context，
  // 避免交替调用互相改写 ctx.font；缓存也按 font 隔离，避免拼接 key 碰撞。
  var measurers = {};

  function makeMeasure(font) {
    if (!measurers[font]) {
      var context = document.createElement('canvas').getContext('2d');
      context.font = font;
      var cache = {};
      measurers[font] = function (text) {
        var v = cache[text];
        if (v === undefined) {
          v = context.measureText(text).width;
          cache[text] = v;
        }
        return v;
      };
    }
    return measurers[font];
  }

  function fontString(size, weight) {
    var family = '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", ' +
                 '"SimSun", "Times New Roman", serif';
    return (weight || 400) + ' ' + size + 'px ' + family;
  }

  // 一栏正文的渲染高度（px）：行高 + 段间距
  function columnHeight(plan, bodyPx) {
    if (!plan) return 0;
    var paraGaps = (plan.paragraphs.length - 1) * bodyPx * PARA_GAP_PX_FACTOR;
    return plan.totalLines * bodyPx * BODY_LINE_HEIGHT + paraGaps;
  }

  // ---------- 一次排版尝试 ----------
  // 单栏（无英文译文）：正文占满内容宽。
  // 双栏（填写译文）：标题横跨整签，中文/英文按扣除 6mm 栏间距后的实际栏宽
  //                  各自独立断行，共用同一个正文字号。
  // 返回 { ok:true, ... } 或 { ok:false, reason: 'config'|'width'|'height', ... }
  function tryLayout(input, widthMm, heightMm, bodyPx) {
    var contentW = (widthMm - PADDING_MM * 2) * PX_PER_MM;
    var contentH = (heightMm - PADDING_MM * 2) * PX_PER_MM;
    if (contentW <= 4 || contentH <= 4) {
      return { ok: false, reason: 'config', message: '标签尺寸过小：内边距为 8mm，请加大宽或高。' };
    }

    var dual = !!input.dual;
    var hasZh = !!input.bodyTrim;
    var hasEn = !!input.enTrim;

    var titlePx = Math.round(bodyPx * TITLE_RATIO * 100) / 100;
    var bodyMeasure = makeMeasure(fontString(bodyPx, 400));
    var titleMeasure = makeMeasure(fontString(titlePx, 700));

    // 栏宽：单栏占满；双栏扣除栏间距后平分
    var colW = dual
      ? (contentW - COL_GAP_MM * PX_PER_MM) / 2
      : contentW;
    if (colW <= 1) {
      var narrow = [];
      if (hasZh) narrow.push({ key: 'zh', widthMm: 0 });
      if (dual && hasEn) narrow.push({ key: 'en', widthMm: 0 });
      return { ok: false, reason: 'width', bodyPx: bodyPx, widthFailures: narrow };
    }

    // 标题横跨整签（两种模式均按内容全宽规划，允许折行）
    var titlePlan = null;
    var titleWidthFail = false;
    if (input.titleTrim) {
      titlePlan = window.LabelLayout.planText(input.titleTrim, contentW, titleMeasure);
      if (!titlePlan) titleWidthFail = true;
    }

    var zhPlan = null, enPlan = null;
    var widthFailures = [];
    if (titleWidthFail) {
      widthFailures.push({ key: 'title', widthMm: contentW / PX_PER_MM });
    }
    if (hasZh) {
      zhPlan = window.LabelLayout.planText(input.bodyTrim, colW, bodyMeasure);
      if (!zhPlan) widthFailures.push({ key: 'zh', widthMm: colW / PX_PER_MM });
    }
    if (dual && hasEn) {
      enPlan = window.LabelLayout.planText(input.enTrim, colW, bodyMeasure);
      if (!enPlan) widthFailures.push({ key: 'en', widthMm: colW / PX_PER_MM });
    }

    if (widthFailures.length) {
      return { ok: false, reason: 'width', bodyPx: bodyPx, widthFailures: widthFailures };
    }

    if (!titlePlan && !zhPlan && !enPlan) {
      return {
        ok: true, dual: dual, titlePlan: null, zhPlan: null, enPlan: null,
        bodyPx: bodyPx, titlePx: titlePx, contentH: 0, colWMm: colW / PX_PER_MM
      };
    }

    // 高度核算：标题（横跨整签）+ 标题间距 + 较高一栏
    var titleH = 0, titleGap = 0;
    if (titlePlan) {
      titleH = titlePlan.totalLines * titlePx * TITLE_LINE_HEIGHT;
      if (zhPlan || enPlan) titleGap = bodyPx * TITLE_GAP_PX_FACTOR;
    }
    var zhH = columnHeight(zhPlan, bodyPx);
    var enH = columnHeight(enPlan, bodyPx);
    var bodyH = Math.max(zhH, enH);
    var totalH = titleH + titleGap + bodyH;

    if (totalH > contentH + 0.75) {
      return {
        ok: false, reason: 'height', bodyPx: bodyPx,
        totalH: totalH, contentH: contentH,
        zhH: zhH, enH: enH, titleH: titleH + titleGap
      };
    }

    return {
      ok: true, dual: dual, titlePlan: titlePlan, zhPlan: zhPlan, enPlan: enPlan,
      bodyPx: bodyPx, titlePx: titlePx, contentH: totalH,
      zhH: zhH, enH: enH, colWMm: colW / PX_PER_MM
    };
  }

  // ---------- 12→24 中选最大可行字号 ----------
  function computeLayout(input) {
    var lastHeightFailure = null;
    for (var px = MAX_BODY; px >= MIN_BODY; px--) {
      var r = tryLayout(input, input.widthMm, input.heightMm, px);
      if (r.ok) return r;
      if (r.reason === 'config') return r;     // 尺寸配置错误，与字号无关
      if (r.reason === 'width') {
        if (px === MIN_BODY) return r;         // 最小字号仍超宽，无法挽救
        continue;
      }
      if (r.reason === 'height') lastHeightFailure = r;
    }
    // 12px 仍超高
    return lastHeightFailure || {
      ok: false, reason: 'height', bodyPx: MIN_BODY, totalH: 0, contentH: 0
    };
  }

  // ---------- 错误文案 ----------
  var COL_NAMES = { title: '标题', zh: '中文原文栏', en: '英文译文栏' };

  function widthFailureMessage(result, dual) {
    var parts = result.widthFailures.map(function (f) {
      if (f.key === 'title') {
        return '标题存在即使 ' + result.bodyPx + 'px（最小字号）也无法放入整签宽度的连续内容';
      }
      var colLabel = dual ? COL_NAMES[f.key] : '正文';
      return colLabel + '存在即使 ' + result.bodyPx +
        'px（最小字号）也无法放入' + (dual ? '栏' : '行') + '宽（约 ' +
        Math.max(0, Math.round(f.widthMm)) +
        'mm）的连续内容（如过长的英文单词）';
    });
    var head = dual ? '排不下（双栏）：' : '排不下：';
    return head + parts.join('；') + '。请加宽标签' +
      (dual ? '（加宽后两栏栏宽同步增加）' : '') + '或修改文案——不会截断显示。';
  }

  function heightFailureMessage(result, dual) {
    var where = '';
    if (dual) {
      // 较高一栏（计入标题时以正文两栏比较）
      if (result.enH > result.zhH) where = '（英文译文栏较高）';
      else if (result.zhH > 0) where = '（中文原文栏较高）';
    }
    return '内容在 12–24px 任何字号下都超出标签高度' + where + '（需要约 ' +
      Math.round(result.totalH / PX_PER_MM) + 'mm，可用 ' +
      Math.round(result.contentH / PX_PER_MM) + 'mm）。\n' +
      '请加高标签或精简文案——不会截断显示。';
  }

  // ---------- 渲染 ----------
  function buildLines(container, plan) {
    container.innerHTML = '';
    plan.paragraphs.forEach(function (para) {
      var p = document.createElement('div');
      p.className = 't-paragraph';
      para.lines.forEach(function (lineText) {
        var div = document.createElement('div');
        div.className = 't-line';
        div.textContent = lineText;
        p.appendChild(div);
      });
      container.appendChild(p);
    });
  }

  function setDualMode(dual) {
    el.labelContent.classList.toggle('dual', !!dual);
    el.labelBodyEn.hidden = !dual;
  }

  // ---------- 修订对照 ----------
  function cpLen(s) { return Array.from(s).length; }

  // 传给排版器的一版输入：除中文正文外（标题/译文/尺寸）两版完全相同
  function layoutInput(input, bodyText) {
    return {
      titleTrim: input.titleTrim,
      bodyTrim: bodyText,
      enTrim: input.enTrim,
      dual: input.dual,
      widthMm: input.widthMm,
      heightMm: input.heightMm
    };
  }

  // 把对齐结果渲染到对照区：删除片段加删除线、新增片段加底色；
  // 删除/新增片段内的换行符以 ↵ 显形。差异标记只存在于面板对照区。
  function renderDiff(ops) {
    el.diffView.innerHTML = '';
    var stats = { del: 0, ins: 0, delSeg: 0, insSeg: 0 };
    var frag = document.createDocumentFragment();
    ops.forEach(function (op) {
      if (op.type === 'keep') {
        frag.appendChild(document.createTextNode(op.text));
        return;
      }
      var span = document.createElement('span');
      span.className = op.type === 'del' ? 'diff-del' : 'diff-ins';
      span.textContent = op.text.replace(/\n/g, '↵\n');
      frag.appendChild(span);
      if (op.type === 'del') { stats.del += cpLen(op.text); stats.delSeg++; }
      else { stats.ins += cpLen(op.text); stats.insSeg++; }
    });
    el.diffView.appendChild(frag);
    el.diffMeta.textContent = (!stats.del && !stats.ins)
      ? '两版文字完全一致，无增删。'
      : '对照结果：删除 ' + stats.del + ' 字（' + stats.delSeg + ' 段），新增 ' +
        stats.ins + ' 字（' + stats.insSeg + ' 段）。';
  }

  // 一版的排版结论：正文字号、中文行数、能否容纳
  function versionStatLine(name, selected, result) {
    var head = name + (selected ? '（成品）' : '') + '：';
    if (result.ok) {
      return {
        ok: true,
        text: head + '正文 ' + result.bodyPx + 'px，中文 ' +
          (result.zhPlan ? result.zhPlan.totalLines : 0) + ' 行，可容纳'
      };
    }
    var reason = result.reason === 'width' ? '超宽'
      : result.reason === 'height' ? '超高' : '尺寸无效';
    return { ok: false, text: head + '排不下（' + reason + '）' };
  }

  function renderVerStats(results, selKey) {
    el.verStats.innerHTML = '';
    ['orig', 'rev'].forEach(function (key) {
      var line = versionStatLine(key === 'orig' ? '原稿' : '修订稿', key === selKey, results[key]);
      var div = document.createElement('div');
      div.className = 'ver-stat ' + (line.ok ? 'ok' : 'err');
      div.textContent = line.text;
      el.verStats.appendChild(div);
    });
    var a = results.orig, b = results.rev;
    if (a.ok && b.ok) {
      var div = document.createElement('div');
      div.className = 'ver-stat';
      div.textContent = '变化：正文字号 ' + a.bodyPx + '→' + b.bodyPx + 'px，中文行数 ' +
        (a.zhPlan ? a.zhPlan.totalLines : 0) + '→' + (b.zhPlan ? b.zhPlan.totalLines : 0);
      el.verStats.appendChild(div);
    }
  }

  var lastGood = null;

  function render() {
    var input = {
      title: el.title.value,
      body: el.body.value,
      bodyEn: el.bodyEn.value,
      bodyRev: el.bodyRev.value,
      widthMm: parseFloat(el.widthMm.value),
      heightMm: parseFloat(el.heightMm.value)
    };
    input.titleTrim = input.title.trim();
    input.bodyTrim = input.body.trim();
    input.enTrim = input.bodyEn.trim();
    input.revTrim = input.bodyRev.trim();
    input.dual = input.enTrim.length > 0;

    // 修订稿非空即进入对照模式；字数按 Unicode 码位统计
    var comparing = input.revTrim.length > 0;
    var revCount = cpLen(input.bodyRev);
    el.revCount.textContent = revCount + ' / ' + REV_MAX_CHARS;
    el.revCount.classList.toggle('over', revCount > REV_MAX_CHARS);
    el.diffWrap.hidden = !comparing;
    el.versionPick.hidden = !comparing;

    setDualMode(input.dual);

    if (!(input.widthMm >= 30 && input.widthMm <= 999 &&
          input.heightMm >= 20 && input.heightMm <= 999)) {
      setStatus('请输入有效的标签尺寸：宽 30–999mm，高 20–999mm。', 'err');
      showError('标签尺寸无效\n（宽 30–999mm，高 20–999mm）');
      el.printBtn.disabled = true;
      return;
    }

    if (comparing && revCount > REV_MAX_CHARS) {
      setStatus('修订稿超过 ' + REV_MAX_CHARS + ' 字（当前 ' + revCount +
        ' 字），请精简至 ' + REV_MAX_CHARS + ' 字以内。', 'err');
      showError('修订稿超过 ' + REV_MAX_CHARS + ' 字\n（当前 ' + revCount + ' 字）');
      el.printBtn.disabled = true;
      fitScale();
      return;
    }

    // 最短增删对照：只渲染在面板对照区，差异标记不进入展签与打印
    if (comparing) {
      renderDiff(window.LabelLayout.diffChars(input.bodyTrim, input.revTrim));
    }

    // 原稿与修订稿分别沿用当前尺寸与英文译文运行同一排版
    var selKey = comparing && el.finalRev.checked ? 'rev' : 'orig';
    var results = { orig: computeLayout(layoutInput(input, input.bodyTrim)) };
    if (comparing) {
      results.rev = computeLayout(layoutInput(input, input.revTrim));
      renderVerStats(results, selKey);
    }

    var result = results[selKey];
    var prefix = comparing ? '成品·' + (selKey === 'rev' ? '修订稿' : '原稿') + '：' : '';

    if (!result.ok) {
      var msg;
      if (result.reason === 'config') {
        msg = result.message;
        setStatus(prefix + msg, 'err');
        showError('标签尺寸过小\n' + msg);
      } else if (result.reason === 'width') {
        msg = widthFailureMessage(result, input.dual);
        setStatus(prefix + msg, 'err');
        showError(msg);
      } else {
        msg = heightFailureMessage(result, input.dual);
        setStatus(prefix + msg, 'err');
        showError(msg);
      }
      el.printBtn.disabled = true;
      fitScale();
      return;
    }

    lastGood = { input: input, result: result };

    // 写入物理尺寸与字号
    var s = el.label.style;
    s.setProperty('--label-w', input.widthMm + 'mm');
    s.setProperty('--label-h', input.heightMm + 'mm');
    s.setProperty('--body-size', result.bodyPx + 'px');
    s.setProperty('--title-size', result.titlePx + 'px');
    s.setProperty('--title-gap',
      result.titlePlan && (result.zhPlan || result.enPlan)
        ? (result.bodyPx * TITLE_GAP_PX_FACTOR) + 'px'
        : '0px');
    s.setProperty('--para-gap', result.bodyPx * PARA_GAP_PX_FACTOR + 'px');

    el.labelError.hidden = true;

    el.labelTitle.innerHTML = '';
    if (result.titlePlan) {
      buildLines(el.labelTitle, result.titlePlan);
    }

    el.labelBody.innerHTML = '';
    if (result.zhPlan) {
      buildLines(el.labelBody, result.zhPlan);
    }

    el.labelBodyEn.innerHTML = '';
    if (result.enPlan) {
      buildLines(el.labelBodyEn, result.enPlan);
    }

    var usedH = Math.round(result.contentH / PX_PER_MM);
    var info = prefix + '正文字号 ' + result.bodyPx + 'px（标题 ' +
      Math.round(result.titlePx * 10) / 10 + 'px）';
    if (result.dual) {
      info += '，双栏栏宽约 ' + Math.round(result.colWMm) + 'mm';
      if (result.zhPlan) info += '，中文 ' + result.zhPlan.totalLines + ' 行';
      if (result.enPlan) info += '，英文 ' + result.enPlan.totalLines + ' 行';
    } else if (result.zhPlan) {
      info += '，正文 ' + result.zhPlan.totalLines + ' 行';
    }
    if (result.titlePlan) info += '，标题 ' + result.titlePlan.totalLines + ' 行';
    info += '，内容高约 ' + usedH + 'mm / ' +
      Math.round(input.heightMm - PADDING_MM * 2) + 'mm';
    setStatus(info, 'ok');

    el.printBtn.disabled = false;
    fitScale();
  }

  function showError(message) {
    el.labelError.textContent = message;
    el.labelError.hidden = false;
    el.labelTitle.innerHTML = '';
    el.labelBody.innerHTML = '';
    el.labelBodyEn.innerHTML = '';
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- 屏幕预览缩放（仅显示用，不影响打印的毫米尺寸） ----------
  function fitScale() {
    var wMm = parseFloat(el.widthMm.value) || 120;
    var hMm = parseFloat(el.heightMm.value) || 80;
    var availW = el.stage.clientWidth - 24;
    var availH = el.stage.clientHeight - 24;
    var labelW = wMm * PX_PER_MM;
    var labelH = hMm * PX_PER_MM;
    var scale = Math.min(1, availW / labelW, availH / labelH);
    if (!(scale > 0) || !isFinite(scale)) scale = 1;
    el.label.style.transform = 'scale(' + scale + ')';
  }

  // ---------- 打印前把 @page 尺寸设为标签物理尺寸 ----------
  var pageStyle = null;
  function beforePrint() {
    if (el.printBtn.disabled || !lastGood) return;
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = '@page { size: ' +
      lastGood.input.widthMm + 'mm ' + lastGood.input.heightMm + 'mm; margin: 0; }';
  }

  // ---------- 初始化 ----------
  el.body.value =
    '新石器时代·仰韶文化，约公元前 5000–前 3000 年。\n' +
    '泥质红陶，器表刻划有几何纹（geometric patterns），是研究黄河中游早期制陶工艺（pottery craftsmanship）的重要实物。出土于河南省渑池县仰韶村，1951 年入藏。';
  // 英文译文默认留空：页面初次打开保持原有单栏呈现。

  var schedule = (function () {
    var timer = null;
    return function () { clearTimeout(timer); timer = setTimeout(render, 120); };
  })();

  ['input', 'change'].forEach(function (evt) {
    el.title.addEventListener(evt, schedule);
    el.body.addEventListener(evt, schedule);
    el.bodyEn.addEventListener(evt, schedule);
    el.bodyRev.addEventListener(evt, schedule);
    el.widthMm.addEventListener(evt, schedule);
    el.heightMm.addEventListener(evt, schedule);
    el.finalOrig.addEventListener(evt, schedule);
    el.finalRev.addEventListener(evt, schedule);
  });

  el.printBtn.addEventListener('click', function () { window.print(); });
  window.addEventListener('beforeprint', beforePrint);

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitScale, 80);
  });

  // 字体加载完成后重排，确保测量字宽与渲染一致
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(render);
  }
  render();
})();
