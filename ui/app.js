"use strict";

/* ================= 运行环境判定与文件 IO 收口 =================
   浏览器模式：File System Access API（句柄存 IndexedDB）
   Tauri 模式：Rust 命令（任意路径直读，最近文件存路径）
================================================================ */
var IS_TAURI = typeof window.__TAURI__ !== "undefined";
var tauriInvoke = IS_TAURI ? window.__TAURI__.core.invoke : null;

function fileIOReadByPath(path) {
  return tauriInvoke("read_file_by_path", { path: path }).then(function (bytes) {
    return new Uint8Array(bytes);
  });
}
function fileIOWriteWithBackup(path, bytes) {
  return tauriInvoke("write_file_with_backup", { path: path, data: Array.from(bytes) });
}

var els = {
  stage: document.getElementById('stage'),
  home: document.getElementById('home'),
  homeRecentList: document.getElementById('home-recent-list'),
  homeVer: document.getElementById('home-ver'),
  btnOpenHero: document.getElementById('btn-open-hero'),
  viewer: document.getElementById('viewer'),
  error: document.getElementById('error'),
  filename: document.getElementById('filename'),
  btnOpen: document.getElementById('btn-open'),
  fileInput: document.getElementById('file-input'),
  searchBox: document.getElementById('search-box'),
  searchInput: document.getElementById('search-input'),
  hitCount: document.getElementById('hit-count'),
  hitPrev: document.getElementById('hit-prev'),
  hitNext: document.getElementById('hit-next'),
  pageBox: document.getElementById('page-box'),
  pagePrev: document.getElementById('page-prev'),
  pageNext: document.getElementById('page-next'),
  pageInd: document.getElementById('page-ind'),
  zoomBox: document.getElementById('zoom-box'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomFit: document.getElementById('zoom-fit'),
  zoomVal: document.getElementById('zoomval'),
  btnRecents: document.getElementById('btn-recents'),
  recentMenu: document.getElementById('recent-menu'),
  btnUpdate: document.getElementById('btn-update'),
  updatePanel: document.getElementById('update-panel'),
  upLog: document.getElementById('up-log')
};

var state = { name: null, buffer: null, path: null };
var zoom = 1;
var hits = [], hitIdx = -1, lastQuery = '';
var scrollPending = false;

/* ================= 最近文件 ================= */
function lsGetRecents() {
  try { return JSON.parse(localStorage.getItem('qdu-recents') || '[]'); }
  catch (e) { return []; }
}
function lsSaveRecents(list) {
  try { localStorage.setItem('qdu-recents', JSON.stringify(list.slice(0, 8))); } catch (e) {}
}
function saveRecentPath(path) {
  var list = lsGetRecents().filter(function (p) { return p !== path; });
  list.unshift(path);
  lsSaveRecents(list);
}

/* 浏览器模式：IndexedDB + 文件句柄 */
function idb() {
  return new Promise(function (resolve, reject) {
    var rq = indexedDB.open('qingdu', 1);
    rq.onupgradeneeded = function () {
      rq.result.createObjectStore('recents', { keyPath: 'name' });
    };
    rq.onsuccess = function () { resolve(rq.result); };
    rq.onerror = function () { reject(rq.error); };
  });
}
function saveRecentHandle(name, handle) {
  if (IS_TAURI) return Promise.resolve();
  return idb().then(function (db) {
    return new Promise(function (res) {
      var tx = db.transaction('recents', 'readwrite');
      tx.objectStore('recents').put({ name: name, handle: handle, at: Date.now() });
      tx.oncomplete = res;
    });
  }).catch(function () {});
}
function getIdbRecents() {
  return idb().then(function (db) {
    return new Promise(function (res) {
      var rq = db.transaction('recents').objectStore('recents').getAll();
      rq.onsuccess = function () {
        res((rq.result || []).sort(function (a, b) { return b.at - a.at; }).slice(0, 8));
      };
      rq.onerror = function () { res([]); };
    });
  }).catch(function () { return []; });
}
function delIdbRecent(name) {
  return idb().then(function (db) {
    var tx = db.transaction('recents', 'readwrite');
    tx.objectStore('recents').delete(name);
  }).catch(function () {});
}

function renderRecentMenuWeb(list) {
  els.recentMenu.innerHTML = '';
  if (!list.length) {
    var empty = document.createElement('div');
    empty.className = 'rm-empty';
    empty.textContent = '暂无最近打开的文档';
    els.recentMenu.appendChild(empty);
    return;
  }
  list.forEach(function (item) {
    var row = document.createElement('div');
    row.className = 'rm-item';
    var nm = document.createElement('span');
    nm.className = 'rm-name';
    nm.textContent = item.name;
    nm.title = item.handle ? '点击重新打开' : '此条目无文件句柄，请重新选择文件';
    var del = document.createElement('span');
    del.className = 'rm-del';
    del.textContent = '×';
    del.title = '从列表移除';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      delIdbRecent(item.name).then(showRecents);
    });
    row.appendChild(nm);
    row.appendChild(del);
    if (item.handle) {
      row.addEventListener('click', function () { openByHandle(item.handle); });
    }
    els.recentMenu.appendChild(row);
  });
}
function renderRecentMenuTauri(paths) {
  els.recentMenu.innerHTML = '';
  if (!paths.length) {
    var empty = document.createElement('div');
    empty.className = 'rm-empty';
    empty.textContent = '暂无最近打开的文档';
    els.recentMenu.appendChild(empty);
    return;
  }
  paths.forEach(function (p) {
    var row = document.createElement('div');
    row.className = 'rm-item';
    var nm = document.createElement('span');
    nm.className = 'rm-name';
    nm.textContent = p;
    nm.title = '点击重新打开';
    var del = document.createElement('span');
    del.className = 'rm-del';
    del.textContent = '×';
    del.title = '从列表移除';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      lsSaveRecents(lsGetRecents().filter(function (x) { return x !== p; }));
      showRecents();
    });
    row.appendChild(nm);
    row.appendChild(del);
    row.addEventListener('click', function () { openByPath(p); });
    els.recentMenu.appendChild(row);
  });
}
function showRecents() {
  if (IS_TAURI) {
    renderRecentMenuTauri(lsGetRecents());
  } else {
    getIdbRecents().then(renderRecentMenuWeb);
  }
  els.recentMenu.classList.add('on');
}
function hideRecents() { els.recentMenu.classList.remove('on'); }

