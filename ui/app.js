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
  skeleton: document.getElementById('skeleton'),
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
  upLog: document.getElementById('up-log'),
  btnEdit: document.getElementById('btn-edit'),
  editBar: document.getElementById('edit-bar'),
  editTip: document.getElementById('edit-tip'),
  eBold: document.getElementById('e-bold'),
  eItalic: document.getElementById('e-italic'),
  eFontsize: document.getElementById('e-fontsize'),
  eColor: document.getElementById('e-color'),
  eUndo: document.getElementById('e-undo'),
  eRedo: document.getElementById('e-redo'),
  eSave: document.getElementById('e-save')
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
  state.openedAt = Date.now();
  els.filename.textContent = '正在打开 ' + name + ' …';
  els.home.hidden = true;
  els.skeleton.classList.add('on');
  try {
    state.buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    parseDocExtras();
    await renderCurrent();
  } catch (e) {
    els.skeleton.classList.remove('on');
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
  els.skeleton.classList.remove('on');
  if (state.openedAt) {
    els.filename.textContent = state.name + '（打开耗时 ' + ((Date.now() - state.openedAt) / 1000).toFixed(1) + ' 秒）';
    state.openedAt = 0;
    clearTimeout(window._qduFnT);
    window._qduFnT = setTimeout(function () { els.filename.textContent = state.name; }, 2600);
  } else {
    els.filename.textContent = state.name;
  }
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
    // 3) 页面边距（页眉锚定水印的定位基准；twips→px ÷15，96dpi）
    state.pgMar = { header: 48, top: 96, left: 96, right: 96, bottom: 96 };
    var sectPr = doc.getElementsByTagName('w:sectPr')[0];
    if (sectPr) {
      var pm = sectPr.getElementsByTagName('w:pgMar')[0];
      if (pm) {
        var twPx = function (n, dft) {
          var v = parseInt(pm.getAttribute('w:' + n), 10);   // XML 属性带命名空间前缀
          return isFinite(v) && v > 0 ? v / 15 : dft;
        };
        state.pgMar.header = twPx('header', state.pgMar.header);
        state.pgMar.top = twPx('top', state.pgMar.top);
        state.pgMar.left = twPx('left', state.pgMar.left);
        state.pgMar.right = twPx('right', state.pgMar.right);
        state.pgMar.bottom = twPx('bottom', state.pgMar.bottom);
      }
    }
    // 4) 页眉锚定图片（水印/图章）几何：按 wp:anchor 语义记录，
    //    渲染后由 fixHeaderWatermarks 精确摆放（对齐 Word/WPS）
    state.headerAnchors = [];
    Object.keys(zip).forEach(function (key) {
      if (!/^word\/header\d+\.xml$/.test(key)) return;
      var hd = new DOMParser().parseFromString(dec.decode(zip[key]), 'application/xml');
      [].forEach.call(hd.getElementsByTagName('wp:anchor'), function (an) {
        var ext = an.getElementsByTagName('wp:extent')[0];
        if (!ext) return;
        var readPos = function (tag) {
          var p = an.getElementsByTagName(tag)[0];
          if (!p) return { rel: 'margin', off: 0, align: null };
          var offEl = p.getElementsByTagName('wp:posOffset')[0];
          var alEl = p.getElementsByTagName('wp:align')[0];
          return {
            rel: p.getAttribute('relativeFrom') || 'margin',
            off: offEl ? (parseInt(offEl.textContent, 10) || 0) / 9525 : 0,   // EMU→px
            align: alEl ? (alEl.textContent || '').trim() : null
          };
        };
        var sr = an.getElementsByTagName('a:srcRect')[0];
        // ST_Percentage（ECMA-376）：整数 = 千分之一百分点（100000=100%，18=0.018%）；
        // 兼容带 % 的字符串形式（"18%"=18%）
        var pct = function (n) {
          if (!sr) return 0;
          var raw = (sr.getAttribute(n) || '').trim();
          if (!raw) return 0;
          if (raw.charAt(raw.length - 1) === '%') return (parseFloat(raw) || 0) / 100;
          var v = parseFloat(raw);
          return isFinite(v) ? v / 100000 : 0;
        };
        state.headerAnchors.push({
          w: (parseInt(ext.getAttribute('cx'), 10) || 0) / 9525,
          h: (parseInt(ext.getAttribute('cy'), 10) || 0) / 9525,
          x: readPos('wp:positionH'),
          y: readPos('wp:positionV'),
          behind: an.getAttribute('behindDoc') === '1',
          crop: { l: pct('l'), t: pct('t'), r: pct('r'), b: pct('b') }
        });
      });
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
  var anchors = state.headerAnchors || [];
  var pgMar = state.pgMar || { header: 48, top: 96, left: 96, right: 96, bottom: 96 };
  document.querySelectorAll('#viewer section.docx').forEach(function (sec) {
    // 层级修正：正文必须在页眉水印/页脚之上（docx 默认样式给了 z-index 却没给定位，等于没生效）
    var artAll = sec.querySelector(':scope > article');
    if (artAll) { artAll.style.position = 'relative'; artAll.style.zIndex = '1'; }
    sec.querySelectorAll(':scope > header').forEach(function (h) {
      var bigs = [].filter.call(h.querySelectorAll('img'), function (im) {
        // 用 naturalWidth 判断（不依赖图片是否已完成布局），≥300px 视为水印/大图页眉
        return Math.max(im.naturalWidth || 0, im.offsetWidth || 0) >= 300;
      });
      if (!bigs.length) return;
      h.style.position = 'absolute';
      h.style.top = '0'; h.style.left = '0'; h.style.right = '0';
      h.style.zIndex = '0'; h.style.pointerEvents = 'none';
      var csSec = getComputedStyle(sec);
      var pageW = sec.clientWidth, pageH = sec.clientHeight;
      var mL = parseFloat(csSec.paddingLeft) || pgMar.left;
      var mR = parseFloat(csSec.paddingRight) || pgMar.right;
      var mT = parseFloat(csSec.paddingTop) || pgMar.top;
      var mB = parseFloat(csSec.paddingBottom) || pgMar.bottom;
      bigs.forEach(function (im) {
        // 渲染尺寸 ↔ 页眉锚点几何匹配（docx-preview 按 extent 出图，±2px 容差）
        var a = null, i;
        for (i = 0; i < anchors.length; i++) {
          if (Math.abs(anchors[i].w - im.offsetWidth) <= 2 &&
              Math.abs(anchors[i].h - im.offsetHeight) <= 2) { a = anchors[i]; break; }
        }
        if (!a) {
          // 无锚点信息（内联大图）：维持居中兜底
          im.style.display = 'block';
          im.style.margin = '0 auto';
          im.style.maxWidth = 'none';
          return;
        }
        // OOXML 锚点语义定位（对齐 Word/WPS）：
        // H：page=页左上原点；margin/column=页边距 + 偏移；align=center=相对基准居中
        var x;
        if (a.x.align === 'center') x = mL + (pageW - mL - mR - a.w) / 2;
        else if (a.x.rel === 'page') x = a.x.off;
        else x = mL + a.x.off;
        // V：paragraph=页眉锚段落顶（=页眉距）+ 偏移；margin=上边距 + 偏移
        var y;
        if (a.y.align === 'center') y = mT + (pageH - mT - mB - a.h) / 2;
        else if (a.y.rel === 'page') y = a.y.off;
        else if (a.y.rel === 'paragraph') y = pgMar.header + a.y.off;
        else y = mT + a.y.off;
        // 裁剪容器：extent 框 + overflow hidden（srcRect 裁掉边缘后拉伸填满框）
        var wrap = document.createElement('span');
        wrap.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none;';
        wrap.style.left = Math.round(x) + 'px';
        wrap.style.top = Math.round(y) + 'px';
        wrap.style.width = a.w + 'px';
        wrap.style.height = a.h + 'px';
        wrap.style.zIndex = a.behind ? '0' : '2';
        var visW = 1 - a.crop.l - a.crop.r, visH = 1 - a.crop.t - a.crop.b;
        if (visW > 0 && visH > 0 && (visW < 1 || visH < 1)) {
          im.style.width = (a.w / visW) + 'px';
          im.style.height = (a.h / visH) + 'px';
          im.style.marginLeft = -(a.w * a.crop.l / visW) + 'px';
          im.style.marginTop = -(a.h * a.crop.t / visH) + 'px';
        } else {
          im.style.width = a.w + 'px';
          im.style.height = a.h + 'px';
        }
        im.style.maxWidth = 'none';
        im.style.display = 'block';
        wrap.appendChild(im);
        h.appendChild(wrap);
      });
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
  // rAF 分批：每帧最多处理 6 个节，避免长文档分页时主线程长卡
  var secs = [].slice.call(wrapper.querySelectorAll(':scope > section.docx'));
  var i = 0;
  function batch() {
    var end = Math.min(i + 6, secs.length);
    for (; i < end; i++) paginateSection(secs[i]);
    if (i < secs.length) requestAnimationFrame(batch);
  }
  batch();
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
    // Tauri：系统原生文件对话框（tauri-plugin-dialog）→ 拿真实绝对路径
    // → openByPath：最近列表、原位保存（.bak）全部打通
    window.__TAURI__.dialog.open({
      multiple: false,
      filters: [{ name: 'Word 文档', extensions: ['docx'] }]
    }).then(function (p) {
      if (p) openByPath(p);
    }).catch(function () {});
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

/* 拖放打开：
   · Tauri：原生拖放事件（tauri://drag-*）带绝对路径 → openByPath（可入最近、可原位保存）
   · 浏览器：HTML5 拖放（File 对象，无路径 → 打开后走下载副本保存） */
var dragDepth = 0;
if (IS_TAURI) {
  window.__TAURI__.event.listen('tauri://drag-enter', function () {
    dragDepth = 1; els.stage.classList.add('dragging');
  });
  window.__TAURI__.event.listen('tauri://drag-leave', function () {
    dragDepth = 0; els.stage.classList.remove('dragging');
  });
  window.__TAURI__.event.listen('tauri://drag-drop', function (e) {
    dragDepth = 0; els.stage.classList.remove('dragging');
    var paths = (e.payload && e.payload.paths) || [];
    for (var i = 0; i < paths.length; i++) {
      if (/\.docx$/i.test(paths[i])) { openByPath(paths[i]); return; }
    }
  });
} else {
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
    if (dt.items) {
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
}

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

/* ================= Tauri 事件：更新进度 + 关联打开 ================= */
if (IS_TAURI) {
  window.__TAURI__.event.listen('update-log', function (e) {
    var payload = e.payload || '';
    var i = payload.indexOf('|');
    upLog(i >= 0 ? payload.slice(i + 1) : payload);
  });
  window.__TAURI__.event.listen('open-file', function (e) {
    if (e.payload) openByPath(e.payload);
  });
  /* 关联启动（双击 .docx / 右键打开方式 / QQ 转发）：
     拉模式 —— 前端就绪后主动取 Rust 侧暂存的路径，零竞态 */
  tauriInvoke('get_pending_doc', {}).then(function (p) {
    if (p) openByPath(p);
  }).catch(function () {});
}

/* ================= 编辑（v0.5.0：阅读编辑一体，单击即编） =================
   架构不变：XML 树（QingDuEngine）= 唯一事实源；渲染 DOM 只是投影。
   v0.5.0 去掉"先点编辑再双击"的两级门槛（对齐 WPS/Word 的使用直觉）：
     · 文档打开 + 引擎段落对齐检查通过 → 自动可编辑：每个段落是独立的
       contenteditable 块（Editor.js 式块编辑范式），单击即在光标处落点，
       中文输入法走浏览器原生路径；
     · 格式工具栏随文档常驻；"只读"按钮临时锁定纯阅读；
     · Enter = 分段（SplitParagraphCmd，光标落新段开头）；
       段首退格 = 并入上一段（MergeWithPrevCmd，光标落拼接处）；
     · 段落失焦时 DOM 文本差异作为 SetTextCmd 提交引擎；
       撤销/重做/格式命令 = 引擎改树 → serialize → 全量重绘 + 恢复滚动与光标；
     · 引擎解析失败或段落对不上 → 整份文档降级为纯阅读（阅读功能不受影响）。
   保存：serialize → Tauri 原位写回（自动 .bak）/ 浏览器版下载副本。 */
var edit = { active: false, locked: false, doc: null, stack: null, paras: [], domParas: [], activeIdx: -1, savedDepth: 0, sel: null, caret: null };

function editActive() { return edit.active && !edit.locked; }

/* 节点 → 所在可编辑段落（正文段落与表格内段落都认，按 domParas 索引） */
function editParaFromNode(node) {
  var el = node && node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== els.viewer) {
    if (el.tagName === 'P' && el.parentElement &&
        (el.parentElement.tagName === 'ARTICLE' || el.parentElement.tagName === 'TD' || el.parentElement.tagName === 'TH')) {
      var idx = edit.domParas.indexOf(el);
      if (idx >= 0) return { el: el, idx: idx };
    }
    el = el.parentElement;
  }
  return null;
}

/* 选区/光标在段落内的字符偏移（偏移系 = 段落内文本节点拼接序 = w:t 文档序） */
function editOffsetInPara(pEl, node, off) {
  var w = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT);
  var acc = 0, n;
  while ((n = w.nextNode())) {
    if (n === node) return acc + off;
    acc += n.nodeValue.length;
  }
  return acc;
}
function editCaretOffset(info) {
  var sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  var range = sel.getRangeAt(0);
  return editOffsetInPara(info.el, range.startContainer, range.startOffset);
}

/* 选区捕获：mouseup/keyup 后，若选区在同一渲染段落内，
   计算段落内文本偏移 → 存 edit.sel = { paraIdx, start, end }。 */
function editCaptureSelection() {
  edit.sel = null;
  if (!editActive()) return;
  var sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  var si = editParaFromNode(range.startContainer);
  var ei = editParaFromNode(range.endContainer);
  if (!si || !ei || si.el !== ei.el) return;   // 跨段/出界不管
  var s = editOffsetInPara(si.el, range.startContainer, range.startOffset);
  var e = editOffsetInPara(si.el, range.endContainer, range.endOffset);
  if (e < s) { var tmp = s; s = e; e = tmp; }
  if (e > s) edit.sel = { paraIdx: si.idx, start: s, end: e };
}

/* 提示条：短暂显示后自动收起 */
function editShowTip(msg) {
  els.editTip.textContent = msg;
  els.editTip.classList.add('on');
  clearTimeout(edit._tipT);
  edit._tipT = setTimeout(function () { els.editTip.classList.remove('on'); }, 3800);
}

/* 格式入口：有选区 → 选区命令（run 拆分）；无选区 → 焦点段落首文字块 */
function editApplyFormat(mkRangeCmd, mkParaCmd) {
  if (!editActive()) return;
  editSyncActive();
  try {
    if (edit.sel) {
      var p = edit.paras[edit.sel.paraIdx];
      if (!p) return;
      edit.stack.execute(mkRangeCmd(p, edit.sel.start, edit.sel.end));
    } else {
      var p2 = editCmdActivePara(); if (!p2) return;
      var r = editFirstRun(p2); if (!r) return;
      edit.stack.execute(mkParaCmd(r));
    }
    editAfterCommand();
  } catch (e2) {
    showError('格式化失败：' + e2.message);
  }
}

function editSyncActive() {
  // 兜底同步当前焦点段落（保存/撤销/格式命令前，防焦点机制失效的极端环境）
  var p = edit.domParas && edit.activeIdx >= 0 ? edit.domParas[edit.activeIdx] : null;
  if (p && p.getAttribute('contenteditable') === 'true') {
    editSyncPara(edit.activeIdx);
  }
}

function editIsDirty() {
  return !!(edit.stack && edit.stack.size() !== edit.savedDepth);
}

function editDomParas() {
  // 文档序拼接：正文段落 + 表格内段落（与 QingDuEngine.allParagraphs 的遍历序一致）
  return Array.prototype.slice.call(els.viewer.querySelectorAll('article > p, article table p'));
}
function editCheckAlignment() {
  edit.domParas = editDomParas();
  return edit.paras.length === edit.domParas.length;
}
function editRefreshButtons() {
  els.eUndo.disabled = !(edit.stack && edit.stack.canUndo);
  els.eRedo.disabled = !(edit.stack && edit.stack.canRedo);
  edit.dirty = editIsDirty();
  els.filename.classList.toggle('dirty', edit.dirty);   // ● 由 CSS ::before 呈现（呼吸脉冲）
}

/* ---------------- 激活 / 降级 / 只读锁 ---------------- */
function editReset() {
  edit.active = false; edit.locked = false;
  edit.doc = null; edit.stack = null; edit.paras = []; edit.domParas = [];
  edit.savedDepth = 0; edit.activeIdx = -1; edit.sel = null; edit.caret = null;
  document.body.classList.remove('editing');
  els.editBar.classList.remove('on');
  els.filename.classList.remove('dirty');
  els.btnEdit.textContent = '编辑';
}
function editDegrade(why) {
  editReset();
  els.btnEdit.textContent = '只读';
  els.btnEdit.title = '本文档为纯阅读模式';
  editShowTip('这份文档以纯阅读模式打开（' + why + '），阅读功能不受影响');
}
/* 文档打开成功后调用：能编则自动进入可编辑，不能编则降级纯阅读 */
function editActivate() {
  editReset();
  if (!state.buffer || !state.name) return;
  try {
    edit.doc = QingDuEngine.load(new Uint8Array(state.buffer));
  } catch (e) { editDegrade('引擎解析失败'); return; }
  edit.paras = QingDuEngine.allParagraphs(edit.doc);
  if (!editCheckAlignment()) {
    editDegrade('段落对齐失败，已阻止编辑以保护文件');
    return;
  }
  edit.stack = QingDuEngine.createCommandStack(edit.doc);
  edit.active = true; edit.locked = false;
  editApplyLock();
  editShowTip('单击段落即可编辑 · Enter 分段 · Ctrl+S 保存');
  editRefreshButtons();
}
/* 应用只读锁状态到 DOM 与界面 */
function editApplyLock() {
  var on = editActive();
  document.body.classList.toggle('editing', on);
  els.editBar.classList.toggle('on', on);
  els.btnEdit.textContent = on ? '只读' : '编辑';
  els.btnEdit.title = on ? '锁定为纯阅读' : (edit.active ? '解锁编辑' : '本文档为纯阅读模式');
  edit.domParas.forEach(function (p) {
    p.setAttribute('contenteditable', on ? 'true' : 'false');
  });
}

function editSyncPara(i) {
  var p = edit.domParas[i];
  if (!p) return;
  var domText = (p.textContent || '');
  var treeText = QingDuEngine.getParaText(edit.paras[i]);
  if (domText !== treeText) {
    try {
      edit.stack.execute(QingDuEngine.SetTextCmd(edit.paras[i], treeText, domText));
      editRefreshButtons();
    } catch (e) {
      // 指纹不符（罕见）：以引擎树为准还原 DOM
      p.textContent = treeText;
    }
  }
}

/* 引擎命令后统一走这里：树已改 → 更新 buffer → 全量重绘（保持滚动与光标） */
function editAfterCommand(caret) {
  edit.sel = null;                                     // DOM 重绘，选区偏移失效
  var bytes = QingDuEngine.serialize(edit.doc);
  state.buffer = bytes.buffer;
  var scrollY = els.stage.scrollTop;
  edit.caret = caret || null;
  renderCurrent().then(function () {
    els.stage.scrollTop = scrollY;
    if (!edit.active) return;
    edit.paras = QingDuEngine.allParagraphs(edit.doc);  // 分段/合并会改变段落集合
    if (!editCheckAlignment()) { editDegrade('重绘后段落对齐失败'); return; }
    editApplyLock();
    editRefreshButtons();
    if (edit.caret) editRestoreCaret(edit.caret.idx, edit.caret.offset);
  });
}

/* 重绘后按 { idx, offset } 恢复光标（找不到对应文本节点则落到段尾） */
function editRestoreCaret(idx, offset) {
  var p = edit.domParas[idx];
  if (!p) return;
  edit.activeIdx = idx;
  p.focus();
  var sel = window.getSelection();
  var range = document.createRange();
  var w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  var acc = 0, n;
  while ((n = w.nextNode())) {
    if (acc + n.nodeValue.length >= offset) {
      range.setStart(n, Math.max(0, offset - acc));
      range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
      return;
    }
    acc += n.nodeValue.length;
  }
  range.selectNodeContents(p);
  range.collapse(false);
  sel.removeAllRanges(); sel.addRange(range);
}

/* Enter：先同步本段 DOM 差异，再在光标处分段；光标落新段开头 */
function editHandleEnter(info) {
  var off = editCaretOffset(info);
  if (off === null) return;
  editSyncPara(info.idx);
  try {
    edit.stack.execute(QingDuEngine.SplitParagraphCmd(edit.paras[info.idx], off));
  } catch (e) { showError('分段失败：' + e.message); return; }
  editAfterCommand({ idx: info.idx + 1, offset: 0 });
}

/* 段首退格：并入文档序上一段（须为真正的元素兄弟相邻）；光标落拼接处 */
function editHandleMerge(info) {
  if (info.idx === 0) return;
  var cur = edit.paras[info.idx], prev = edit.paras[info.idx - 1];
  if (!cur || !prev || cur.previousElementSibling !== prev) return;   // 跨单元格/表格边界不合并
  editSyncPara(info.idx);
  var caretOff = QingDuEngine.getParaText(prev).length;
  try {
    edit.stack.execute(QingDuEngine.MergeWithPrevCmd(cur));
  } catch (e) { showError('合并失败：' + e.message); return; }
  editAfterCommand({ idx: info.idx - 1, offset: caretOff });
}

function editCmdActivePara() {
  if (edit.activeIdx < 0 || !edit.paras[edit.activeIdx]) {
    showError('请先单击进入一个段落，再使用格式按钮。');
    return null;
  }
  return edit.paras[edit.activeIdx];
}
function editFirstRun(p) {
  var runs = QingDuEngine.runs(p);
  for (var i = 0; i < runs.length; i++) {
    var ts = runs[i].getElementsByTagName('w:t');
    if (ts.length && (ts[0].textContent || '').length) return runs[i];
  }
  return runs[0] || null;
}
/* ---------------- 事件接线（全部委托在 viewer 上，重绘后无需重挂） ---------------- */
els.btnEdit.addEventListener('click', function () {
  if (!edit.active) { showError('这份文档以纯阅读模式打开（结构特殊，暂不支持安全编辑）。'); return; }
  if (edit.locked) { edit.locked = false; }
  else { editSyncActive(); edit.locked = true; }      // 锁定前把活动段同步进引擎
  editApplyLock();
});
els.viewer.addEventListener('focusin', function (e) {
  var info = editParaFromNode(e.target);
  if (info) edit.activeIdx = info.idx;
});
/* focusout 冒泡（blur 不冒泡）：段落失焦即同步引擎 */
els.viewer.addEventListener('focusout', function (e) {
  var info = editParaFromNode(e.target);
  if (info) editSyncPara(info.idx);
});
/* Enter 分段 / 段首退格合并（输入法合成中不拦截，交给原生行为） */
els.viewer.addEventListener('keydown', function (e) {
  if (!editActive()) return;
  var info = editParaFromNode(e.target);
  if (!info) return;
  var ime = e.isComposing || e.keyCode === 229;
  if (e.key === 'Enter' && !ime) {
    e.preventDefault();
    editHandleEnter(info);
  } else if (e.key === 'Backspace' && !ime) {
    var sel = window.getSelection();
    if (sel && sel.isCollapsed && editCaretOffset(info) === 0) {
      e.preventDefault();
      editHandleMerge(info);
    }
  }
});
['e-bold', 'e-italic', 'e-fontsize', 'e-color'].forEach(function (id) {
  document.getElementById(id).addEventListener('mousedown', function (e) {
    e.preventDefault();                       // 阻止按钮抢焦点 → 选区保留
  });
});
els.viewer.addEventListener('mouseup', function () { setTimeout(editCaptureSelection, 0); });
els.viewer.addEventListener('keyup', function () { setTimeout(editCaptureSelection, 0); });
els.eBold.addEventListener('click', function () {
  editApplyFormat(function (p, a, b) { return QingDuEngine.FormatBoldRangeCmd(p, a, b); },
                  function (r) { return QingDuEngine.SetBoldCmd(r, true); });
});
els.eItalic.addEventListener('click', function () {
  editApplyFormat(function (p, a, b) { return QingDuEngine.FormatItalicRangeCmd(p, a, b); },
                  function (r) { return QingDuEngine.SetItalicCmd(r, true); });
});
els.eFontsize.addEventListener('change', function () {
  var v = els.eFontsize.value;
  els.eFontsize.value = '';
  if (!v) return;
  editApplyFormat(function (p, a, b) { return QingDuEngine.FormatSizeRangeCmd(p, a, b, v); },
                  function (r) { return QingDuEngine.SetFontSizeCmd(r, v); });
});
els.eColor.addEventListener('change', function () {
  var v = els.eColor.value;
  if (!v || v === '#000000') return;
  editApplyFormat(function (p, a, b) { return QingDuEngine.FormatColorRangeCmd(p, a, b, v); },
                  function (r) { return QingDuEngine.SetColorCmd(r, v); });
});
els.eUndo.addEventListener('click', function () { editSyncActive(); if (edit.stack && edit.stack.undo()) editAfterCommand(); });
els.eRedo.addEventListener('click', function () { editSyncActive(); if (edit.stack && edit.stack.redo()) editAfterCommand(); });

function editSave() {
  if (!edit.active) return;
  editSyncActive();                                    // 兜底：确保活动段已入引擎
  if (!editIsDirty()) { showError('没有需要保存的修改。'); return; }
  var bytes = new Uint8Array(QingDuEngine.serialize(edit.doc));
  var done = function () {
    edit.savedDepth = edit.stack.size();
    editRefreshButtons();
  };
  if (IS_TAURI && state.path) {
    els.eSave.disabled = true;
    fileIOWriteWithBackup(state.path, bytes).then(function () {
      els.eSave.disabled = false;
      done();
      els.filename.classList.remove('dirty');
      els.filename.textContent = state.name;
      els.eSave.textContent = '✓ 已保存';
      els.eSave.classList.add('saved');
      setTimeout(function () { els.eSave.textContent = '保存'; els.eSave.classList.remove('saved'); }, 1500);
      upLogSafe('已保存到 ' + state.path + '（原文档已备份为 .bak）');
    }).catch(function (e) {
      els.eSave.disabled = false;
      showError('保存失败：' + e);
    });
  } else {
    // 浏览器版 / 无路径：下载编辑副本（不动原文件）
    var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.name.replace(/\.docx$/i, '') + '-已编辑.docx';
    a.click();
    URL.revokeObjectURL(a.href);
    done();
  }
}
els.eSave.addEventListener('click', editSave);
function upLogSafe(msg) {
  if (typeof upLog === 'function') upLog(msg, 'ok');
  else console.log(msg);
}

/* 编辑快捷键（并入全局 keydown 链；段落内编辑时 Ctrl+Z 走浏览器原生撤销） */
window.addEventListener('keydown', function (e) {
  if (!edit.active) return;
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); editSave(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    if (!editActive()) return;
    editSyncActive();
    e.preventDefault();
    var ae = document.activeElement;
    if (!(ae && ae.getAttribute('contenteditable') === 'true') && edit.stack && edit.stack.undo()) editAfterCommand();
  }
  else if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) {
    if (!editActive()) return;
    e.preventDefault();
    editSyncActive();
    var ae2 = document.activeElement;
    if (!(ae2 && ae2.getAttribute('contenteditable') === 'true') && edit.stack && edit.stack.redo()) editAfterCommand();
  }
});

/* 打开新文档：有未保存修改先确认；渲染完成后自动进入可编辑（editActivate） */
(function () {
  var origOpenBytes = openBytes;
  openBytes = function (bytes, name) {
    if (edit.active && editIsDirty() &&
        !window.confirm('当前文档有未保存的修改，打开新文档将丢失，继续吗？')) {
      return Promise.resolve();
    }
    editReset();
    return origOpenBytes(bytes, name).then(function () {
      editActivate();          // 渲染完成（DOM 段落已就位）后自动接管编辑
    });
  };
})();

/* ================= 启动：渲染首页 ================= */
showHome();


