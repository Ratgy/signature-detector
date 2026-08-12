import { createWorker, PSM } from 'tesseract.js'
import type { OCRToken } from './types'

let workerPromise: ReturnType<typeof createWorker> | null = null
let progressHandler: ((p:number,s:string)=>void) | undefined

async function getWorker(onProgress?: (p:number,s:string)=>void) {
  progressHandler=onProgress

  if(!workerPromise){
    // v13: target words are Korean. Loading only kor reduces model/setup overhead.
    workerPromise=createWorker('kor', undefined, {
      logger:(m:any)=>{
        if(typeof m.progress==='number'){
          progressHandler?.(m.progress,m.status ?? 'OCR')
        }
      }
    })

    const worker=await workerPromise
    await worker.setParameters({
      preserve_interword_spaces:'1',
      user_defined_dpi:'300',
      tessedit_pageseg_mode:PSM.SINGLE_BLOCK,
    } as any)
    return worker
  }

  return workerPromise
}

function extractWords(result:any, pageIndex:number, width:number, height:number):OCRToken[]{
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
        x:w.bbox.x0/width,
        y:w.bbox.y0/height,
        width:(w.bbox.x1-w.bbox.x0)/width,
        height:(w.bbox.y1-w.bbox.y0)/height,
      }
    }))
}

export async function recognizeRegion(
  canvas:HTMLCanvasElement,
  pageIndex:number,
  onProgress?: (p:number,s:string)=>void,
  sparse=false
):Promise<OCRToken[]>{
  const worker=await getWorker(onProgress)

  await worker.setParameters({
    preserve_interword_spaces:'1',
    user_defined_dpi:'300',
    tessedit_pageseg_mode:sparse ? PSM.SPARSE_TEXT : PSM.SINGLE_BLOCK,
  } as any)

  const result:any=await worker.recognize(
    canvas,
    {},
    {blocks:true,text:true}
  )

  return extractWords(result,pageIndex,canvas.width,canvas.height)
}

export async function terminateOCR(){
  if(workerPromise){
    const worker=await workerPromise
    await worker.terminate()
    workerPromise=null
  }
}
