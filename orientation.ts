import type { LoadedSource } from './source'
import { renderPage, rotateCanvas } from './source'
import { autoRotateProbe, scoreRotationProbe } from './ocr'

export type QuarterTurn = 0|90|180|270

export interface OrientationResult {
  correction:QuarterTurn
  confidence:number
  method:'auto-rotate'|'quarter-fallback'|'unchanged'
  originalPreview:string|null
  correctedPreview:string|null
}

function normalizedAngle(angle:number):QuarterTurn{
  const a=((Math.round(angle/90)*90)%360+360)%360
  if(a===90||a===180||a===270)return a
  return 0
}

function createSquareSignature(canvas:HTMLCanvasElement,size=72){
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
    gray[p]=Math.round(
      .299*img.data[i]+
      .587*img.data[i+1]+
      .114*img.data[i+2]
    )
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
){
  const corrected=await imageUrlToCanvas(autoImageUrl)
  const target=createSquareSignature(corrected)

  const candidates=([0,90,180,270] as QuarterTurn[])
    .map(angle=>({
      angle,
      diff:meanAbsDiff(
        createSquareSignature(
          rotateCanvas(original,angle)
        ),
        target
      )
    }))
    .sort((a,b)=>a.diff-b.diff)

  const best=candidates[0]
  const second=candidates[1]
  const separation=Math.max(0,second.diff-best.diff)

  return{
    angle:best.angle,
    confidence:Math.max(
      0,
      Math.min(100,42+separation*4-best.diff*.65)
    )
  }
}

async function fallbackQuarterTurn(probe:HTMLCanvasElement){
  let best:{angle:QuarterTurn;score:number}|null=null
  let second=-Infinity

  // fallback는 정말 애매할 때만 실행하며,
  // probe도 520px 이하이므로 4방향 비교 비용을 제한한다.
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

  if(!best){
    return{
      angle:0 as QuarterTurn,
      confidence:0
    }
  }

  const gap=best.score-(Number.isFinite(second)?second:0)

  return{
    angle:best.angle,
    confidence:Math.max(
      25,
      Math.min(92,48+gap*.8)
    )
  }
}

export async function detectOrientation(
  src:LoadedSource,
  onProgress?:(progress:number,message:string)=>void
):Promise<OrientationResult>{
  onProgress?.(3,'문자 방향 확인 중')

  // 한 파일의 모든 페이지가 같은 방향으로 저장된다는 전제.
  // 텍스트가 상대적으로 많은 2페이지(없으면 1페이지)를 작은 크기로 1회만 판독.
  const representative=
    src.pageCount>1
      ?Math.min(1,src.pageCount-1)
      :0

  const probe=await renderPage(
    src,
    representative,
    680
  )

  let correction:QuarterTurn=0
  let confidence=0
  let method:OrientationResult['method']='unchanged'

  try{
    const auto=await autoRotateProbe(
      probe,
      p=>onProgress?.(
        4+Math.round(p*10),
        'OCR 문자 방향 판독 중'
      )
    )

    if(auto.imageColor){
      const inferred=
        await inferCorrectionFromAutoImage(
          probe,
          auto.imageColor
        )

      correction=normalizedAngle(inferred.angle)
      confidence=Math.max(
        inferred.confidence,
        Math.min(70,auto.confidence*.45)
      )
      method='auto-rotate'
    }
  }catch(error){
    console.warn(
      'auto orientation failed',
      error
    )
  }

  // 정상/회전 판단이 충분히 분리되면 여기서 즉시 종료.
  // 4방향 OCR은 낮은 확신도에서만 수행한다.
  if(confidence<36){
    onProgress?.(15,'방향 빠른 교차검증 중')

    const tiny=document.createElement('canvas')
    const scale=Math.min(
      1,
      520/Math.max(probe.width,probe.height)
    )
    tiny.width=Math.max(
      1,
      Math.round(probe.width*scale)
    )
    tiny.height=Math.max(
      1,
      Math.round(probe.height*scale)
    )
    tiny.getContext('2d')!.drawImage(
      probe,
      0,0,
      tiny.width,tiny.height
    )

    const fallback=
      await fallbackQuarterTurn(tiny)

    correction=fallback.angle
    confidence=fallback.confidence
    method='quarter-fallback'
  }

  onProgress?.(
    22,
    correction===0
      ?'정방향 확인 완료'
      :`${correction}° 회전 보정`
  )

  if(correction===0){
    return{
      correction,
      confidence,
      method:'unchanged',
      originalPreview:null,
      correctedPreview:null
    }
  }

  // 저장용 파일을 만들지 않는다.
  // 사용자에게 보여줄 비교 이미지만 작은 preview로 생성한다.
  const originalPreview=
    probe.toDataURL('image/jpeg',.88)

  const correctedPreview=
    rotateCanvas(
      probe,
      correction
    ).toDataURL('image/jpeg',.88)

  return{
    correction,
    confidence,
    method,
    originalPreview,
    correctedPreview
  }
}
