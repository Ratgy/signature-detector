import { createWorker } from 'tesseract.js'
import type { OCRToken } from './types'

let workerPromise: ReturnType<typeof createWorker> | null = null

async function getWorker(onProgress?: (p:number,status:string)=>void) {
  if (!workerPromise) {
    workerPromise = createWorker('kor+eng', undefined, {
      logger: (m:any) => {
        if (typeof m.progress === 'number') onProgress?.(m.progress, m.status ?? 'OCR')
      },
    })
  }
  return workerPromise
}

// ultra-fast first pass: text only
export async function recognizeTextFast(
  canvas: HTMLCanvasElement,
  onProgress?: (p:number,status:string)=>void,
) {
  const worker = await getWorker(onProgress)
  const result:any = await worker.recognize(canvas)
  return {
    text: String(result.data?.text ?? ''),
    confidence: Number(result.data?.confidence ?? 0),
  }
}

// precise pass only for one small ROI
export async function recognizeWordsPrecise(
  canvas: HTMLCanvasElement,
  pageIndex: number,
  onProgress?: (p:number,status:string)=>void,
): Promise<OCRToken[]> {
  const worker = await getWorker(onProgress)
  const result:any = await worker.recognize(canvas, {}, { blocks: true, text: true })
  const words:any[] = []
  for (const block of result.data?.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) words.push(word)
      }
    }
  }
  return words
    .filter(w => w?.text?.trim() && w?.bbox)
    .map(w => ({
      text: String(w.text).trim(),
      confidence: Number(w.confidence ?? 0),
      pageIndex,
      rect: {
        x: w.bbox.x0 / canvas.width,
        y: w.bbox.y0 / canvas.height,
        width: (w.bbox.x1 - w.bbox.x0) / canvas.width,
        height: (w.bbox.y1 - w.bbox.y0) / canvas.height,
      },
    }))
}

export async function terminateOCR() {
  if (workerPromise) {
    const worker = await workerPromise
    await worker.terminate()
    workerPromise = null
  }
}
