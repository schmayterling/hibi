import assert from 'node:assert/strict'

export async function checkTooltips(page) {
  const target = page.getByRole('button', {
    name: /tooltip target/i,
    includeHidden: true,
  })
  const other = page.getByRole('button', { name: /open built-in prompt/i })
  const tip = page.getByRole('tooltip')
  const hidden = () => tip.waitFor({ state: 'hidden' })
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
  const hover = async () => {
    await other.hover()
    await target.hover()
    await tip.waitFor()
  }

  // Pointer focus and restored programmatic focus must not reopen dismissed help.
  await hover()
  const style = await tip.evaluate((node) => {
    const css = getComputedStyle(node)
    return {
      height: node.getBoundingClientRect().height,
      padding: css.padding,
      background: css.backgroundColor,
      arrow: getComputedStyle(node, '::before').width,
    }
  })
  assert.ok(style.height <= 26, JSON.stringify(style))
  assert.equal(style.padding, '4px 8px')
  assert.equal(style.background, 'rgb(17, 17, 17)')
  assert.equal(style.arrow, '6px')
  if (process.env.HIBI_TOOLTIP_SCREENSHOT)
    await page.screenshot({ path: process.env.HIBI_TOOLTIP_SCREENSHOT })
  await target.click()
  await hidden()
  await page.waitForTimeout(450)
  assert.equal(await tip.count(), 0)
  await other.focus()
  await target.focus()
  await page.waitForTimeout(450)
  assert.equal(await tip.count(), 0)

  await other.focus()
  await page.keyboard.press('Tab')
  await target.focus()
  await tip.waitFor()
  await other.hover()
  await hidden()

  // A mounted anchor may disappear, move, or change its help without pointerout.
  for (const change of [
    'hidden',
    'inert',
    'display',
    'visibility',
    'move',
    'text',
  ]) {
    await hover()
    await target.evaluate((node, change) => {
      if (change === 'hidden' || change === 'inert') node[change] = true
      if (change === 'display') node.style.display = 'none'
      if (change === 'visibility') node.style.visibility = 'hidden'
      if (change === 'move') node.style.transform = 'translateY(30px)'
      if (change === 'text') node.dataset.tooltip = 'updated help'
    }, change)
    await hidden()
    await other.hover()
    await target.evaluate((node) => {
      node.hidden = false
      node.inert = false
      node.removeAttribute('style')
      node.dataset.tooltip = 'shared help'
    })
  }
  await target.hover()
  await target.evaluate((node) => {
    node.hidden = true
  })
  await page.waitForTimeout(450)
  assert.equal(await tip.count(), 0)
  await page.evaluate(() => {
    const anchor = document.querySelector('[data-tooltip="shared help"]')
    window.dialogTest.tips.api.show({ anchor, text: 'hidden' })
    window.dialogTest.tips.api.show({
      anchor: document.createElement('button'),
      text: 'detached',
    })
    anchor.hidden = false
  })
  assert.equal(await tip.count(), 0)

  // Unrelated mutations share one geometry check per frame; nearby changes still dismiss help.
  await target.evaluate((node) => {
    const read = node.getBoundingClientRect
    window.anchorReads = 0
    node.getBoundingClientRect = function () {
      window.anchorReads++
      return read.call(this)
    }
    const unrelated = document.createElement('div')
    unrelated.id = 'tooltip-unrelated'
    document.body.append(unrelated)
    const spacer = document.createElement('div')
    spacer.id = 'tooltip-spacer'
    node.before(spacer)
  })
  const burst = () =>
    page.evaluate(async () => {
      const unrelated = document.querySelector('#tooltip-unrelated')
      const reads = window.anchorReads
      for (let index = 0; index < 200; index++) {
        unrelated.dataset.tick = String(index)
        unrelated.append(document.createElement('span'))
        unrelated.firstChild.remove()
        await Promise.resolve()
      }
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      )
      return window.anchorReads - reads
    })
  await hover()
  // One check reads the anchor twice: its bounds and its visibility.
  const reads = await burst()
  assert.ok(reads <= 2, `${reads} anchor reads`)
  assert.equal(await tip.count(), 1)
  for (const change of [
    'parent',
    'ancestor',
    'sibling style',
    'sibling child',
  ]) {
    await hover()
    await target.evaluate((node, change) => {
      const spacer = document.querySelector('#tooltip-spacer')
      if (change === 'parent') node.parentElement.hidden = true
      if (change === 'ancestor')
        node.parentElement.parentElement.style.visibility = 'hidden'
      if (change === 'sibling style') spacer.style.height = '40px'
      if (change === 'sibling child')
        spacer.append(document.createElement('div'), 'shifted')
    }, change)
    await hidden()
    await target.evaluate((node) => {
      node.parentElement.hidden = false
      node.parentElement.parentElement.style.removeProperty('visibility')
      const spacer = document.querySelector('#tooltip-spacer')
      spacer.removeAttribute('style')
      spacer.replaceChildren()
    })
  }
  await page.evaluate(() => {
    const removable = document.createElement('button')
    removable.id = 'tooltip-removable'
    removable.textContent = 'removable'
    removable.dataset.tooltip = 'removable help'
    removable.style.cssText = 'position:fixed;left:12px;bottom:12px'
    document.body.append(removable)
  })
  await other.hover()
  await page.locator('#tooltip-removable').hover()
  await tip.waitFor()
  await page.evaluate(() =>
    document.querySelector('#tooltip-removable').remove(),
  )
  await hidden()
  // Layout shifts from elsewhere, shadow hosts, and a new ancestry must not leave stale help.
  await page.mouse.move(700, 20)
  for (const scenario of [
    'cousin',
    'body sibling',
    'dialog',
    'shadow host',
    'reparent',
  ]) {
    await page.evaluate((scenario) => {
      const root = document.createElement('section')
      root.style.cssText = 'position:fixed;top:180px;left:80px;width:420px'
      const left = document.createElement('div')
      const right = document.createElement('div')
      const spacer = document.createElement('div')
      const anchor = document.createElement('button')
      anchor.textContent = 'probe control'
      left.append(spacer)
      right.append(anchor)
      root.append(left, right)
      document.body.append(root)
      let host = null
      if (scenario === 'body sibling') {
        root.style.cssText = 'width:420px'
        document.body.append(anchor)
      }
      if (scenario === 'dialog') {
        const dialog = document.createElement('dialog')
        dialog.style.cssText =
          'position:fixed;top:120px;left:80px;width:440px;height:200px;margin:0'
        root.style.cssText = 'width:420px'
        root.replaceWith(dialog)
        dialog.append(root)
        dialog.show()
      }
      if (scenario === 'shadow host') {
        host = document.createElement('div')
        root.append(host)
        host.attachShadow({ mode: 'open' }).append(right)
      }
      if (scenario === 'reparent')
        left.style.cssText = right.style.cssText =
          'position:absolute;top:0;left:0'
      window.tooltipProbe = { root, left, spacer, anchor, host }
      window.dialogTest.tips.api.show({ anchor, text: 'probe help' })
    }, scenario)
    await tip.waitFor()
    // Let the anchor's first resize callback pass, so only the change below can dismiss help.
    await frames()
    await page.evaluate((scenario) => {
      const { left, spacer, anchor, host } = window.tooltipProbe
      if (scenario === 'shadow host') host.style.visibility = 'hidden'
      else if (scenario === 'reparent') left.append(anchor)
      else spacer.style.height = '40px'
    }, scenario)
    if (scenario === 'reparent') {
      // The new parent's visibility belongs to the moved anchor too.
      await frames()
      await page.evaluate(() => {
        window.tooltipProbe.left.style.visibility = 'hidden'
      })
    }
    await hidden()
    assert.equal(
      await page.evaluate(() => {
        const { root, anchor } = window.tooltipProbe
        ;(root.closest('dialog') ?? root).remove()
        anchor.remove()
        return anchor.getAttribute('aria-describedby')
      }),
      null,
      scenario,
    )
  }
  // Closed help stops observing its anchor.
  await hover()
  await page.keyboard.press('Escape')
  await hidden()
  assert.equal(await burst(), 0)
  assert.equal(await target.getAttribute('aria-describedby'), 'existing-help')
  await page.evaluate(() => {
    document.querySelector('#tooltip-unrelated').remove()
    document.querySelector('#tooltip-spacer').remove()
  })

  // Imperative addon hints stay open while the pointer moves inside their anchor.
  await other.hover()
  await other.evaluate((anchor) => {
    window.dialogTest.tips.api.show({ anchor, text: 'addon help' })
  })
  await tip.waitFor()
  const otherBounds = await other.boundingBox()
  await page.mouse.move(otherBounds.x + 8, otherBounds.y + 8)
  assert.equal(await tip.innerText(), 'Addon help')
  await target.hover()
  await hidden()

  // Native SVG graph nodes use the same host and retain their accessible name.
  await page.evaluate(() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.id = 'tooltip-svg'
    svg.setAttribute('width', '120')
    svg.setAttribute('height', '80')
    svg.style.cssText = 'position:fixed;right:12px;bottom:-12px'
    svg.innerHTML =
      '<g role="button" tabindex="0" aria-label="graph node" data-tooltip="note connections"><circle cx="60" cy="40" r="20" /></g>'
    document.body.append(svg)
  })
  const svg = page.getByRole('button', { name: 'graph node' })
  await svg.hover()
  await tip.waitFor()
  assert.equal(await tip.innerText(), 'Note connections')
  assert.equal(await svg.getAttribute('aria-label'), 'graph node')
  assert.equal(await tip.getAttribute('data-side'), 'top')
  await target.evaluate((node) => {
    node.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'ArrowRight') return
        event.stopPropagation()
        document.querySelector('#tooltip-svg g').focus()
      },
      { once: true },
    )
  })
  await target.focus()
  await hidden()
  await page.keyboard.press('ArrowRight')
  await tip.waitFor()
  assert.equal(await tip.innerText(), 'Note connections')
  await page.evaluate(() => document.querySelector('#tooltip-svg').remove())
  await hidden()

  await other.hover()
  await page.evaluate(() => {
    const anchor = document.querySelector('[data-tooltip="shared help"]')
    window.dialogTest.tips.api.show({
      anchor,
      text: 'long help '.repeat(40),
      placement: 'top',
    })
  })
  await tip.waitFor()
  const bounds = await tip.boundingBox()
  assert.ok(bounds.x >= 8 && bounds.width <= 280, JSON.stringify(bounds))
  assert.equal(await tip.getAttribute('data-side'), 'bottom')
  await page.keyboard.press('Escape')
  await hidden()
  assert.equal(await target.getAttribute('aria-describedby'), 'existing-help')

  await target.evaluate((node) => {
    node.dataset.verbatim = 'true'
    node.dataset.tooltip = 'myNotes/example.Rmd'
    document.documentElement.dataset.uiCase = 'lowercase'
  })
  await hover()
  assert.equal(await tip.innerText(), 'myNotes/example.Rmd')
  assert.equal(
    await tip.evaluate((node) => getComputedStyle(node).textTransform),
    'none',
  )
  await other.hover()
  await target.evaluate((node) => {
    delete node.dataset.verbatim
    node.dataset.tooltip = 'shared help'
    document.documentElement.dataset.uiCase = 'sentence'
  })
}
