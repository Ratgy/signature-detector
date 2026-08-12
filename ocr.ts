import { createWorker } from 'tesseract.js'
import type { OCRToken } from './types'

let workerPromise: ReturnType<typeof createWorker> | null = null
let loggerCb: ((p:number,s:string)=>void) | undefined

async function getWorker(onProgress?: (p:number,s:string)=>void) {
  loggerCb=onProgress
  if (!workerPromise) {
    workerPromise = createWorker('kor+eng', undefined, {
      logger: (m:any) => {
        if (typeof m.progress === 'number') loggerCb?.(m.progress, m.status ?? 'OCR')
      }
    })
    const w=await workerPromise
    await w.setParameters({
      preserve_interword_spaces:'1',
      user_defined_dpi:'300',
    } as any)
    return w
  }
  return workerPromise
}

export async function recognizeTextFast(canvas: HTMLCanvasElement) {
  const w = await getWorker()
  await w.setParameters({
    tessedit_pageseg_mode:'11',
    preserve_interword_spaces:'1'
  } as any)
  const r:any = await w.recognize(canvas)
  return { text:String(r.data?.text ?? ''), confidence:Number(r.data?.confidence ?? 0) }
}

export async function recognizeWordsPrecise(
  canvas: HTMLCanvasElement,
  pageIndex: number,
  onProgress?: (p:number,s:string)=>void,
  sparse=false
): Promise<OCRToken[]> {
  const w = await getWorker(onProgress)
  await w.setParameters({
    tessedit_pageseg_mode:sparse?'11':'6',
    preserve_interword_spaces:'1',
    user_defined_dpi:'300'
  } as any)

  const r:any = await w.recognize(canvas, {}, { blocks:true, text:true })
  const words:any[] = []
  for (const block of r.data?.blocks ?? [])
    for (const paragraph of block.paragraphs ?? [])
      for (const line of paragraph.lines ?? [])
        for (const word of line.words ?? []) words.push(word)

  return words.filter(w => w?.text?.trim() && w?.bbox).map(w => ({
    text:String(w.text).trim(),
    confidence:Number(w.confidence ?? 0),
    pageIndex,
    rect:{
      x:w.bbox.x0/canvas.width,
      y:w.bbox.y0/canvas.height,
      width:(w.bbox.x1-w.bbox.x0)/canvas.width,
      height:(w.bbox.y1-w.bbox.y0)/canvas.height,
    }
  }))
}

export async function terminateOCR() {
  if (workerPromise) {
    const w = await workerPromise
    await w.terminate()
    workerPromise = null
  }
}
