import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampPage,
  fitScale,
  MAX_CANVAS_PIXELS,
  MAX_ZOOM,
  MIN_ZOOM,
  pageAt,
  passwordError,
  readPdf,
  renderScale,
  wheelZoom,
  zoomStep,
} from '../src/renderer/src/pdf-layout.ts'

test('fit-width scales the page to the pane', () => {
  assert.equal(fitScale(800, 400), 2)
  assert.equal(fitScale(300, 300), 1)
  assert.equal(fitScale(150, 300), 0.5)
})

test('fit-width never returns a scale that is zero, negative, or not finite', () => {
  for (const [pane, page] of [
    [0, 400],
    [-10, 400],
    [800, 0],
    [Number.NaN, 400],
    [800, Number.NaN],
  ])
    assert.equal(fitScale(pane, page), 1, `${pane}/${page}`)
})

test('a small page renders at fit × zoom × pixel ratio', () => {
  assert.equal(renderScale(1.5, 2, 2, 100, 100), 6)
  assert.equal(renderScale(1, 1, 1, 612, 792), 1)
})

test('a huge page is capped at the canvas pixel limit', () => {
  const width = 6000
  const height = 8000
  const scale = renderScale(1, 4, 2, width, height)
  assert.ok(scale > 0 && scale < 8)
  assert.ok(width * scale * (height * scale) <= MAX_CANVAS_PIXELS)
})

test('pageAt finds the page under a scroll position', () => {
  const tops = [0, 100, 250, 400]
  assert.equal(pageAt(tops, 0), 1)
  assert.equal(pageAt(tops, 99), 1)
  assert.equal(pageAt(tops, 100), 2)
  assert.equal(pageAt(tops, 180), 2)
  assert.equal(pageAt(tops, 250), 3)
  assert.equal(pageAt(tops, 9000), 4)
})

test('pageAt treats a negative position or no pages as page one', () => {
  assert.equal(pageAt([0, 100], -50), 1)
  assert.equal(pageAt([], 500), 1)
})

test('readPdf reads the PDF by revision', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const calls = []
  const read = async (revision) => {
    calls.push(revision)
    return bytes
  }
  assert.equal(await readPdf(7, read), bytes)
  assert.deepEqual(calls, [7])
})

test('readPdf maps a missing, empty, or failed read to null', async () => {
  assert.equal(await readPdf(1, undefined), null)
  assert.equal(await readPdf(1, async () => null), null)
  assert.equal(await readPdf(1, async () => new Uint8Array()), null)
  assert.equal(await readPdf(1, () => Promise.reject(new Error())), null)
})

test('a requested page is clamped to the pages that exist', () => {
  assert.equal(clampPage(0, 10), 1)
  assert.equal(clampPage(-5, 10), 1)
  assert.equal(clampPage(1, 10), 1)
  assert.equal(clampPage(10, 10), 10)
  assert.equal(clampPage(11, 10), 10)
  assert.equal(clampPage(3.6, 10), 4)
})

test('a bad page number or no pages falls back to page one', () => {
  assert.equal(clampPage(Number.NaN, 10), 1)
  assert.equal(clampPage(5, 0), 1)
})

test('zoom steps to the neighboring step', () => {
  assert.equal(zoomStep(1, 1), 1.25)
  assert.equal(zoomStep(1, -1), 0.75)
})

test('an off-step zoom moves to the next step in that direction', () => {
  assert.equal(zoomStep(1.3, 1), 1.5)
  assert.equal(zoomStep(1.3, -1), 1.25)
})

test('zoom steps stop at the bounds', () => {
  assert.equal(zoomStep(MAX_ZOOM, 1), MAX_ZOOM)
  assert.equal(zoomStep(MIN_ZOOM, -1), MIN_ZOOM)
  let zoom = 1
  for (let index = 0; index < 20; index++) zoom = zoomStep(zoom, 1)
  assert.equal(zoom, MAX_ZOOM)
  for (let index = 0; index < 20; index++) zoom = zoomStep(zoom, -1)
  assert.equal(zoom, MIN_ZOOM)
})

test('the wheel zooms between a quarter and four times fit', () => {
  assert.ok(wheelZoom(1, -100) > 1)
  assert.ok(wheelZoom(1, 100) < 1)
  assert.equal(wheelZoom(MAX_ZOOM, -100), MAX_ZOOM)
  assert.equal(wheelZoom(MIN_ZOOM, 100), MIN_ZOOM)
})

test('the wheel returns to fit when zooming in and back out', () => {
  assert.ok(Math.abs(wheelZoom(wheelZoom(1, -100), 100) - 1) < 1e-9)
})

test('the password prompt explains a wrong password and not the first ask', () => {
  assert.equal(passwordError(1), null)
  assert.equal(passwordError(2), 'Incorrect password. Try again.')
})
