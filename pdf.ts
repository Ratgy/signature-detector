import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { Rotation } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

export async function loadPdf(file: File): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await file.arrayBuffer())
  return pdfjsLib.getDocument({ data }).promise
}

export const ROTATIONS: Rotation[] = [0, 90, 270, 180]

async function renderAtMaxSide(page: PDFPageProxy, rotation: Rotation, maxSide: number) {
  const base = page.getViewport({ scale: 1, rotation })
  const scale = Math.max(.7, Math.min(2.4, maxSide / Math.max(base.width, base.height)))
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

// Fast orientation/page scan: intentionally small.
export const renderPageFast = (page: PDFPageProxy, rotation: Rotation) =>
  renderAtMaxSide(page, rotation, 920)

// Precise OCR: only selected page+rotation, still capped for mobile memory.
export const renderPagePrecise = (page: PDFPageProxy, rotation: Rotation) =>
  renderAtMaxSide(page, rotation, 1850)

export function preprocessCanvas(source: HTMLCanvasElement) {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = image.data
  const contrast = 1.2
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const adjusted = Math.max(0, Math.min(255, (gray - 128) * contrast + 128))
    d[i] = d[i + 1] = d[i + 2] = adjusted
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

export async function renderPagePreview(page: PDFPageProxy, rotation: Rotation = 0) {
  const base = page.getViewport({ scale: 1, rotation })
  const scale = Math.min(1.35, 950 / base.width)
  const viewport = page.getViewport({ scale, rotation })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport, canvas }).promise
  return canvas.toDataURL('image/jpeg', 0.86)
}