function openByHandle(handle) {
  hideRecents();
  handle.queryPermission({ mode: 'read' }).then(function (perm) {
    if (perm === 'granted') return handle.getFile();
    return handle.requestPermission({ mode: 'read' }).then(function (p) {
      if (p !== 'granted') throw new Error('未获得文件读取授权');
      return handle.getFile();
    });
  }).then(function (file) {
    openFile(file);
  }).catch(function (e) {
    showError('无法重新打开「' + (handle.name || '文件') + '」：' + e.message);
  });
}
function openByPath(path) {
  hideRecents();
  els.filename.textContent = '正在打开 ' + path + ' …';
  fileIOReadByPath(path).then(function (bytes) {
    var name = path.split(/[\\/]/).pop();
    state.path = path;
    saveRecentPath(path);
    openBytes(bytes, name);
  }).catch(function (e) {
    els.filename.textContent = '';
    showError('无法打开「' + path + '」：\n' + e);
  });
}

/* ================= 打开与渲染 ================= */
/* ================= 视图切换与首页 ================= */
function showHome() {
  els.home.hidden = false;
  els.viewer.hidden = true;
  setGroups(false);
  fillHomeVersion();
  renderHomeRecents();
}
function hideHome() { els.home.hidden = true; }
function fillHomeVersion() {
  if (IS_TAURI) {
    // Tauri 2 的 getVersion() 返回 Promise —— 必须异步填充，同步拼接会得到 "[object Promise]"
    els.homeVer.textContent = '轻读';
    window.__TAURI__.app.getVersion().then(function (v) {
      els.homeVer.textContent = '轻读 v' + v;
    }).catch(function () {});
  } else {
    els.homeVer.textContent = '轻读 浏览器版';
  }
}
function renderHomeRecents() {
  var list = els.homeRecentList;
  list.innerHTML = '';
  function addRow(content, title, onOpen, onDel) {
    var row = document.createElement('div');
    row.className = 'hr-item';
    var ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '📄';
    var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = content; nm.title = title || content;
    row.appendChild(ic); row.appendChild(nm);
    if (onDel) {
      var del = document.createElement('span'); del.className = 'del'; del.textContent = '×';
      del.title = '从列表移除';
      del.addEventListener('click', function (e) { e.stopPropagation(); onDel(); });
      row.appendChild(del);
    }
    if (onOpen) row.addEventListener('click', onOpen);
    list.appendChild(row);
  }
  if (IS_TAURI) {
    var paths = lsGetRecents();
    if (!paths.length) { var e1 = document.createElement('div'); e1.className = 'hr-empty'; e1.textContent = '暂无记录'; list.appendChild(e1); return; }
    paths.forEach(function (p) {
      addRow(p.split(/[\\/]/).pop(), p, function () { openByPath(p); }, function () {
        lsSaveRecents(lsGetRecents().filter(function (x) { return x !== p; }));
        renderHomeRecents();
      });
    });
  } else {
    getIdbRecents().then(function (items) {
      if (!items.length) { var e2 = document.createElement('div'); e2.className = 'hr-empty'; e2.textContent = '暂无记录'; list.appendChild(e2); return; }
      items.forEach(function (item) {
        addRow(item.name, item.name, item.handle ? function () { openByHandle(item.handle); } : null,
               function () { delIdbRecent(item.name).then(renderHomeRecents); });
      });
    });
  }
}

