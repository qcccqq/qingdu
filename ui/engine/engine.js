"use strict";

/* ============================================================
   轻读 · 阶段 2 编辑引擎（app-tauri/ui/engine/engine.js）
   ------------------------------------------------------------
   架构（严格遵循 docs/阶段2-编辑引擎技术预研.md 选定的 C+D 混合方案）：
     · 常驻 XML DOM 树（DOMParser 解析 document.xml）＝唯一事实源，不建第二文档模型
     · 编辑 = 定点改树，一切修改走命令对象（可撤销 / 可重做）
     · 保存 = XMLSerializer 整树序列化 word/document.xml
              + 其余 zip 条目用 load 时保存的原始 Uint8Array 字节级原样回填
              + fflate.zipSync(level: 6) 重打包 → 未动部件字节级保真

   分层（为 Node 端可测性拆成两层）：
     1) 纯逻辑层：命令栈 + 段落文本计划函数（planSetText / planSplit / planDeleteChar）。
        只处理字符串数组与抽象命令对象，不触碰任何 DOM —— Node 测试可直接单测。
     2) DOM 适配层：load / paragraphs / getParaText / setText / 七个命令 / serialize。
        fflate、DOMParser、XMLSerializer 经 init({ fflate, DOMParser, XMLSerializer })
        注入；浏览器端若未显式 init，则自动回退到同名全局对象。

   v1 限制（对应预研报告"风险清单"）：
     · 只索引 w:body 的直接子元素 w:p；表格内段落不进编辑索引（复杂表格映射风险）
     · 修订标记（w:ins / w:del）文档原样保留，v1 不解析不改写
     · 多 run 段落改文本 = 首个非空 w:t 承载全文、其余 w:t 清空
       （保留各 run 的 rPr 格式骨架，但文本会被归并到首个非空 run —— v1 简化）
     · 不处理 xml:space="preserve" 的首尾空白语义（v1 不支持带首尾空格的文本编辑）
     · 文本指纹校验：SetTextCmd 首次执行前比对 oldText 与当前段落文本，
       对不齐则抛错拒编（表格/复杂段落映射错位的防线）
   ============================================================ */

