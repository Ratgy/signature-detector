import { createWorker, PSM } from 'tesseract.js'
import type { OCRToken } from './types'

let workerPromise:ReturnType<typeof createWorker>|null=null
let progressCb:((p:number,s:string)=>void)|undefined

async function getWorker(onProgress?:(p:number,s:string)=>void){
  progressCb=onProgress

  if(!workerPromise){
    workerPromise=createWorker('kor',undefined,{
      logger:(m:any)=>{
        if(typeof m.progress==='number'){
          progressCb?.(m.progress,m.status ?? 'OCR')
        }
      }
    })

    const worker=await workerPromise
    await worker.setParameters({
      preserve_interword_spaces:'1',
      user_defined_dpi:'300',
      tessedit_pageseg_mode:PSM.SPARSE_TEXT
    } as any)

    return worker
  }

  return workerPromise
}

export async function recognizeContactSheet(
  canvas:HTMLCanvasElement,
  pageIndex:number,
  onProgress?:(p:number,s:string)=>void
):Promise<OCRToken[]>{
  const worker=await getWorker(onProgress)

  await worker.setParameters({
    preserve_interword_spaces:'1',
    user_defined_dpi:'300',
    tessedit_pageseg_mode:PSM.SPARSE_TEXT
  } as any)

  const result:any=await worker.recognize(
    canvas,
    {},
    {blocks:true,text:true}
  )

  const words:any[]=[]

  for(const block of result.data?.blocks ?? []){
    for(const paragraph of block.paragraphs ?? []){
      for(const line of paragraph.lines ?? []){
        for(const word of line.words ?? []){
          words.push(word)
        }
      }
    }
  }

  return words
    .filter(w=>w?.text?.trim() && w?.bbox)
    .map(w=>({
      text:String(w.text).trim(),
      confidence:Number(w.confidence ?? 0),
      pageIndex,
      rect:{
        x:w.bbox.x0/canvas.width,
        y:w.bbox.y0/canvas.height,
        width:(w.bbox.x1-w.bbox.x0)/canvas.width,
        height:(w.bbox.y1-w.bbox.y0)/canvas.height
      }
    }))
}

export async function terminateOCR(){
  if(workerPromise){
    const worker=await workerPromise
    await worker.terminate()
    workerPromise=null
  }
}