function showError(msg) {
  els.error.textContent = msg;
  els.home.hidden = true;      // 错误态：盖掉首页，错误卡片独占舞台
  els.viewer.hidden = true;
  els.error.hidden = false;
  setGroups(false);
}
els.error.addEventListener('click', function () {
  els.error.hidden = true;
  showHome();
});
function clearError() { els.error.hidden = true; }
function setGroups(on) {
  [els.searchBox, els.pageBox, els.zoomBox].forEach(function (g) { g.classList.toggle('on', on); });
  els.searchInput.disabled = !on;
  els.hitPrev.disabled = !on;
  els.hitNext.disabled = !on;
  els.pagePrev.disabled = !on;
  els.pageNext.disabled = !on;
}

function applyZoom() {
  var wrapper = els.viewer.querySelector('.docx-wrapper');
  if (wrapper) {
    wrapper.style.zoom = zoom;
    els.zoomVal.textContent = Math.round(zoom * 100) + '%';
  }
}
function setZoom(z) {
  zoom = Math.min(2.5, Math.max(0.5, z));
  applyZoom();
  updatePageInd();
}
function setZoomUser(z) {
  state.userZoom = Math.min(2.5, Math.max(0.5, z));
  setZoom(state.userZoom);
}
function fitWidth() {
  var sec = els.viewer.querySelector('section.docx');
  if (!sec) return;
  var base = sec.offsetWidth / zoom;
  var avail = els.stage.clientWidth - 56;
  if (base > 0) setZoom(avail / base);
}
function fitWidthUser() {
  fitWidth();
  state.userZoom = zoom;
}

