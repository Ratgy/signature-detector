import { createWorker, PSM } from 'tesseract.js'
import type { OCRToken } from './types'

let workerPromise:ReturnType<typeof createWorker>|null=null
let progressCb:((p:number,s:string)=>void)|undefined

async function getWorker(
  onProgress?:(p:number,s:string)=>void
){
  progressCb=onProgress

  if(!workerPromise){
    workerPromise=createWorker(
      'kor',
      undefined,
      {
        logger:(m:any)=>{
          if(typeof m.progress==='number'){
            progressCb?.(
              m.progress,
              m.status ?? 'OCR'
            )
          }
        }
      }
    )

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
    .filter(word=>
      word?.text?.trim() &&
      word?.bbox
    )
    .map(word=>({
      text:String(word.text).trim(),
      confidence:Number(
        word.confidence ?? 0
      ),
      pageIndex,
      rect:{
        x:word.bbox.x0/width,
        y:word.bbox.y0/height,
        width:
          (word.bbox.x1-word.bbox.x0)/
          width,
        height:
          (word.bbox.y1-word.bbox.y0)/
          height
      }
    }))
}

export async function recognizePage(
  canvas:HTMLCanvasElement,
  pageIndex:number,
  onProgress?:(
    p:number,
    status:string
  )=>void,
  sparse=true
):Promise<OCRToken[]>{
  const worker=await getWorker(
    onProgress
  )

  await worker.setParameters({
    preserve_interword_spaces:'1',
    user_defined_dpi:'300',
    tessedit_pageseg_mode:
      sparse
        ?PSM.SPARSE_TEXT
        :PSM.AUTO
  } as any)

  const result:any=
    await worker.recognize(
      canvas,
      {},
      {
        blocks:true,
        text:true
      }
    )

  return wordsFromResult(
    result,
    pageIndex,
    canvas.width,
    canvas.height
  )
}


export interface FullOcrResult {
  tokens:OCRToken[]
  text:string
  confidence:number
  hangulChars:number
  hangulRatio:number
  score:number
}

export async function recognizeFullForDirection(
  canvas:HTMLCanvasElement,
  pageIndex:number,
  onProgress?:(p:number,status:string)=>void
):Promise<FullOcrResult>{
  const worker=await getWorker(onProgress)
  await worker.setParameters({
    preserve_interword_spaces:'1',
    user_defined_dpi:'300',
    tessedit_pageseg_mode:PSM.SINGLE_BLOCK
  } as any)
  const result:any=await worker.recognize(canvas,{}, {blocks:true,text:true})
  const tokens=wordsFromResult(result,pageIndex,canvas.width,canvas.height)
  const text=String(result.data?.text ?? '')
  const confidence=Number(result.data?.confidence ?? 0)
  let weighted=0, validHangul=0
  for(const token of tokens){
    const count=(token.text.match(/[가-힣]/g)??[]).length
    if(token.confidence>=60&&count>=1){weighted+=token.confidence*count; validHangul+=count}
  }
  const compact=text.replace(/\s/g,'')
  const allHangul=(compact.match(/[가-힣]/g)??[]).length
  const hangulRatio=compact.length?allHangul/compact.length:0
  return{tokens,text,confidence,hangulChars:validHangul,hangulRatio,score:weighted*(.3+.7*hangulRatio)}
}

export interface DirectionProbeResult {
  score:number
  confidence:number
  keywordHits:number
  hangulRuns:number
  text:string
}

const DOCUMENT_KEYWORDS=[
  '중고자동차',
  '자동차',
  '성능',
  '상태',
  '점검',
  '기록부',
  '유의사항',
  '확인',
  '본인은',
  '매수인',
  '서명',
  '가격',
  '보험',
  '차량',
  '점검자',
  '고지자',
  '년',
  '월',
  '일'
]

export async function probeDirection(
  canvas:HTMLCanvasElement
):Promise<DirectionProbeResult>{
  const worker=await getWorker()

  // 방향 판정 전용. 정확한 bbox가 필요하지 않으므로
  // SPARSE_TEXT + text only로 비용을 최소화한다.
  await worker.setParameters({
    preserve_interword_spaces:'1',
    user_defined_dpi:'260',
    tessedit_pageseg_mode:
      PSM.SPARSE_TEXT
  } as any)

  const result:any=
    await worker.recognize(
      canvas,
      {},
      {
        text:true,
        blocks:false
      }
    )

  const text=String(
    result.data?.text ?? ''
  )
  const compact=text.replace(
    /\s+/g,
    ''
  )
  const confidence=Number(
    result.data?.confidence ?? 0
  )

  let keywordHits=0
  let keywordScore=0

  for(const keyword of DOCUMENT_KEYWORDS){
    if(compact.includes(keyword)){
      keywordHits++

      // 방향을 구별하기 좋은 긴 단어를 더 강하게 사용.
      keywordScore+=
        keyword.length>=4
          ?16
          :keyword.length>=2
            ?9
            :2
    }
  }

  const hangulRuns=
    (
      text.match(
        /[가-힣]{2,}/g
      ) ?? []
    ).length

  const hangulChars=
    (
      text.match(
        /[가-힣]/g
      ) ?? []
    ).length

  // 180°/90° 오판을 막기 위해 단순 confidence보다
  // "정상적인 한국어 단어/문서 키워드"를 훨씬 크게 본다.
  const score=
    keywordScore+
    Math.min(48,hangulRuns*2.2)+
    Math.min(28,hangulChars*.12)+
    Math.max(0,confidence)*.16

  return{
    score,
    confidence,
    keywordHits,
    hangulRuns,
    text
  }
}


export async function warmupOCR(){
  try{
    await getWorker()
    return true
  }catch(error){
    console.warn(
      'OCR warmup failed',
      error
    )
    return false
  }
}

export async function terminateOCR(){
  if(workerPromise){
    const worker=
      await workerPromise

    await worker.terminate()
    workerPromise=null
  }
}
