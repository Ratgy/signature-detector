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
      user_defined_dpi:'300'
    } as any)
    return worker
  }

  return workerPromise
}

function wordsFromResult(
  result:any,
  pageIndex:number,
  width:number,
  height:number
):OCRToken[]{
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
        height:(w.bbox.y1-w.bbox.y0)/height
      }
    }))
}

export async function recognizePage(
  canvas:HTMLCanvasElement,
  pageIndex:number,
  onProgress?:(p:number,s:string)=>void,
  sparse=false
):Promise<OCRToken[]>{
  const worker=await getWorker(onProgress)

  await worker.setParameters({
    preserve_interword_spaces:'1',
    user_defined_dpi:'300',
    // 촬영본의 표/문단은 SINGLE_BLOCK이 년월일 행을 더 잘 보존하고,
    // 분할 fallback은 SPARSE_TEXT가 잘린 문장을 더 잘 찾는다.
    tessedit_pageseg_mode:
      sparse
        ?PSM.SPARSE_TEXT
        :PSM.SINGLE_BLOCK
  } as any)

  const result:any=await worker.recognize(
    canvas,
    {},
    {blocks:true,text:true}
  )

  return wordsFromResult(
    result,
    pageIndex,
    canvas.width,
    canvas.height
  )
}

export async function terminateOCR(){
  if(workerPromise){
    const worker=await workerPromise
    await worker.terminate()
    workerPromise=null
  }
}

export async function autoRotateProbe(
  canvas:HTMLCanvasElement,
  onProgress?:(p:number,s:string)=>void
){
  const worker=await getWorker(onProgress)
  await worker.setParameters({
    preserve_interword_spaces:'1',
    user_defined_dpi:'300',
    tessedit_pageseg_mode:PSM.AUTO
  } as any)

  const result:any=await worker.recognize(
    canvas,
    {rotateAuto:true},
    {text:true,imageColor:true,blocks:false}
  )

  return{
    text:String(result.data?.text ?? ''),
    confidence:Number(result.data?.confidence ?? 0),
    imageColor:String(result.data?.imageColor ?? '')
  }
}

export async function scoreRotationProbe(canvas:HTMLCanvasElement){
  const worker=await getWorker()
  await worker.setParameters({
    preserve_interword_spaces:'1',
    user_defined_dpi:'220',
    tessedit_pageseg_mode:PSM.SPARSE_TEXT
  } as any)

  const result:any=await worker.recognize(
    canvas,
    {},
    {text:true,blocks:false}
  )

  const text=String(result.data?.text ?? '')
  const confidence=Number(result.data?.confidence ?? 0)
  const hangul=(text.match(/[가-힣]/g)??[]).length
  const compact=text.replace(/\s+/g,'')

  let keyword=0
  for(const word of ['성능','자동차','점검','확인','매수인','서명','년','월','일']){
    if(compact.includes(word))keyword+=1
  }

  return confidence + Math.min(28,hangul*.28) + keyword*6
}
