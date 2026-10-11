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
  dropzone: document.getElementById('dropzone'),
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
  recentMenu: document.getElementById('recent-menu')
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
function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = false;
  els.dropzone.hidden = false;
  els.viewer.hidden = true;
  setGroups(false);
}
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
function fitWidth() {
  var sec = els.viewer.querySelector('section.docx');
  if (!sec) return;
  var base = sec.offsetWidth / zoom;
  var avail = els.stage.clientWidth - 56;
  if (base > 0) setZoom(avail / base);
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
function openBytes(bytes, name) {
  clearError();
  hideRecents();
  state.name = name;
  els.filename.textContent = '正在打开 ' + name + ' …';
  try {
    state.buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    renderCurrent();
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
  els.dropzone.hidden = true;
  els.viewer.hidden = false;
  setGroups(true);
  fixHeaderWatermarks();
  paginateAll();
  setZoom(1);
  updatePageInd();
  if (lastQuery) doSearch(lastQuery);
}

/* ============ 渲染后增强：水印页眉转背景 + 长表智能分页 ============ */
function fixHeaderWatermarks() {
  document.querySelectorAll('#viewer section.docx').forEach(function (sec) {
    sec.querySelectorAll(':scope > header').forEach(function (h) {
      var big = h.querySelector('img');
      if (!big || (big.offsetWidth || 0) < 200) return;   // 小页眉保持原样
      h.style.position = 'absolute';
      h.style.top = '0'; h.style.left = '0'; h.style.right = '0';
      h.style.zIndex = '0'; h.style.pointerEvents = 'none';
      big.style.display = 'block';
      big.style.margin = '0 auto';                        // 水印水平居中
    });
    var art = sec.querySelector(':scope > article');
    if (!art) return;
    var pageH = sec.clientHeight || 1123;
    var topMargin = Math.round(pageH / 1123 * 96);        // 上边距约 1 英寸
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
  while (section.scrollHeight > section.clientHeight + 2 && guard++ < 30) {
    var art = section.querySelector(':scope > article');
    if (!art) break;
    var pageH = section.clientHeight;
    var bottom = pageH - Math.round(pageH / 1123 * 96);   // 底边距约 1 英寸
    var kids = [].slice.call(art.children);
    var cutEl = null, cutRow = -1, cutIdx = -1;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.offsetTop + el.offsetHeight <= bottom) continue;
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
      var thead = cutEl.querySelector('thead');
      if (thead) contTable.appendChild(thead.cloneNode(true));
      rowsAll.slice(cutRow).forEach(function (r3) { contTable.appendChild(r3); });
      contArt.appendChild(contTable);
    }
    carry.slice(cutIdx + 1).forEach(function (c) { contArt.appendChild(c); });
    // 原页截断：从切点开始清理（已挪去续页的元素不在 art 里，自动跳过）
    var keepCut = cutRow >= 0;                            // 表格切分行：原表本体保留
    [].slice.call(art.children).slice(cutIdx + (keepCut ? 1 : 0)).forEach(function (s2) {
      if (s2.parentNode === art) art.removeChild(s2);
    });
    section.parentNode.insertBefore(cont, section.nextSibling);
    section = cont;
  }
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
els.dropzone.addEventListener('click', function () { els.btnOpen.click(); });
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
els.zoomIn.addEventListener('click', function () { setZoom(zoom + 0.1); });
els.zoomOut.addEventListener('click', function () { setZoom(zoom - 0.1); });
els.zoomFit.addEventListener('click', fitWidth);
els.btnRecents.addEventListener('click', function (e) {
  e.stopPropagation();
  if (els.recentMenu.classList.contains('on')) hideRecents(); else showRecents();
});
document.addEventListener('click', function (e) {
  if (!els.recentMenu.contains(e.target) && e.target !== els.btnRecents) hideRecents();
});
els.viewer.addEventListener('wheel', function (e) {
  if (e.ctrlKey) { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1)); }
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
    e.preventDefault(); setZoom(zoom + 0.1);
  } else if (e.ctrlKey && e.key === '-') {
    e.preventDefault(); setZoom(zoom - 0.1);
  } else if (e.ctrlKey && e.key === '0') {
    e.preventDefault(); setZoom(1);
  }
});

/* ================= Tauri 启动事件：双击 .docx 关联打开 ================= */
if (IS_TAURI) {
  window.__TAURI__.event.listen('open-file', function (e) {
    if (e.payload) openByPath(e.payload);
  });
}
