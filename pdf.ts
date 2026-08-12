import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { NormalizedRect, Rotation } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

export async function loadPdf(file: File): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await file.arrayBuffer())
  return pdfjsLib.getDocument({ data }).promise
}

export function rotationForAttempt(attempt: number): Rotation {
  return ([0, 90, 270, 180] as Rotation[])[attempt] ?? 0
}

export async function renderPageForOCR(page: PDFPageProxy, rotation: Rotation) {
  const base = page.getViewport({ scale: 1, rotation })
  const targetMax = 2600
  const scale = Math.max(1.8, Math.min(3.1, targetMax / Math.max(base.width, base.height)))
  const viewport = page.getViewport({ scale, rotation })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport, canvas }).promise
  return canvas
}

export function preprocessCanvas(source: HTMLCanvasElement) {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = image.data

  // Conservative grayscale + contrast. Avoid hard thresholding because faint Korean glyphs
  // can disappear on low-quality scans.
  const contrast = 1.28
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const adjusted = Math.max(0, Math.min(255, (gray - 128) * contrast + 128))
    d[i] = d[i + 1] = d[i + 2] = adjusted
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

export function cropCanvas(source: HTMLCanvasElement, rect: NormalizedRect) {
  const sx = Math.max(0, Math.floor(rect.x * source.width))
  const sy = Math.max(0, Math.floor(rect.y * source.height))
  const sw = Math.max(1, Math.min(source.width - sx, Math.ceil(rect.width * source.width)))
  const sh = Math.max(1, Math.min(source.height - sy, Math.ceil(rect.height * source.height)))
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  canvas.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvas
}

export async function renderPagePreview(page: PDFPageProxy) {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(1.5, 1050 / base.width)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport, canvas }).promise
  return canvas.toDataURL('image/jpeg', 0.9)
}