function getSections() {
  return Array.prototype.slice.call(els.viewer.querySelectorAll('section.docx'));
}
function updatePageInd() {
  var secs = getSections();
  if (!secs.length) { els.pageInd.textContent = '- / -'; return; }
  var stageTop = els.stage.getBoundingClientRect().top;
  var cur = 1;
  secs.forEach(function (s, i) {
    if (s.getBoundingClientRect().top - stageTop <= 90) cur = i + 1;
  });
  els.pageInd.textContent = cur + ' / ' + secs.length;
  state.page = cur; state.pages = secs.length;
}
els.stage.addEventListener('scroll', function () {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(function () { updatePageInd(); scrollPending = false; });
});
function gotoPage(delta) {
  var secs = getSections();
  var cur = state.page || 1;
  var target = secs[cur - 1 + delta];
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ================= 搜索 ================= */
function clearHits() {
  document.querySelectorAll('mark.qdu-hit').forEach(function (m) {
    var p = m.parentNode;
    if (!p) return;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  });
  hits = []; hitIdx = -1;
}
function updateHitBar() {
  els.hitCount.textContent = hits.length ? (hitIdx + 1) + '/' + hits.length : (lastQuery ? '0/0' : '');
}
function gotoHit(i) {
  if (!hits.length) { updateHitBar(); return; }
  if (hits[hitIdx]) hits[hitIdx].classList.remove('qdu-cur');
  hitIdx = ((i % hits.length) + hits.length) % hits.length;
  var m = hits[hitIdx];
  m.classList.add('qdu-cur');
  m.scrollIntoView({ behavior: 'smooth', block: 'center' });
  updateHitBar();
}
function doSearch(q) {
  clearHits();
  lastQuery = q;
  if (!q || !els.viewer.textContent) { updateHitBar(); return; }
  var walker = document.createTreeWalker(els.viewer, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (n.parentNode.closest && n.parentNode.closest('mark.qdu-hit')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var nodes = [], n;
  while ((n = walker.nextNode())) nodes.push(n);
  var ql = q.toLowerCase();
  nodes.forEach(function (node) {
    var text = node.nodeValue, lower = text.toLowerCase();
    if (lower.indexOf(ql) === -1) return;
    var frag = document.createDocumentFragment(), last = 0, idx = lower.indexOf(ql);
    while (idx !== -1) {
      frag.appendChild(document.createTextNode(text.slice(last, idx)));
      var mark = document.createElement('mark');
      mark.className = 'qdu-hit';
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      hits.push(mark);
      last = idx + q.length;
      idx = lower.indexOf(ql, last);
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
  if (hits.length) gotoHit(0); else updateHitBar();
}

/* ================= 打开文件 ================= */
async function openBytes(bytes, name) {
  clearError();
  hideRecents();
  state.name = name;
  els.filename.textContent = '正在打开 ' + name + ' …';
  try {
    state.buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    parseDocExtras();
    await renderCurrent();
  } catch (e) {
    state.name = null;
    els.filename.textContent = '';
    showError('无法打开「' + name + '」：\n' + (e && e.message ? e.message : '文件解析失败'));
  }
}
async function openFile(file) {
  clearError();
  hideRecents();
  if (!/\.docx$/i.test(file.name)) {
    showError('「' + file.name + '」不是 .docx 文件。\n目前只支持 .docx（.doc 老格式不在支持范围）。');
    return;
  }
  state.path = null;
  var bytes = new Uint8Array(await file.arrayBuffer());
  openBytes(bytes, file.name);
}

async function renderCurrent() {
  els.viewer.innerHTML = '';
  clearHits();
  await docx.renderAsync(state.buffer, els.viewer, undefined, {
    inWrapper: true,
    breakPages: true,
    experimental: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    ignoreLastRenderedPageBreak: true,
    useBase64URL: true
  });
  document.title = state.name + ' · 轻读';
  els.filename.textContent = state.name;
  hideHome();
  els.viewer.hidden = false;
  els.viewer.classList.remove('doc-in');
  void els.viewer.offsetWidth;
  els.viewer.classList.add('doc-in');
  setGroups(true);
  setZoom(1);
  enhanceWhenReady().then(function () {
    updatePageInd();
    if (lastQuery) doSearch(lastQuery);
  });
}

/* ============ 文档附加信息解析：页码字段 + 表格标题行 ============ */
function parseDocExtras() {
  state.fieldInfo = { header: [], footer: [] };
  state.tableHeaderRows = {};
  try {
    var zip = fflate.unzipSync(new Uint8Array(state.buffer));
    var dec = new TextDecoder();
    // 1) 页眉/页脚里的 PAGE / NUMPAGES 字段（按出现顺序，含缓存值）
    ['header', 'footer'].forEach(function (part) {
      Object.keys(zip).forEach(function (key) {
        if (key.indexOf('word/' + part) !== 0 || !/\.xml$/.test(key)) return;
        var doc = new DOMParser().parseFromString(dec.decode(zip[key]), 'application/xml');
        var fields = [];
        var type = null, collecting = false, buf = [];
        [].forEach.call(doc.getElementsByTagName('*'), function (el) {
          var tag = el.tagName;
          if (tag === 'w:instrText') {
            var t = el.textContent || '';
            if (t.indexOf('PAGE') >= 0 && t.indexOf('NUMPAGES') < 0) type = 'PAGE';
            else if (t.indexOf('NUMPAGES') >= 0) type = 'NUMPAGES';
          } else if (tag === 'w:fldChar') {
            var ft = el.getAttribute('w:fldCharType');
            if (ft === 'separate' && type) collecting = true;
            if (ft === 'end') {
              if (type) fields.push({ type: type, cached: buf.join('') });
              type = null; collecting = false; buf = [];
            }
          } else if (collecting && tag === 'w:t') {
            buf.push(el.textContent || '');
          }
        });
        state.fieldInfo[part] = state.fieldInfo[part].concat(fields);
      });
    });
    // 2) 每个顶层表格的"标题行"数量（w:tblHeader，Word 跨页重复表头；供未来真分页使用）
    var doc = new DOMParser().parseFromString(dec.decode(zip['word/document.xml']), 'application/xml');
    var body = doc.getElementsByTagName('w:body')[0];
    var tblOrd = -1;
    [].forEach.call(body.children, function (child) {
      if (child.tagName === 'w:tbl') {
        tblOrd++;
        var hdr = [].filter.call(child.getElementsByTagName('w:tr'), function (tr) {
          return tr.getElementsByTagName('w:tblHeader').length > 0;
        }).length;
        if (hdr) state.tableHeaderRows[tblOrd] = hdr;
      }
    });
  } catch (e) { /* 解析失败不影响阅读 */ }
}

/* ============ 页码字段实算：仅在多节（真实分页）文档启用； ============
   单节连续视图下页脚保留 Word 缓存值（实算反而会把"共3页"误写成"共1页"） */
function fixPageFields() {
  if (!state.fieldInfo) return;
  var secs = Array.prototype.slice.call(els.viewer.querySelectorAll('section.docx'));
  if (secs.length < 2) return;
  var N = secs.length;
  secs.forEach(function (sec, i) {
    ['header', 'footer'].forEach(function (part) {
      var fields = state.fieldInfo[part] || [];
      if (!fields.length) return;
      sec.querySelectorAll(':scope > ' + part).forEach(function (pf) {
        var walker = document.createTreeWalker(pf, NodeFilter.SHOW_TEXT, null);
        var tn, fi = 0;
        while ((tn = walker.nextNode()) && fi < fields.length) {
          var f = fields[fi];
          if (f.cached && tn.nodeValue && tn.nodeValue.trim() === f.cached.trim()) {
            tn.nodeValue = (f.type === 'PAGE') ? String(i + 1) : String(N);
            fi++;
          }
        }
      });
    });
  });
}

/* ============ 渲染后增强：等图片全部就绪后执行（水印/分页/浮动图/适宽） ============ */
function enhanceWhenReady() {
  return new Promise(function (resolve) {
    var imgs = [].slice.call(els.viewer.querySelectorAll('img'));
    var pending = imgs.filter(function (im) { return !im.complete; });
    if (!pending.length) { enhanceNow(); return resolve(); }
    var left = pending.length, fired = false, tid = null;
    function one() {
      if (fired) return;
      left--;
      if (left > 0) return;
      fired = true;
      clearTimeout(tid);
      enhanceNow();
      resolve();
    }
    tid = setTimeout(function () { fired = true; enhanceNow(); resolve(); }, 4000);  // 兜底：个别图片 4 秒内没响应也继续
    pending.forEach(function (im) {
      im.addEventListener('load', one);
      im.addEventListener('error', one);
    });
  });
}

function enhanceNow() {
  fixHeaderWatermarks();
  fixVmlTextboxes();
  paginateAll();
  renderFloatingAnchors();
  fixPageFields();
  // 默认缩放策略（对齐主流阅读器：预览型阅读器默认适合宽度）：
  // 用户本次会话手动调过缩放 → 尊重其选择；否则自动适合宽度
  if (state.userZoom) setZoom(state.userZoom);
  else autoFitIfNeeded();
}

function autoFitIfNeeded() {
  var sec = els.viewer.querySelector('section.docx');
  if (sec && sec.offsetWidth > els.stage.clientWidth - 16) fitWidth();
}
window.addEventListener('resize', function () {
  clearTimeout(window._qduRz);
  window._qduRz = setTimeout(autoFitIfNeeded, 200);
});

function fixHeaderWatermarks() {
  document.querySelectorAll('#viewer section.docx').forEach(function (sec) {
    // 层级修正：正文必须在页眉水印/页脚之上（docx 默认样式给了 z-index 却没给定位，等于没生效）
    var artAll = sec.querySelector(':scope > article');
    if (artAll) { artAll.style.position = 'relative'; artAll.style.zIndex = '1'; }
    sec.querySelectorAll(':scope > header').forEach(function (h) {
      var big = h.querySelector('img');
      // 用 naturalWidth 判断（不依赖图片是否已完成布局），≥300px 视为水印/大图页眉
      if (!big || Math.max(big.naturalWidth || 0, big.offsetWidth || 0) < 300) return;
      h.style.position = 'absolute';
      h.style.top = '0'; h.style.left = '0'; h.style.right = '0';
      h.style.zIndex = '0'; h.style.pointerEvents = 'none';
      big.style.display = 'block';
      big.style.margin = '0 auto';                        // 水印水平居中
      big.style.maxWidth = 'none';
    });
    var art = sec.querySelector(':scope > article');
    if (!art) return;
    // 上边距恒为 1 英寸=96px（连续长页模式下 clientHeight 是全内容高度，
    // 绝不能按比例推算——否则文档越长顶部空白越大，正文被推出首屏）
    var topMargin = 96;
    if (art.offsetTop < topMargin) art.style.marginTop = (topMargin - art.offsetTop) + 'px';
  });
}

function rowsCoverBoundary(rows, k) {
  // 是否有跨行合并单元格跨越 k-1|k 行边界（有则不能在此处切表）
  for (var i = 0; i < rows.length && i < k; i++) {
    var cells = rows[i].cells;
    for (var j = 0; j < cells.length; j++) {
      var rs = parseInt(cells[j].getAttribute('rowspan') || '1', 10);
      if (i < k && i + rs - 1 >= k) return true;
    }
  }
  return false;
}

function paginateAll() {
  var wrapper = els.viewer.querySelector('.docx-wrapper');
  if (!wrapper) return;
  [].slice.call(wrapper.querySelectorAll(':scope > section.docx')).forEach(paginateSection);
}

function paginateSection(section) {
  var guard = 0;
  while (guard++ < 60) {
    var art = section.querySelector(':scope > article');
    if (!art) break;
    // 目标页高：docx-preview 写入的 min-height（A4 ≈ 1122.53px）。
    // 内容一旦超过“页高 - 底边距”，就在安全位置切分到下一页（保持纸张 A4 比例）。
    var csSec = getComputedStyle(section);
    var pageH = parseFloat(csSec.minHeight) || section.clientHeight || 1123;
    var padBottom = parseFloat(csSec.paddingBottom) || 0;
    var bottom = pageH - padBottom - 2;
    var kids = [].slice.call(art.children);
    var cutEl = null, cutRow = -1, cutIdx = -1;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      // 元素底界要包含自身的下外边距（否则段落 spacing after 会被漏算，页高超出 A4）
      var mb = parseFloat(getComputedStyle(el).marginBottom) || 0;
      var elBottom = el.offsetTop + el.offsetHeight + mb;
      if (el.offsetTop >= bottom) { cutEl = el; cutRow = -1; cutIdx = i; break; }   // 完全在页外
      if (elBottom <= bottom) continue;
      if (el.tagName === 'TABLE') {
        var rows = [].slice.call(el.rows);
        var best = -1;
        for (var r2 = rows.length - 2; r2 >= 0; r2--) {
          var rb = rows[r2].offsetTop + rows[r2].offsetHeight;
          if (rb <= bottom && !rowsCoverBoundary(rows, r2 + 1)) { best = r2; break; }
        }
        if (best >= 0) { cutEl = el; cutRow = best + 1; cutIdx = i; break; }
      }
      cutEl = el; cutRow = -1; cutIdx = i; break;         // 段落整块挪到下一页
    }
    if (!cutEl) break;
    // 构造续页：克隆整节（含页眉页脚与样式），只留续行与后续内容
    var cont = section.cloneNode(true);
    var contArt = cont.querySelector(':scope > article');
    contArt.innerHTML = '';
    var carry = [].slice.call(art.children);
    if (cutRow >= 0) {
      var rowsAll = [].slice.call(cutEl.rows);
      var contTable = cutEl.cloneNode(false);             // 表格属性与样式
      var cg = cutEl.querySelector('colgroup');
      if (cg) contTable.appendChild(cg.cloneNode(true));
      // 续页顶部重复“标题行”（Word 的 tblHeader 语义）
      var tblOrd = kids.slice(0, cutIdx + 1).filter(function (k) { return k.tagName === 'TABLE'; }).length - 1;
      var hdrCount = Math.min((state.tableHeaderRows || {})[tblOrd] || 0, cutRow);
      rowsAll.slice(0, hdrCount).forEach(function (hr) { contTable.appendChild(hr.cloneNode(true)); });
      var thead = cutEl.querySelector('thead');
      if (thead) contTable.appendChild(thead.cloneNode(true));
      rowsAll.slice(cutRow).forEach(function (r3) { contTable.appendChild(r3); });
      contArt.appendChild(contTable);
    } else {
      contArt.appendChild(cutEl);                         // 段落整块挪到下一页
    }
    carry.slice(cutIdx + 1).forEach(function (c) { contArt.appendChild(c); });
    // 原页截断：按移动前的快照清理（cutEl 若已挪走则跳过；表格切分行保留）
    var keepCut = cutRow >= 0;                            // 表格切分行：原表本体保留
    carry.slice(cutIdx + (keepCut ? 1 : 0)).forEach(function (s2) {
      if (s2.parentNode === art) art.removeChild(s2);
    });
    section.parentNode.insertBefore(cont, section.nextSibling);
    section = cont;
  }
}

/* ============ VML 文本框修复：foreignObject 被错误嵌套在 rect 内导致文字不可见 ============ */
function fixVmlTextboxes() {
  document.querySelectorAll('#viewer svg').forEach(function (svg) {
    var fo = svg.querySelector('foreignObject');
    var rect = svg.querySelector('rect');
    if (fo && rect && fo.parentElement === rect) svg.appendChild(fo);   // 移出 rect → 文字层盖在底色上
  });
}

/* ============ 浮动锚定图片补渲染（docx-preview 不支持 wp:anchor） ============ */
function bytesToB64(bytes) {
  var bin = '', CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return btoa(bin);
}

function renderFloatingAnchors() {
  if (!state.buffer) return;
  try {
    var zip = fflate.unzipSync(new Uint8Array(state.buffer));
    var dec = new TextDecoder();
    var docXml = dec.decode(zip['word/document.xml']);
    var relsXml = zip['word/_rels/document.xml.rels'] ? dec.decode(zip['word/_rels/document.xml.rels']) : '';
    var relMap = {};
    var mR = /Id="([^"]+)"[^>]*Target="([^"]+)"/g, m;
    while ((m = mR.exec(relsXml))) relMap[m[1]] = m[2].replace(/^\//, '');
    function mediaUrl(rid) {
      var t = relMap[rid];
      if (!t) return null;
      var key = t.indexOf('/') === 0 ? t.slice(1) : (t.indexOf('media/') === 0 ? 'word/' + t : 'word/' + t);
      var bytes = zip[key];
      if (!bytes) return null;
      var mime = /\.png$/i.test(key) ? 'image/png' : (/\.gif$/i.test(key) ? 'image/gif' : 'image/jpeg');
      return 'data:' + mime + ';base64,' + bytesToB64(bytes);
    }
    var doc = new DOMParser().parseFromString(docXml, 'application/xml');
    var body = doc.getElementsByTagName('w:body')[0];
    if (!body) return;
    // body 直接子元素序号 ↔ 渲染层各节 article 子元素的拼接顺序一一对应（已实测验证）
    var allArtKids = [];
    els.viewer.querySelectorAll(':scope > section.docx').forEach(function (s) {
      var a = s.querySelector(':scope > article');
      if (a) [].forEach.call(a.children, function (c) { allArtKids.push(c); });
    });
    var bodyKids = [].filter.call(body.children, function (c) { return c.tagName !== 'w:sectPr'; });
    bodyKids.forEach(function (child, idx) {
      var anchors = child.getElementsByTagName ? child.getElementsByTagName('wp:anchor') : [];
      if (!anchors.length) return;
      var refEl = allArtKids[idx];
      if (!refEl) return;
      var sec = refEl.closest('section.docx');
      if (!sec) return;
      [].forEach.call(anchors, function (an) {
        var blip = an.getElementsByTagName('a:blip')[0];
        if (!blip) return;
        var rid = blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
        var url = mediaUrl(rid);
        if (!url) return;
        var ext = an.getElementsByTagName('wp:extent')[0];
        var cx = ext ? parseInt(ext.getAttribute('cx') || '0', 10) : 0;
        var cy = ext ? parseInt(ext.getAttribute('cy') || '0', 10) : 0;
        var wpx = Math.round(cx / 9525), hpx = Math.round(cy / 9525);
        var ph = an.getElementsByTagName('wp:positionH')[0];
        var pv = an.getElementsByTagName('wp:positionV')[0];
        var hOff = ph ? parseInt((ph.textContent || '0'), 10) / 9525 : 0;
        var vOff = pv ? parseInt((pv.textContent || '0'), 10) / 9525 : 0;
        var hRel = ph ? ph.getAttribute('relativeFrom') : 'column';
        var vRel = pv ? pv.getAttribute('relativeFrom') : 'paragraph';
        var left = (hRel === 'page') ? hOff : (refEl.offsetLeft || 0) + hOff;
        var top = (vRel === 'page' || vRel === 'margin') ? vOff : (refEl.offsetTop + vOff);
        var behind = an.getAttribute('behindDoc') === '1';
        var img = document.createElement('img');
        img.src = url;
        img.style.position = 'absolute';
        img.style.left = Math.round(left) + 'px';
        img.style.top = Math.round(top) + 'px';
        img.style.width = wpx + 'px';
        img.style.height = hpx + 'px';
        img.style.zIndex = behind ? '0' : '2';
        img.style.pointerEvents = 'none';
        img.alt = '浮动图片';
        sec.appendChild(img);
      });
    });
  } catch (e) { /* 增强失败不影响基础阅读 */ }
}

/* ================= 事件绑定 ================= */
els.btnOpen.addEventListener('click', function () {
  hideRecents();
  if (IS_TAURI) {
    els.fileInput.click();
  } else if (window.showOpenFilePicker) {
    window.showOpenFilePicker({
      types: [{ description: 'Word 文档', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }],
      multiple: false
    }).then(function (handles) {
      var handle = handles[0];
      saveRecentHandle(handle.name, handle);
      return handle.getFile();
    }).then(openFile).catch(function () {});
  } else {
    els.fileInput.click();
  }
});
els.btnOpenHero.addEventListener('click', function () { els.btnOpen.click(); });
els.fileInput.addEventListener('change', function () {
  var f = els.fileInput.files && els.fileInput.files[0];
  if (f) openFile(f);
  els.fileInput.value = '';
});

var dragDepth = 0;
window.addEventListener('dragenter', function (e) {
  e.preventDefault();
  dragDepth++;
  els.stage.classList.add('dragging');
});
window.addEventListener('dragleave', function (e) {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.stage.classList.remove('dragging');
});
window.addEventListener('dragover', function (e) { e.preventDefault(); });
window.addEventListener('drop', function (e) {
  e.preventDefault();
  dragDepth = 0;
  els.stage.classList.remove('dragging');
  var dt = e.dataTransfer;
  var f = dt && dt.files && dt.files[0];
  if (!f) return;
  if (!IS_TAURI && dt.items) {
    for (var i = 0; i < dt.items.length; i++) {
      if (dt.items[i].getAsFileSystemHandle) {
        (function (idx) {
          dt.items[idx].getAsFileSystemHandle().then(function (h) {
            if (h && state.name === f.name) saveRecentHandle(f.name, h);
          }).catch(function () {});
        })(i);
      }
    }
  }
  openFile(f);
});

els.searchInput.addEventListener('input', function () {
  var q = els.searchInput.value.trim();
  clearTimeout(els.searchInput._t);
  els.searchInput._t = setTimeout(function () { doSearch(q); }, 250);
});
els.searchInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); gotoHit(hitIdx + (e.shiftKey ? -1 : 1)); }
  if (e.key === 'Escape') { els.searchInput.value = ''; doSearch(''); els.searchInput.blur(); }
});
els.hitPrev.addEventListener('click', function () { gotoHit(hitIdx - 1); });
els.hitNext.addEventListener('click', function () { gotoHit(hitIdx + 1); });
els.pagePrev.addEventListener('click', function () { gotoPage(-1); });
els.pageNext.addEventListener('click', function () { gotoPage(1); });
els.zoomIn.addEventListener('click', function () { setZoomUser(zoom + 0.1); });
els.zoomOut.addEventListener('click', function () { setZoomUser(zoom - 0.1); });
els.zoomFit.addEventListener('click', fitWidthUser);
els.btnRecents.addEventListener('click', function (e) {
  e.stopPropagation();
  if (els.recentMenu.classList.contains('on')) hideRecents(); else showRecents();
});
document.addEventListener('click', function (e) {
  if (!els.recentMenu.contains(e.target) && e.target !== els.btnRecents) hideRecents();
});
els.viewer.addEventListener('wheel', function (e) {
  if (e.ctrlKey) { e.preventDefault(); setZoomUser(zoom + (e.deltaY < 0 ? 0.1 : -0.1)); }
}, { passive: false });
window.addEventListener('keydown', function (e) {
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  } else if (e.key === 'F3') {
    e.preventDefault();
    gotoHit(hitIdx + (e.shiftKey ? -1 : 1));
  } else if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); setZoomUser(zoom + 0.1);
  } else if (e.ctrlKey && e.key === '-') {
    e.preventDefault(); setZoomUser(zoom - 0.1);
  } else if (e.ctrlKey && e.key === '0') {
    e.preventDefault(); state.userZoom = null; setZoom(1);
  }
});

