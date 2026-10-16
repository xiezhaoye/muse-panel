// 注入到每个账号的 muse.ai 页面（document start，仅主框架）。
// 1. 把右上角「邀请」按钮改成账号头像：不新增 DOM，只用样式改原按钮的外观、拦截点击，
//    这样外观和位置跟页面完全一致，也不干扰 React 的节点管理。
// 2. 隐藏「下载 Muse 应用」一类横幅；暂停循环播放的头像视频（省电）。
// 规则来自 rules.json，由原生代码在加载时填进下面的 R。
(() => {
  if (window.__musePanel) return
  window.__musePanel = true
  const R = __RULES__
  const post = (m) => { try { window.webkit.messageHandlers.panel.postMessage(m) } catch (_) {} }
  const re = (list) => list.map((p) => new RegExp(p, 'i'))
  const invitePatterns = re(R.invite.textPatterns)
  const hidePatterns = re(R.hide.textPatterns)
  const textOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.trim()

  // 脚本在页面刚开始加载时（document start）运行：替换样式直接按按钮的固定标识写，
  // 首字和颜色也先写进 :root。按钮一渲染出来就是圆形头像，不会先闪一下「邀请」。
  // [data-muse-invite] 是选择器失效时、靠文字找到的按钮的标记。
  const sel = (suffix) => [...R.invite.selectors, '[data-muse-invite]'].map((s) => s + suffix).join(', ')
  const style = document.createElement('style')
  style.textContent = `
    ${sel('')} { width: 36px !important; height: 36px !important; min-width: 0 !important;
      padding: 0 !important; border-radius: 50% !important; background: var(--muse-badge, #5856D6) !important;
      color: #fff !important; font-size: 16px !important; font-weight: 600 !important; line-height: 36px !important; }
    ${sel(' > *')} { display: none !important; }
    ${sel('::after')} { content: var(--muse-initial, ""); }
    ${R.composerLayer ? `${R.composerLayer} { padding-bottom: max(env(safe-area-inset-bottom), 26px) !important; }` : ''}
    [data-muse-hidden] { display: none !important; }
    ${R.hide.selectors.map((s) => `${s} { display: none !important; }`).join('\n')}`
  document.documentElement.appendChild(style)

  // 右上角圆形头像：账号名首字 + 账号列表里的底色，由原生代码提供
  // 变量写在自己的 <style> 里，不写 <html> 的 style 属性（页面框架可能会覆盖它）
  const vars = document.createElement('style')
  document.documentElement.appendChild(vars)
  const paint = (b) => {
    vars.textContent = `:root { --muse-initial: ${JSON.stringify(String(b.text))}; --muse-badge: ${b.color}; }`
  }
  paint(window.__musePanelBadge || { text: '?', color: '#5856D6' })
  window.__musePanelSetBadge = paint

  // 拦截被替换按钮上的手势：按下类事件只阻止冒泡（页面菜单可能在 pointerdown 时打开），click 时弹出账号列表
  const ownSel = sel('')
  const owned = (e) => e.target instanceof Element && e.target.closest(ownSel)
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend']) {
    document.addEventListener(type, (e) => { if (owned(e)) e.stopPropagation() }, true)
  }
  document.addEventListener('click', (e) => {
    if (!owned(e)) return
    e.preventDefault()
    e.stopPropagation()
    post({ type: 'switcher' })
  }, true)

  function findInvite() {
    for (const s of R.invite.selectors) {
      const el = document.querySelector(s)
      if (el) return el
    }
    const half = window.innerWidth / 2
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (!invitePatterns.some((p) => p.test(textOf(el)))) continue
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.top < R.invite.maxTop && r.left > half) return el
    }
    return null
  }

  let invite = null
  let reported = null
  let session = null
  // 登录状态：出现登录后的页面框架就是已登录；12 秒还没有框架就是未登录（与按钮的判定一致）
  function reportSession(loggedIn) {
    if (loggedIn === session) return
    session = loggedIn
    post({ type: 'session', loggedIn })
  }
  const started = Date.now()
  // 找不到按钮时什么情况才报告「没有」（原生代码据此显示兜底按钮）：
  // 已出现登录后的页面框架 → 按钮迟早会渲染（VM 唤醒可能很慢），等满 30 秒才算；
  // 没有框架 → 可能真是登录页，也可能是 muse.ai 确认登录状态时先显示的登录页（约 8 秒），等满 12 秒才算。
  function report(ok) {
    if (!ok) {
      const elapsed = Date.now() - started
      const shell = R.appShell && document.querySelector(R.appShell)
      if (shell ? elapsed < 30000 : document.readyState !== 'complete' || elapsed < 12000) return
    }
    if (!ok && !(R.appShell && document.querySelector(R.appShell))) reportSession(false)
    if (ok === reported) return
    reported = ok
    post({ type: 'button', ok })
  }

  function sync() {
    if (!invite || !invite.isConnected) {
      invite = findInvite()
      if (invite) invite.setAttribute('aria-label', '切换账号')
      if (invite && !R.invite.selectors.some((s) => invite.matches(s))) invite.setAttribute('data-muse-invite', '')
    }
    if (R.appShell && document.querySelector(R.appShell)) reportSession(true)
    report(!!invite && invite.getBoundingClientRect().width > 0)

    if (hidePatterns.length) {
      for (const el of document.querySelectorAll('a:not([data-muse-hidden]), button:not([data-muse-hidden])')) {
        if (hidePatterns.some((p) => p.test(textOf(el)))) el.setAttribute('data-muse-hidden', '')
      }
    }
    if (R.pauseLoopingVideos) {
      for (const v of document.querySelectorAll('video[loop]')) {
        if (!v.paused) v.pause()
        v.autoplay = false
      }
    }
  }

  // 页面流式输出时变动很频繁：观察器回调只置标记，最多每 300ms 真正检查一次
  let timer = null
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; sync() }, 300) }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
  setTimeout(sync, 0)
  setTimeout(sync, 12100)
  setTimeout(sync, 30100)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) document.querySelectorAll('video').forEach((v) => v.pause())
  })
  // 收起键盘后 iOS 不会把页面滚回原位，顶栏会被推到状态栏下面：失焦后归位
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = document.activeElement
      if (!a || !/^(INPUT|TEXTAREA)$/.test(a.tagName) && !a.isContentEditable) window.scrollTo(0, 0)
    }, 60)
  })

  // 调试：把页面右上角附近的元素结构交给原生代码写进文件（rules.debugDump 打开时）
  if (R.debugDump) {
    setTimeout(() => {
      const rows = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || (r.top > 220 || r.right < window.innerWidth * 0.55) && r.bottom < window.innerHeight - 160) continue
        if (el.closest('svg') && el.tagName !== 'svg') continue
        const attrs = [...el.attributes].map((a) => `${a.name}="${a.value.slice(0, 80)}"`).join(' ')
        rows.push(`${el.tagName} [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}] ${attrs} | ${(el.textContent || '').trim().slice(0, 40)}`)
      }
      post({ type: 'dump', text: `${location.href}\nvw=${window.innerWidth}\n${rows.join('\n')}` })
    }, 8000)
  }
  window.__musePanelPauseMedia = () => document.querySelectorAll('video, audio').forEach((m) => m.pause())
})()
