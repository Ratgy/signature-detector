import type { LoadedSource } from './source'
import {
  createCanvasSource,
  renderPage,
  rotateCanvas,
  sourceToNormalizedBlob
} from './source'
import { autoRotateProbe, scoreRotationProbe } from './ocr'

export type QuarterTurn = 0 | 90 | 180 | 270

export interface OrientationResult {
  source:LoadedSource
  correction:QuarterTurn
  confidence:number
  method:'auto-rotate'|'quarter-fallback'|'unchanged'
  blob:Blob
  fileName:string
  preview:string
}

function normalizedAngle(angle:number):QuarterTurn{
  const a=((Math.round(angle/90)*90)%360+360)%360
  if(a===90||a===180||a===270)return a
  return 0
}

function createSquareSignature(canvas:HTMLCanvasElement,size=96){
  const out=document.createElement('canvas')
  out.width=size
  out.height=size
  const ctx=out.getContext('2d',{willReadFrequently:true})!
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,size,size)

  const scale=Math.min(size/canvas.width,size/canvas.height)
  const w=canvas.width*scale
  const h=canvas.height*scale
  ctx.drawImage(canvas,(size-w)/2,(size-h)/2,w,h)

  const img=ctx.getImageData(0,0,size,size)
  const gray=new Uint8Array(size*size)
  for(let i=0,p=0;i<img.data.length;i+=4,p++){
    gray[p]=Math.round(.299*img.data[i]+.587*img.data[i+1]+.114*img.data[i+2])
  }
  return gray
}

function meanAbsDiff(a:Uint8Array,b:Uint8Array){
  let total=0
  const n=Math.min(a.length,b.length)
  for(let i=0;i<n;i++)total+=Math.abs(a[i]-b[i])
  return total/Math.max(1,n)
}

async function imageUrlToCanvas(url:string){
  const img=await new Promise<HTMLImageElement>((resolve,reject)=>{
    const el=new Image()
    el.onload=()=>resolve(el)
    el.onerror=reject
    el.src=url
  })
  const c=document.createElement('canvas')
  c.width=img.naturalWidth
  c.height=img.naturalHeight
  c.getContext('2d')!.drawImage(img,0,0)
  return c
}

async function inferCorrectionFromAutoImage(
  original:HTMLCanvasElement,
  autoImageUrl:string
):Promise<{angle:QuarterTurn;confidence:number}>{
  const corrected=await imageUrlToCanvas(autoImageUrl)
  const target=createSquareSignature(corrected)
  const candidates=([0,90,180,270] as QuarterTurn[]).map(angle=>{
    const rotated=rotateCanvas(original,angle)
    return{angle,diff:meanAbsDiff(createSquareSignature(rotated),target)}
  }).sort((a,b)=>a.diff-b.diff)

  const best=candidates[0]
  const second=candidates[1]
  const separation=Math.max(0,second.diff-best.diff)
  const confidence=Math.max(0,Math.min(100,35+separation*4-best.diff*.7))
  return{angle:best.angle,confidence}
}

async function fallbackQuarterTurn(probe:HTMLCanvasElement){
  let best:{angle:QuarterTurn;score:number}|null=null
  let second=-Infinity

  for(const angle of [0,90,180,270] as QuarterTurn[]){
    const rotated=rotateCanvas(probe,angle)
    const score=await scoreRotationProbe(rotated)
    if(!best||score>best.score){
      if(best)second=Math.max(second,best.score)
      best={angle,score}
    }else{
      second=Math.max(second,score)
    }
  }

  if(!best)return{angle:0 as QuarterTurn,confidence:0}
  const gap=best.score-(Number.isFinite(second)?second:0)
  return{
    angle:best.angle,
    confidence:Math.max(20,Math.min(92,45+gap*.7))
  }
}

function correctedName(file:File){
  const index=file.name.lastIndexOf('.')
  if(index<0)return`${file.name}_upright`
  return`${file.name.slice(0,index)}_upright${file.name.slice(index)}`
}

export async function normalizeOrientation(
  file:File,
  src:LoadedSource,
  onProgress?:(progress:number,message:string)=>void
):Promise<OrientationResult>{
  onProgress?.(3,'문서 방향 확인 중')

  // Whole-file rotation is assumed. A text-heavy representative page is enough,
  // and keeps this stage much cheaper than OCRing every page four ways.
  const representative=src.pageCount>1?Math.min(src.pageCount-1,1):0
  const probe=await renderPage(src,representative,900)

  let correction:QuarterTurn=0
  let confidence=0
  let method:OrientationResult['method']='unchanged'

  try{
    const auto=await autoRotateProbe(probe,p=>{
      onProgress?.(4+Math.round(p*12),'OCR 문자 방향 판독 중')
    })

    if(auto.imageColor){
      const inferred=await inferCorrectionFromAutoImage(probe,auto.imageColor)
      correction=normalizedAngle(inferred.angle)
      confidence=Math.max(inferred.confidence,auto.confidence*.55)
      method='auto-rotate'
    }
  }catch(error){
    console.warn('auto orientation failed',error)
  }

  // If the auto-rotated image is ambiguous, compare only four tiny OCR probes.
  // This fallback is intentionally rare to avoid making the normal path slow.
  if(confidence<48){
    onProgress?.(17,'방향 교차검증 중')
    const fallback=await fallbackQuarterTurn(probe)
    correction=fallback.angle
    confidence=fallback.confidence
    method='quarter-fallback'
  }

  onProgress?.(23,correction===0?'이미 정방향입니다.':'문서를 정방향으로 회전 중')

  if(correction===0){
    const preview=(await renderPage(src,0,1200)).toDataURL('image/jpeg',.9)
    return{
      source:src,
      correction,
      confidence,
      method:'unchanged',
      blob:file.slice(0,file.size,file.type||undefined),
      fileName:correctedName(file),
      preview
    }
  }

  const pages:HTMLCanvasElement[]=[]
  for(let pageIndex=0;pageIndex<src.pageCount;pageIndex++){
    onProgress?.(
      24+Math.round(((pageIndex+1)/src.pageCount)*8),
      `문서 회전 ${pageIndex+1}/${src.pageCount}`
    )
    const original=await renderPage(src,pageIndex,2100)
    pages.push(rotateCanvas(original,correction))
  }

  const normalized=createCanvasSource(
    pages,
    src.type==='pdf'?'pdf':'image'
  )
  const blob=await sourceToNormalizedBlob(normalized,file.type,file.name)

  return{
    source:normalized,
    correction,
    confidence,
    method,
    blob,
    fileName:correctedName(file),
    preview:pages[0].toDataURL('image/jpeg',.9)
  }
}