/* ================= 应用内更新（含可视化日志面板） ================= */
function upLog(line, cls) {
  els.updatePanel.classList.add('on');
  var d = document.createElement('div');
  d.className = 'up-line' + (cls ? ' ' + cls : '');
  d.textContent = new Date().toLocaleTimeString() + '  ' + line;
  els.upLog.appendChild(d);
  els.upLog.scrollTop = els.upLog.scrollHeight;
}
els.btnUpdate.addEventListener('click', function () {
  if (!IS_TAURI) {
    showError('应用内更新仅桌面版可用。\n浏览器版请到仓库 Releases 页面下载新安装包。');
    return;
  }
  els.upLog.innerHTML = '';
  els.updatePanel.classList.add('on');
  els.btnUpdate.disabled = true;
  els.btnUpdate.textContent = '检查中…';
  function logCurrentThen(fn) {
    // getVersion() 是异步 API：先拿版本再继续，避免同步拼接出 "[object Promise]"
    if (IS_TAURI) {
      window.__TAURI__.app.getVersion().then(function (v) { upLog('当前版本 ' + v + '，正在连接更新服务器…'); fn(); })
        .catch(function () { upLog('正在连接更新服务器…'); fn(); });
    } else { upLog('正在连接更新服务器…'); fn(); }
  }
  logCurrentThen(function () {
    tauriInvoke('check_update', {}).then(function (info) {
    els.btnUpdate.disabled = false;
    els.btnUpdate.textContent = '检查更新';
    if (!info.has_update) {
      upLog('已经是最新版本，无需更新', 'ok');
      els.btnUpdate.textContent = '已是最新';
      setTimeout(function () { els.btnUpdate.textContent = '检查更新'; }, 2500);
      return;
    }
    upLog('发现新版本 ' + info.version + '，等待确认…', 'ok');
    if (window.confirm('发现新版本 ' + info.version + '，立即更新吗？\n\n下载完成后安装器将自动启动，当前软件会关闭。')) {
      upLog('已确认，开始下载更新…');
      els.btnUpdate.textContent = '下载中…';
      tauriInvoke('perform_update', {}).then(function () {
        upLog('安装器已启动，软件即将关闭', 'ok');
      }).catch(function (e) {
        els.btnUpdate.disabled = false;
        els.btnUpdate.textContent = '检查更新';
        upLog('更新失败：' + e, 'err');
      });
    } else {
      upLog('已取消本次更新');
    }
  }).catch(function (e) {
    els.btnUpdate.disabled = false;
    els.btnUpdate.textContent = '检查更新';
    upLog('检查更新失败：' + e, 'err');
  });
  });
});
if (!IS_TAURI) els.btnUpdate.style.display = 'none';

/* ================= Tauri 事件：更新进度实时上报 ================= */
if (IS_TAURI) {
  window.__TAURI__.event.listen('update-log', function (e) {
    var payload = e.payload || '';
    var i = payload.indexOf('|');
    upLog(i >= 0 ? payload.slice(i + 1) : payload);
  });
  window.__TAURI__.event.listen('open-file', function (e) {
    if (e.payload) openByPath(e.payload);
  });
}

/* ================= 启动：渲染首页 ================= */
showHome();


