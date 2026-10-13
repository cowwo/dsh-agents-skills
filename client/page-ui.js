// dsh-agents-skills · 独立页的少量交互层（无框架 / 无构建 / 无依赖）
//
// 纯渐进增强：JS 关掉后服务端 GET/POST 兜底照旧。
//   1) pjax：站内 GET 链接与 POST 表单改成 fetch + 局部替换 <body>；POST 后保滚动；群组卡按
//      data-fold 键恢复折叠态（卡头文本含会变的计数，不能用），其余 details 用固定 summary 文本。
//   2) 实时筛选：data-live-filter 按行 data-name 小写子串过滤，空组隐藏，与服务端 state chip 叠加。
//   3) 批量条：data-rowpick 实时计数到 data-pick-count；data-checkall 全选 / 半选（indeterminate）。
// 硬边界：不改协议 / HTML 结构（只认 data-* 与 class 钩子）、无动态求值 / 建函数 / 加载模块、不碰本地存储；对不上就静默退出走原生导航。
(function () {
  'use strict'

  var PAGE_PATH = '/dsh-agents-skills'
  var SCROLLERS = ['.table-scroll', '.search-scroll', '.repostrip']
  var BATCH_HINT = '勾选行后可批量操作'
  var bypass = false

  try {
    if (document.currentScript && document.currentScript.src) {
      PAGE_PATH = new URL(document.currentScript.src, location.href).pathname
    }
  } catch (error) { /* 拿不到 src 就用默认路径 */ }

  function each(selector, visit, scope) {
    var nodes = []
    try { nodes = (scope || document).querySelectorAll(selector) } catch (error) { return }
    nodes.forEach(visit)
  }

  /** 折叠态键：群组卡 = data-fold（稳定）；搜索 / 说明区没有 data-fold，用恒定 summary 文本。 */
  function foldKey(fold) {
    var key = fold.getAttribute('data-fold')
    if (key) return 'k:' + key
    var summary = fold.querySelector('summary')
    return summary ? 's:' + summary.textContent.trim() : null
  }

  /** 实时筛选：只叠加名字维（状态维已由服务端 chip 渲染），语义与服务端一致（小写子串）。 */
  function applyFilter() {
    var input = document.querySelector('[data-live-filter]')
    if (!input) return
    var value = String(input.value || '').trim()
    var needle = value.toLowerCase(), shown = 0
    each('details.fold[data-fold]', function (fold) {
      var hit = 0
      each('tr[data-name]', function (row) {
        var name = String(row.getAttribute('data-name') || '').toLowerCase()
        var match = needle.length === 0 || name.indexOf(needle) !== -1
        row.style.display = match ? '' : 'none'
        if (match) hit++
      }, fold)
      fold.style.display = needle.length > 0 && hit === 0 ? 'none' : ''
      shown += hit
    })
    var empty = document.querySelector('.skills-form ~ .empty') || document.querySelector('.empty') // 空态：有现成 .empty 就复用，没有就跳过
    if (empty) empty.style.display = needle.length === 0 || shown === 0 ? '' : 'none'
    syncLinks(value)
  }

  /** chip 与「选中全部待办」都是 GET 链接：同步 filter 参数，两个筛选才能叠加。 */
  function syncLinks(value) {
    each('a.chip[href], #batchbar .acts.push a[href]', function (link) {
      try {
        var url = new URL(link.getAttribute('href'), location.href)
        if (value.length > 0) url.searchParams.set('filter', value)
        else url.searchParams.delete('filter')
        link.setAttribute('href', url.pathname + url.search + url.hash)
      } catch (error) { /* 保留服务端 href */ }
    })
  }

  /** 批量条：计数位 + 每组表头全选框的全选 / 半选。勾选框是表单控件，无 JS 也能提交。 */
  function syncBatch() {
    var count = document.querySelectorAll('input[data-rowpick]:checked').length
    var label = document.querySelector('[data-pick-count]')
    if (label) label.textContent = count > 0 ? '已选 ' + count + ' 行' : BATCH_HINT
    each('input[data-checkall]', function (master) {
      var scope = master.closest('table') || document
      var total = scope.querySelectorAll('input[data-rowpick]').length, checked = scope.querySelectorAll('input[data-rowpick]:checked').length
      master.checked = total > 0 && checked === total
      master.indeterminate = checked > 0 && checked < total
    })
  }

  function apply(html, scroll, keep) {
    var doc = new DOMParser().parseFromString(html, 'text/html')
    if (!doc || !doc.body) return false
    var open = []
    each('details.fold', function (fold) { if (fold.open) { var key = foldKey(fold); if (key) open.push(key) } })
    document.title = doc.title
    document.body.innerHTML = doc.body.innerHTML
    each('details.fold', function (fold) {
      var key = foldKey(fold)
      if (key) fold.open = open.indexOf(key) !== -1
    })
    syncBatch(); applyFilter()
    if (!keep) { window.scrollTo(0, 0); return true }
    window.scrollTo(0, scroll.y)
    SCROLLERS.forEach(function (selector, i) {
      var box = document.querySelector(selector)
      if (box && scroll.inner[i]) { box.scrollTop = scroll.inner[i][0]; box.scrollLeft = scroll.inner[i][1] }
    })
    return true
  }

  /** fetch → 解析 → 局部替换 → pushState 到最终 URL（跟随 303）；popstate 分支不 push。 */
  function load(url, keep, init, push) {
    var scroll = keep ? { y: window.scrollY || 0, inner: SCROLLERS.map(function (selector) {
      var box = document.querySelector(selector)
      return box ? [box.scrollTop, box.scrollLeft] : null
    }) } : null
    var options = init || {}
    if (!options.credentials) options.credentials = 'same-origin' // 同源 cookie 鉴权
    return fetch(url, options).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.text().then(function (html) { return { html: html, url: response.url || url } })
    }).then(function (result) {
      if (!apply(result.html, scroll, keep)) throw new Error('parse failed')
      if (push !== false) history.pushState(null, '', result.url)
    })
  }

  function onClick(event) {
    try {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      var anchor = event.target && typeof event.target.closest === 'function' ? event.target.closest('a[href]') : null
      if (anchor === null) return
      var href = anchor.getAttribute('href')
      if (!href || href.charAt(0) === '#' || anchor.hasAttribute('download')) return
      if (anchor.target && anchor.target !== '_self') return
      var url = new URL(href, location.href)
      if (url.origin !== location.origin || url.pathname !== PAGE_PATH) return
      event.preventDefault()
      load(url.href, false).catch(function () { location.href = href })
    } catch (error) { /* 交给浏览器原生导航 */ }
  }

  /** input / change 走事件委托：pjax 换掉 <body> 后不用重新绑定，apply() 里重算即可。 */
  function onInputChange(event) {
    var node = event.target
    if (!node || typeof node.closest !== 'function') return
    if (event.type === 'input') { if (node.closest('[data-live-filter]')) applyFilter(); return }
    if (node.closest('input[data-checkall]')) {
      each('input[data-rowpick]', function (pick) { pick.checked = node.checked }, node.closest('table') || document)
    } else if (!node.closest('input[data-rowpick]')) return
    syncBatch()
  }

  /** 表单体按 application/x-www-form-urlencoded 拼（服务端 parseForm 只认这种）。 */
  function formBody(form, submitter) {
    var params = new URLSearchParams()
    new FormData(form).forEach(function (value, key) { params.append(key, typeof value === 'string' ? value : value.name) })
    if (submitter && submitter.name) params.append(submitter.name, submitter.value)
    return params
  }

  function nativeSubmit(form, submitter) {
    bypass = true
    try {
      if (submitter && typeof form.requestSubmit === 'function') { form.requestSubmit(submitter); return }
      // 老浏览器没有 requestSubmit：手动补上按钮的 name/value，form.submit() 不会带它。
      if (submitter && submitter.name) {
        var hidden = document.createElement('input')
        hidden.type = 'hidden'; hidden.name = submitter.name; hidden.value = submitter.value
        form.appendChild(hidden)
      }
      form.submit()
    } catch (error) { bypass = false; form.submit() }
  }

  function onSubmit(event) {
    try {
      var form = event.target
      if (bypass || event.defaultPrevented || !form || typeof form.getAttribute !== 'function') return
      if (String(form.getAttribute('method') || '').toLowerCase() !== 'post') return
      var action = form.getAttribute('action')
      var target = action && action.length > 0 ? new URL(action, location.href) : new URL(location.href)
      if (target.origin !== location.origin || target.pathname !== PAGE_PATH) return
      var submitter = event.submitter || form.querySelector('button[type="submit"], input[type="submit"]')
      var body = formBody(form, submitter)
      event.preventDefault()
      if (submitter && submitter.classList) { submitter.classList.add('busy'); submitter.disabled = true }
      load(target.href, true, { method: 'POST', body: body }).catch(function () {
        if (submitter && submitter.classList) { submitter.classList.remove('busy'); submitter.disabled = false }
        nativeSubmit(form, submitter)
      })
    } catch (error) { /* 交给浏览器原生提交 */ }
  }

  document.addEventListener('click', onClick)
  document.addEventListener('submit', onSubmit)
  document.addEventListener('input', onInputChange)
  document.addEventListener('change', onInputChange)
  window.addEventListener('popstate', function () {
    // 前进/后退：URL 已经变到当前条目了，只换内容，不再 push（否则会截断前进栈）。
    load(location.href, false, null, false).catch(function () { location.reload() })
  })
  syncBatch(); applyFilter()
})()
