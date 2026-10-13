// dsh-agents-skills · 独立页的少量交互层（无框架 / 无构建 / 无依赖）
//
// 只做一件事：把「整页导航」换成「fetch + 局部替换」（pjax），顺手保住两处状态：
//   - 滚动：POST 之后回到原来的位置。技能页真正的滚动条在 .table-scroll 里，不是 window，
//     所以两级都记录（window.scrollY + 几个滚动容器）。
//   - 折叠：<details class="fold"> 按 <summary> 文本重开；服务端渲染仍是唯一事实源。
//
// 硬边界：不改协议、不改 HTML 结构（只认 class 钩子）、不做动态求值 / 动态建函数 / 动态加载模块 /
// 不碰浏览器本地存储；任何一步对不上就静默退出，让浏览器走原生导航（纯 SSR + 表单是兜底）。
(function () {
  'use strict'

  var PAGE_PATH = '/dsh-agents-skills'
  var SCROLLERS = ['.table-scroll', '.search-scroll', '.repostrip']
  var bypass = false

  // 自己的路径：<script src="<pagePath>?asset=page-ui.js" defer> 里剥掉查询串。
  try {
    if (document.currentScript && document.currentScript.src) {
      PAGE_PATH = new URL(document.currentScript.src, location.href).pathname
    }
  } catch (error) { /* 拿不到 src 就用默认路径 */ }

  function isPage(href) {
    try {
      var url = new URL(href, location.href)
      return url.origin === location.origin && url.pathname === PAGE_PATH
    } catch (error) { return false }
  }

  function each(selector, visit) {
    var nodes = []
    try { nodes = document.querySelectorAll(selector) } catch (error) { return }
    for (var i = 0; i < nodes.length; i++) visit(nodes[i], i)
  }

  function openFolds() {
    var open = []
    each('details.fold', function (fold) {
      var summary = fold.querySelector('summary')
      if (summary && fold.open) open.push(summary.textContent.trim())
    })
    return open
  }

  function scrollState() {
    var state = { y: window.scrollY || 0, inner: [] }
    for (var i = 0; i < SCROLLERS.length; i++) {
      var box = document.querySelector(SCROLLERS[i])
      state.inner.push(box ? [box.scrollTop, box.scrollLeft] : null)
    }
    return state
  }

  function apply(html, scroll, keep) {
    var doc = new DOMParser().parseFromString(html, 'text/html')
    if (!doc || !doc.body) return false
    var open = openFolds()
    document.title = doc.title
    document.body.innerHTML = doc.body.innerHTML
    each('details.fold', function (fold) {
      var summary = fold.querySelector('summary')
      if (summary) fold.open = open.indexOf(summary.textContent.trim()) !== -1
    })
    if (!keep) { window.scrollTo(0, 0); return true }
    window.scrollTo(0, scroll.y)
    for (var i = 0; i < SCROLLERS.length; i++) {
      var box = document.querySelector(SCROLLERS[i])
      if (box && scroll.inner[i]) { box.scrollTop = scroll.inner[i][0]; box.scrollLeft = scroll.inner[i][1] }
    }
    return true
  }

  /** fetch → 解析 → 局部替换 → pushState 到最终 URL（跟随 303）；popstate 分支不 push。 */
  function load(url, keep, init, push) {
    var scroll = keep ? scrollState() : null
    var options = init || {}
    if (!options.credentials) options.credentials = 'same-origin'
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
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      var node = event.target
      var anchor = node && typeof node.closest === 'function' ? node.closest('a[href]') : null
      if (anchor === null) return
      var href = anchor.getAttribute('href')
      if (!href || href.charAt(0) === '#' || anchor.hasAttribute('download')) return
      if (anchor.target && anchor.target !== '_self') return
      if (!isPage(href)) return
      event.preventDefault()
      load(new URL(href, location.href).href, false).catch(function () { location.href = href })
    } catch (error) { /* 交给浏览器原生导航 */ }
  }

  /** 表单体按 application/x-www-form-urlencoded 拼（服务端 parseForm 只认这种）。 */
  function formBody(form, submitter) {
    var params = new URLSearchParams()
    new FormData(form).forEach(function (value, key) {
      params.append(key, typeof value === 'string' ? value : value.name)
    })
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
        hidden.type = 'hidden'
        hidden.name = submitter.name
        hidden.value = submitter.value
        form.appendChild(hidden)
      }
      form.submit()
    } catch (error) { bypass = false; form.submit() }
  }

  function onSubmit(event) {
    try {
      if (bypass || event.defaultPrevented) return
      var form = event.target
      if (!form || typeof form.getAttribute !== 'function') return
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
  window.addEventListener('popstate', function () {
    // 前进/后退：URL 已经变到当前条目了，只换内容，不再 push（否则会截断前进栈）。
    load(location.href, false, null, false).catch(function () { location.reload() })
  })
})()