var QingDuEngine = (function () {

  /* ==================== 依赖注入 ==================== */
  var deps = { fflate: null, DOMParser: null, XMLSerializer: null };

  function init(opts) {
    opts = opts || {};
    if (opts.fflate) deps.fflate = opts.fflate;
    if (opts.DOMParser) deps.DOMParser = opts.DOMParser;
    if (opts.XMLSerializer) deps.XMLSerializer = opts.XMLSerializer;
  }

  function useFflate() {
    var f = deps.fflate || (typeof fflate !== "undefined" ? fflate : null);
    if (!f || typeof f.unzipSync !== "function" || typeof f.zipSync !== "function") {
      throw new Error("fflate 未就绪：请先 QingDuEngine.init({ fflate }) 或引入 ui/libs/fflate.min.js");
    }
    return f;
  }
  function useDOMParser() {
    var P = deps.DOMParser || (typeof DOMParser !== "undefined" ? DOMParser : null);
    if (!P) throw new Error("DOMParser 未就绪：请先 QingDuEngine.init({ DOMParser })");
    return P;
  }
  function useXMLSerializer() {
    var S = deps.XMLSerializer || (typeof XMLSerializer !== "undefined" ? XMLSerializer : null);
    if (!S) throw new Error("XMLSerializer 未就绪：请先 QingDuEngine.init({ XMLSerializer })");
    return S;
  }

  /* ==================== 纯逻辑层：段落文本计划 ====================
     输入输出都是字符串数组（把 w:p 里按文档序排列的 w:t 文本抽象成数组），
     不触碰任何节点 —— Node 测试用普通数组/简易对象即可覆盖。
  ================================================================ */

  /* 改文本计划：首个非空下标承载 newText，其余清空；
     全空则落到第 0 个；数组为空则原样返回空数组（调用方负责新建 run）。 */
  function planSetText(texts, newText) {
    var target = -1, i;
    for (i = 0; i < texts.length; i++) {
      if (texts[i]) { target = i; break; }
    }
    if (target === -1 && texts.length > 0) target = 0;
    var val = (newText === null || newText === undefined) ? "" : String(newText);
    var out = [];
    for (i = 0; i < texts.length; i++) out.push(i === target ? val : "");
    return out;
  }

  /* 分段计划：在全局字符偏移 offset 处把文本数组切成左右两半。
     偏移裁剪到 [0, 总长]；落在某个 w:t 末边界时，该 w:t 整体归左、从下一段开始归右。 */
  function planSplit(texts, offset) {
    var total = 0, i;
    for (i = 0; i < texts.length; i++) total += texts[i].length;
    var off = Math.floor(Number(offset));
    if (!isFinite(off) || off < 0) off = 0;
    if (off > total) off = total;
    var left = [], right = [], acc = 0;
    for (i = 0; i < texts.length; i++) {
      var t = texts[i], local = off - acc;
      if (local <= 0) { left.push(""); right.push(t); }
      else if (local >= t.length) { left.push(t); right.push(""); }
      else { left.push(t.slice(0, local)); right.push(t.slice(local)); }
      acc += t.length;
    }
    return { left: left, right: right };
  }

  /* 删字符计划：删除全局偏移 offset 处的一个字符（按码点，代理对一次删两个码元）。
     偏移越界（含空段落、删到末尾之后）→ 返回原数组副本，语义为无操作。 */
  function planDeleteChar(texts, offset) {
    var total = 0, i;
    for (i = 0; i < texts.length; i++) total += texts[i].length;
    var off = Math.floor(Number(offset));
    if (!isFinite(off) || off < 0 || off >= total) return texts.slice();
    var acc = 0;
    for (i = 0; i < texts.length; i++) {
      var t = texts[i];
      if (off < acc + t.length) {
        var local = off - acc;
        var cut = 1;
        var code = t.charCodeAt(local);
        if (code >= 0xD800 && code <= 0xDBFF && local + 1 < t.length) {
          var low = t.charCodeAt(local + 1);
          if (low >= 0xDC00 && low <= 0xDFFF) cut = 2;   // 代理对整体删除
        }
        var out = texts.slice();
        out[i] = t.slice(0, local) + t.slice(local + cut);
        return out;
      }
      acc += t.length;
    }
    return texts.slice();
  }

  /* ==================== 纯逻辑层：命令栈（撤销 / 重做） ====================
     命令对象约定：{ label: 字符串, do(doc), undo(doc) }，do/undo 必须严格互逆。
     execute 先执行后入栈 —— 执行抛错（如文本指纹不符）时栈保持不动。
     v1 不设条数上限：命令对象很小，截断会破坏"撤销回原始状态"的保证。
  ================================================================ */
  function createCommandStack(doc) {
    var undoList = [], redoList = [];
    var stack = {
      doc: doc || null,
      execute: function (cmd) {
        cmd.do(stack.doc);
        undoList.push(cmd);
        redoList.length = 0;                       // 新编辑作废重做分支
        stack.canUndo = true;
        stack.canRedo = false;
      },
      size: function () { return undoList.length; },   // 已执行未撤销的命令数（保存点比对用）
      undo: function () {
        if (!undoList.length) return false;
        var cmd = undoList.pop();
        cmd.undo(stack.doc);
        redoList.push(cmd);
        stack.canUndo = undoList.length > 0;
        stack.canRedo = true;
        return true;
      },
      redo: function () {
        if (!redoList.length) return false;
        var cmd = redoList.pop();
        cmd.do(stack.doc);
        undoList.push(cmd);
        stack.canUndo = true;
        stack.canRedo = redoList.length > 0;
        return true;
      },
      canUndo: false,
      canRedo: false
    };
    return stack;
  }

  /* ==================== DOM 适配层：小工具 ==================== */

  var W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  function toArray(list) {
    return Array.prototype.slice.call(list);
  }

  /* 直接子元素中标签名匹配的（el.children 只含元素节点，浏览器与 shim 一致） */
  function childrenByTag(el, tag) {
    var out = [], kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tagName === tag) out.push(kids[i]);
    }
    return out;
  }
  function childByTag(el, tag) {
    var a = childrenByTag(el, tag);
    return a.length ? a[0] : null;
  }

  function localName(tag) {
    var i = tag.indexOf(":");
    return i < 0 ? tag : tag.slice(i + 1);
  }

  /* 新建 w:* 元素（命名空间必须带，浏览器/shim 均走 createElementNS） */
  function mkEl(ref, tag) {
    var doc = ref.ownerDocument;
    if (!doc) throw new Error("mkEl: 节点缺少 ownerDocument");
    return doc.createElementNS(W_NS, tag);
  }

  /* w:rPr 常见子元素的 OOXML 枚举顺序（新建元素按此归位插入，保证 Word 合法序） */
  var RPR_ORDER = [
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps",
    "strike", "dstrike", "outline", "shadow", "emboss", "imprint",
    "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing",
    "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect",
    "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang",
    "eastAsianLayout", "specVanish", "oMath"
  ];
  function insertInRPr(rPr, el) {
    var idx = RPR_ORDER.indexOf(localName(el.tagName));
    if (idx < 0) { rPr.appendChild(el); return; }
    var kids = rPr.children;
    for (var i = 0; i < kids.length; i++) {
      var ki = RPR_ORDER.indexOf(localName(kids[i].tagName));
      if (ki !== -1 && ki > idx) { rPr.insertBefore(el, kids[i]); return; }
    }
    rPr.appendChild(el);
  }

  /* 取（必要时创建）run 的 w:rPr —— OOXML 要求 rPr 是 run 的第一个子元素 */
  function ensureRPr(run) {
    var rPr = childByTag(run, "w:rPr");
    if (!rPr) {
      rPr = mkEl(run, "w:rPr");
      var first = run.childNodes.length ? run.childNodes[0] : null;
      run.insertBefore(rPr, first);
    }
    return rPr;
  }

  /* 属性快照：命令 do 前记录，undo 时原样恢复（含属性顺序），保证严格互逆 */
  function attrsSnapshot(el) {
    if (!el) return null;
    var out = [], at = el.attributes;
    for (var i = 0; i < at.length; i++) out.push({ name: at[i].name, value: at[i].value });
    return out;
  }
  function attrsRestore(el, snap) {
    var at = el.attributes, names = [], i;
    for (i = 0; i < at.length; i++) names.push(at[i].name);
    for (i = 0; i < names.length; i++) el.removeAttribute(names[i]);
    for (i = 0; i < snap.length; i++) el.setAttribute(snap[i].name, snap[i].value);
  }

  /* 把计划结果写回 w:t 节点（值没变的不碰，避免无谓标脏） */
  function applyTexts(nodes, texts) {
    for (var i = 0; i < nodes.length && i < texts.length; i++) {
      if (nodes[i].textContent !== texts[i]) nodes[i].textContent = texts[i];
    }
  }

  /* ==================== DOM 适配层：文档加载 ==================== */

  /* 解析一段 XML；失败统一包装成带部件名的错误 */
  function parseXml(str, what) {
    var P = useDOMParser();
    var d;
    try {
      d = new P().parseFromString(str, "application/xml");
    } catch (e) {
      throw new Error(what + " 解析失败：" + (e && e.message ? e.message : e));
    }
    if (!d) throw new Error(what + " 解析失败：返回空文档");
    // 浏览器解析失败会产出 <parsererror> 文档；shim 则直接抛错（上面已接住）
    var bad = d.getElementsByTagName("parsererror");
    if (bad && bad.length) throw new Error(what + " 解析失败：XML 格式错误");
    return d;
  }

  /* 打开 docx：解压 → 字节原样保留 → 解析 document.xml → 返回引擎 doc 对象。
     entries 的每个 Uint8Array 都是该条目的完整原始内容（字节级，序列化时原样回填）。 */
  function load(bytes) {
    var fz = useFflate();
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    var entries = fz.unzipSync(bytes);
    if (!entries["word/document.xml"]) throw new Error("压缩包内缺少 word/document.xml");

    var dec = new TextDecoder("utf-8");            // utf-8 解码默认剥掉 BOM
    var docXml = parseXml(dec.decode(entries["word/document.xml"]), "word/document.xml");
    var body = docXml.getElementsByTagName("w:body")[0];
    if (!body) throw new Error("word/document.xml 中未找到 w:body");

    /* rId → Target 映射（关系只读引用；Target 相对 word/ 目录，由调用方拼接） */
    var rels = {};
    var relBytes = entries["word/_rels/document.xml.rels"];
    if (relBytes) {
      var relDoc = parseXml(dec.decode(relBytes), "word/_rels/document.xml.rels");
      var list = relDoc.getElementsByTagName("Relationship");
      for (var i = 0; i < list.length; i++) {
        var id = list[i].getAttribute("Id");
        var tgt = list[i].getAttribute("Target");
        if (id && tgt) rels[id] = tgt;
      }
    }

    return { entries: entries, docXml: docXml, body: body, rels: rels };
  }

  /* ==================== DOM 适配层：段落读取 ==================== */

  /* body 直接子元素中的顶层 w:p（表格内段落不索引 —— v1 限制） */
  function paragraphs(doc) {
    var out = [], kids = doc.body.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tagName === "w:p") out.push(kids[i]);
    }
    return out;
  }

  /* 段落内全部 w:t 文本按文档序拼接 */
  function getParaText(p) {
    var ts = toArray(p.getElementsByTagName("w:t"));
    var out = [];
    for (var i = 0; i < ts.length; i++) out.push(ts[i].textContent);
    return out.join("");
  }

  /* 段落内全部 w:r（含超链接内的 run），按文档序 */
  function runs(p) {
    return toArray(p.getElementsByTagName("w:r"));
  }

  /* ==================== DOM 适配层：改文本 ==================== */

  /* 把段落文本改为 newText：
     · 段落没有任何 w:t → 新建一个无格式 run + w:t（effect.created 记录，供命令 undo 拆除）
     · 否则走纯逻辑层 planSetText：首个非空 w:t 承载全文、其余清空（保留 rPr 骨架）
       —— 多 run 段落的 v1 简化，见文件头注释 */
  function setText(p, newText, effect) {
    var ts = toArray(p.getElementsByTagName("w:t"));
    if (!ts.length) {
      var run = mkEl(p, "w:r");
      var t = mkEl(p, "w:t");
      run.appendChild(t);
      p.appendChild(run);
      if (effect && effect.created) effect.created.push(run);
      t.textContent = (newText === null || newText === undefined) ? "" : String(newText);
      return;
    }
    var texts = [], i;
    for (i = 0; i < ts.length; i++) texts.push(ts[i].textContent);
    var plan = planSetText(texts, newText);
    applyTexts(ts, plan);
  }

  /* ==================== DOM 适配层：命令 ==================== */

  /* 改整段文本。oldText 是执行前提（文本指纹）：首次 do 时与当前段落比对，
     对不齐立即抛错拒编；undo 按 do 之前逐个 w:t 的原值精确还原。 */
  function SetTextCmd(p, oldText, newText) {
    var snap = null;   // { nodes:[w:t], texts:[原值], created:[新建run] }
    return {
      label: "修改文本",
      do: function () {
        if (!snap) {
          if (getParaText(p) !== oldText) {
            throw new Error("文本指纹校验失败：段落内容与命令前提不一致，拒绝编辑");
          }
          var nodes = toArray(p.getElementsByTagName("w:t"));
          var texts = [], i;
          for (i = 0; i < nodes.length; i++) texts.push(nodes[i].textContent);
          snap = { nodes: nodes, texts: texts, created: [] };
        } else if (snap.created.length && !snap.created[0].parentNode) {
          p.appendChild(snap.created[0]);   // redo：把首次 do 新建的 run 重新挂回
        }
        setText(p, newText, snap);
      },
      undo: function () {
        if (!snap) return;
        applyTexts(snap.nodes, snap.texts);
        for (var j = 0; j < snap.created.length; j++) {
          var r = snap.created[j];
          if (r.parentNode) r.parentNode.removeChild(r);
        }
      }
    };
  }

  /* 格式命令工厂：对 run 的 rPr 下某个属性元素做"出现/移除"（toggle）
     或"设 w:val"（setval）。首次 do 前快照 rPr 与属性元素的完整状态，undo 精确还原。 */
  function makeFormatCmd(label, run, propName, spec) {
    var snap = null;
    return {
      label: label,
      do: function () {
        if (!snap) {
          var rPr0 = childByTag(run, "w:rPr");
          var p0 = rPr0 ? childByTag(rPr0, propName) : null;
          snap = {
            rPrExisted: !!rPr0,
            propExisted: !!p0,
            propAttrs: attrsSnapshot(p0)
          };
        }
        var rPr = ensureRPr(run);
        var prop = childByTag(rPr, propName);
        if (spec.mode === "toggle") {
          if (spec.value) {
            if (!prop) { prop = mkEl(run, propName); insertInRPr(rPr, prop); }
          } else if (prop) {
            rPr.removeChild(prop);           // 元素缺席 = 关（Word 语义）
          }
        } else {                              // setval：设 w:val，可选剥离 theme* 属性
          if (!prop) { prop = mkEl(run, propName); insertInRPr(rPr, prop); }
          prop.setAttribute("w:val", spec.value);
          if (spec.dropAttrs) {
            for (var i = 0; i < spec.dropAttrs.length; i++) prop.removeAttribute(spec.dropAttrs[i]);
          }
        }
      },
      undo: function () {
        if (!snap) return;
        var rPr = childByTag(run, "w:rPr");
        if (!snap.rPrExisted) {
          // rPr 是本命令建出来的：连锅端掉
          if (rPr && rPr.parentNode) rPr.parentNode.removeChild(rPr);
          return;
        }
        if (!rPr) return;                    // 防御：结构被外部改动
        var prop = childByTag(rPr, propName);
        if (!snap.propExisted) {
          if (prop) rPr.removeChild(prop);
          return;
        }
        if (!prop) { prop = mkEl(run, propName); insertInRPr(rPr, prop); }
        attrsRestore(prop, snap.propAttrs);
      }
    };
  }

  /* 加粗：w:b 元素出现 = 开，缺席 = 关 */
  function SetBoldCmd(run, value) {
    return makeFormatCmd("加粗", run, "w:b", { mode: "toggle", value: !!value });
  }
  /* 倾斜：w:i；同 toggle 语义（v1 不动 w:iCs / w:bCs） */
  function SetItalicCmd(run, value) {
    return makeFormatCmd("倾斜", run, "w:i", { mode: "toggle", value: !!value });
  }
  /* 字号：w:sz 的 w:val，单位半磅（21 = 10.5 磅）（v1 不动 w:szCs） */
  function SetFontSizeCmd(run, halfPoints) {
    return makeFormatCmd("字号", run, "w:sz", { mode: "setval", value: String(halfPoints) });
  }
  /* 颜色：w:color 的 w:val，十六进制可带/不带 #；同时剥离 theme* 让显式值生效 */
  function SetColorCmd(run, hex) {
    return makeFormatCmd("颜色", run, "w:color", {
      mode: "setval",
      value: String(hex).replace(/^#/, ""),
      dropAttrs: ["w:themeColor", "w:themeShade", "w:themeTint"]
    });
  }

  /* 分段：在文本 offset 处把段落拆成两个 w:p。
     做法：深拷贝整个段落（pPr 随拷贝天然复制），再按计划把左右两半文本
     分别落到原段落与新段落的对应 w:t 上（结构/格式骨架两边都保留 —— v1 简化，
     切点右侧在原段落里会留下空 run，Word 容忍）。undo = 移除新段落 + 还原原文本。 */
  function SplitParagraphCmd(p, offset) {
    var snap = null;   // { nodes, texts, newP }
    function splitPlans() { return planSplit(snap.texts, offset); }
    return {
      label: "分段",
      do: function () {
        if (!snap) {
          var nodes = toArray(p.getElementsByTagName("w:t"));
          var texts = [], i;
          for (i = 0; i < nodes.length; i++) texts.push(nodes[i].textContent);
          var plan = planSplit(texts, offset);
          var newP = p.cloneNode(true);
          var newNodes = toArray(newP.getElementsByTagName("w:t"));
          applyTexts(nodes, plan.left);          // 原段落：取左半
          applyTexts(newNodes, plan.right);      // 新段落：取右半（同构子树，下标对齐）
          var parent = p.parentNode;
          if (!parent) throw new Error("分段失败：段落不在文档树中");
          parent.insertBefore(newP, p.nextSibling || null);
          snap = { nodes: nodes, texts: texts, newP: newP };
        } else {
          var plan2 = splitPlans();
          applyTexts(snap.nodes, plan2.left);
          if (!snap.newP.parentNode) {
            p.parentNode.insertBefore(snap.newP, p.nextSibling || null);
          }
          applyTexts(toArray(snap.newP.getElementsByTagName("w:t")), plan2.right);
        }
      },
      undo: function () {
        if (!snap) return;
        if (snap.newP.parentNode) snap.newP.parentNode.removeChild(snap.newP);
        applyTexts(snap.nodes, snap.texts);
      }
    };
  }

  /* 删字符：删除段落文本 offset 处的一个字符（要退格语义就传 offset - 1）。
     undo 还原 do 之前全部 w:t 的原值。 */
  function DeleteCharCmd(p, offset) {
    var snap = null;   // { nodes, texts }
    return {
      label: "删除字符",
      do: function () {
        if (!snap) {
          var nodes = toArray(p.getElementsByTagName("w:t"));
          var texts = [], i;
          for (i = 0; i < nodes.length; i++) texts.push(nodes[i].textContent);
          snap = { nodes: nodes, texts: texts };
        }
        var cur = [], j;
        for (j = 0; j < snap.nodes.length; j++) cur.push(snap.nodes[j].textContent);
        applyTexts(snap.nodes, planDeleteChar(cur, offset));
      },
      undo: function () {
        if (!snap) return;
        applyTexts(snap.nodes, snap.texts);
      }
    };
  }

  /* ==================== DOM 适配层：序列化 + 重打包 ==================== */

  /* 保存：document.xml 走 XMLSerializer 整树序列化 → UTF-8（无 BOM）；
     其余条目一律用 load 时保存的原始字节回填；fflate.zipSync level 6 重打包。
     声明区保真：各实现的 XMLSerializer 对 XML 声明处理不一致 —— 有的不输出
     声明，有的保留声明却吞掉声明与根元素之间的空白（实测 Chrome 会丢 \r\n）。
     声明区（声明 + 其后空白）一律按原始字节回填，保证头部字节级一致。 */
  function serialize(doc) {
    if (!doc || !doc.docXml || !doc.entries) {
      throw new Error("serialize: doc 对象不完整（请先 QingDuEngine.load()）");
    }
    var S = useXMLSerializer();
    var xmlStr = new S().serializeToString(doc.docXml);

    var orig = doc.entries["word/document.xml"];
    if (orig) {
      var DECL = /^<\?xml[\s\S]*?\?>[ \t\r\n]*/;
      var origStr = new TextDecoder("utf-8").decode(orig);
      var om = origStr.match(DECL);
      if (om) {
        var nm = DECL.exec(xmlStr);
        if (nm) {
          if (nm[0] !== om[0]) xmlStr = om[0] + xmlStr.slice(nm[0].length);
        } else if (xmlStr.indexOf("<?xml") !== 0) {
          xmlStr = om[0] + xmlStr;               // 序列化器不输出声明 → 整段补回
        }
      }
    }

    var newDocBytes = new TextEncoder().encode(xmlStr);   // UTF-8，无 BOM
    var out = {}, name;
    for (name in doc.entries) {
      if (!Object.prototype.hasOwnProperty.call(doc.entries, name)) continue;
      out[name] = (name === "word/document.xml") ? newDocBytes : doc.entries[name];
    }
    return useFflate().zipSync(out, { level: 6 });
  }

  /* ==================== 导出 ==================== */
  return {
    init: init,
    load: load,
    serialize: serialize,
    paragraphs: paragraphs,
    getParaText: getParaText,
    setText: setText,
    runs: runs,
    createCommandStack: createCommandStack,
    planSetText: planSetText,
    planSplit: planSplit,
    planDeleteChar: planDeleteChar,
    SetTextCmd: SetTextCmd,
    SetBoldCmd: SetBoldCmd,
    SetItalicCmd: SetItalicCmd,
    SetFontSizeCmd: SetFontSizeCmd,
    SetColorCmd: SetColorCmd,
    SplitParagraphCmd: SplitParagraphCmd,
    DeleteCharCmd: DeleteCharCmd
  };
})();

if (typeof window !== "undefined") window.QingDuEngine = QingDuEngine;
if (typeof module !== "undefined" && typeof module.exports !== "undefined") module.exports = QingDuEngine;
