import type { LoadedSource } from './source'
import { renderPage, rotateCanvas } from './source'
import {
  autoRotateProbe,
  recognizeOrientationGeometry,
  scoreRotationProbe
} from './ocr'

export type QuarterTurn = 0|90|180|270

export interface OrientationResult {
  correction:QuarterTurn
  confidence:number
  method:
    |'center-geometry'
    |'auto-rotate'
    |'quarter-fallback'
    |'unchanged'
  detectedAngle:number|null
  snappedTextAngle:QuarterTurn|null
  vectorCount:number
  originalPreview:string|null
  correctedPreview:string|null
}

const ANGLE_TOLERANCE_DEG=18
const MIN_VALID_VECTORS=3
const MIN_WINNER_SHARE=.56

function normalizeDeg(angle:number){
  return ((angle%360)+360)%360
}

function angularDistance(a:number,b:number){
  const d=Math.abs(normalizeDeg(a)-normalizeDeg(b))
  return Math.min(d,360-d)
}

function correctionForTextAngle(angle:QuarterTurn):QuarterTurn{
  const correction=(360-angle)%360
  if(
    correction===90||
    correction===180||
    correction===270
  ){
    return correction
  }
  return 0
}

function analyzeCenterVectors(
  vectors:{
    angle:number
    weight:number
    confidence:number
  }[]
){
  const quarters=([0,90,180,270] as QuarterTurn[])
  const bins=new Map<
    QuarterTurn,
    {
      weight:number
      count:number
      weightedDelta:number
      confidenceWeight:number
    }
  >()

  for(const q of quarters){
    bins.set(q,{
      weight:0,
      count:0,
      weightedDelta:0,
      confidenceWeight:0
    })
  }

  let acceptedWeight=0
  let acceptedCount=0

  for(const vector of vectors){
    const nearest=quarters
      .map(q=>({
        q,
        distance:angularDistance(
          vector.angle,
          q
        )
      }))
      .sort((a,b)=>a.distance-b.distance)[0]

    // 민감도 제한:
    // 0/90/180/270의 ±18° 밖이면 방향 표에서 제외한다.
    if(nearest.distance>ANGLE_TOLERANCE_DEG){
      continue
    }

    const bin=bins.get(nearest.q)!

    // quarter 중심을 기준으로 -180~180 signed delta.
    let delta=
      normalizeDeg(vector.angle-nearest.q)
    if(delta>180)delta-=360

    bin.weight+=vector.weight
    bin.count+=1
    bin.weightedDelta+=delta*vector.weight
    bin.confidenceWeight+=
      vector.confidence*vector.weight

    acceptedWeight+=vector.weight
    acceptedCount+=1
  }

  if(
    acceptedCount<MIN_VALID_VECTORS||
    acceptedWeight<=0
  ){
    return null
  }

  const ranked=quarters
    .map(q=>({
      q,
      ...bins.get(q)!
    }))
    .sort((a,b)=>b.weight-a.weight)

  const winner=ranked[0]
  const runnerUp=ranked[1]
  const share=winner.weight/acceptedWeight

  if(
    winner.count<MIN_VALID_VECTORS||
    share<MIN_WINNER_SHARE
  ){
    return null
  }

  const rawAngle=normalizeDeg(
    winner.q+
    winner.weightedDelta/
      Math.max(1,winner.weight)
  )

  const meanConfidence=
    winner.confidenceWeight/
    Math.max(1,winner.weight)

  const meanError=angularDistance(
    rawAngle,
    winner.q
  )

  const closeness=
    Math.max(
      0,
      1-meanError/ANGLE_TOLERANCE_DEG
    )

  const dominance=
    Math.max(
      0,
      Math.min(
        1,
        share-
        (
          runnerUp.weight/
          Math.max(1,acceptedWeight)
        )+
        .5
      )
    )

  const countFactor=Math.min(
    1,
    winner.count/8
  )

  const confidence=Math.max(
    0,
    Math.min(
      98,
      (
        closeness*.34+
        share*.30+
        dominance*.18+
        countFactor*.10+
        Math.min(1,meanConfidence/100)*.08
      )*100
    )
  )

  return{
    rawAngle,
    snapped:winner.q,
    vectorCount:winner.count,
    acceptedCount,
    winnerShare:share,
    confidence
  }
}

function createSquareSignature(
  canvas:HTMLCanvasElement,
  size=72
){
  const out=document.createElement('canvas')
  out.width=size
  out.height=size
  const ctx=out.getContext(
    '2d',
    {willReadFrequently:true}
  )!

  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,size,size)

  const scale=Math.min(
    size/canvas.width,
    size/canvas.height
  )
  const w=canvas.width*scale
  const h=canvas.height*scale

  ctx.drawImage(
    canvas,
    (size-w)/2,
    (size-h)/2,
    w,h
  )

  const image=ctx.getImageData(
    0,0,size,size
  )

  const gray=new Uint8Array(size*size)

  for(
    let i=0,p=0;
    i<image.data.length;
    i+=4,p++
  ){
    gray[p]=Math.round(
      .299*image.data[i]+
      .587*image.data[i+1]+
      .114*image.data[i+2]
    )
  }

  return gray
}

function meanAbsDiff(
  a:Uint8Array,
  b:Uint8Array
){
  let total=0
  const n=Math.min(a.length,b.length)

  for(let i=0;i<n;i++){
    total+=Math.abs(a[i]-b[i])
  }

  return total/Math.max(1,n)
}

async function imageUrlToCanvas(url:string){
  const img=await new Promise<HTMLImageElement>(
    (resolve,reject)=>{
      const el=new Image()
      el.onload=()=>resolve(el)
      el.onerror=reject
      el.src=url
    }
  )

  const canvas=
    document.createElement('canvas')

  canvas.width=img.naturalWidth
  canvas.height=img.naturalHeight
  canvas
    .getContext('2d')!
    .drawImage(img,0,0)

  return canvas
}

async function inferCorrectionFromAutoImage(
  original:HTMLCanvasElement,
  autoImageUrl:string
){
  const corrected=
    await imageUrlToCanvas(autoImageUrl)

  const target=
    createSquareSignature(corrected)

  const candidates=(
    [0,90,180,270] as QuarterTurn[]
  )
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
  const separation=Math.max(
    0,
    second.diff-best.diff
  )

  return{
    correction:best.angle,
    confidence:Math.max(
      0,
      Math.min(
        92,
        40+
        separation*4-
        best.diff*.65
      )
    )
  }
}

async function fallbackQuarterTurn(
  probe:HTMLCanvasElement
){
  let best:
    |{correction:QuarterTurn;score:number}
    |null=null

  let second=-Infinity

  // 최후 fallback만 4방향을 비교한다.
  // 정상 경로에서는 이 비용이 발생하지 않는다.
  for(
    const correction of
    [0,90,180,270] as QuarterTurn[]
  ){
    const rotated=
      rotateCanvas(
        probe,
        correction
      )

    const score=
      await scoreRotationProbe(rotated)

    if(!best||score>best.score){
      if(best){
        second=Math.max(
          second,
          best.score
        )
      }

      best={correction,score}
    }else{
      second=Math.max(
        second,
        score
      )
    }
  }

  if(!best){
    return{
      correction:0 as QuarterTurn,
      confidence:0
    }
  }

  const gap=
    best.score-
    (
      Number.isFinite(second)
        ?second
        :0
    )

  return{
    correction:best.correction,
    confidence:Math.max(
      25,
      Math.min(
        90,
        46+gap*.8
      )
    )
  }
}

function previewResult(
  probe:HTMLCanvasElement,
  correction:QuarterTurn,
  confidence:number,
  method:OrientationResult['method'],
  detectedAngle:number|null,
  snappedTextAngle:QuarterTurn|null,
  vectorCount:number
):OrientationResult{
  if(correction===0){
    return{
      correction,
      confidence,
      method:'unchanged',
      detectedAngle,
      snappedTextAngle,
      vectorCount,
      originalPreview:null,
      correctedPreview:null
    }
  }

  return{
    correction,
    confidence,
    method,
    detectedAngle,
    snappedTextAngle,
    vectorCount,
    originalPreview:
      probe.toDataURL(
        'image/jpeg',
        .88
      ),
    correctedPreview:
      rotateCanvas(
        probe,
        correction
      ).toDataURL(
        'image/jpeg',
        .88
      )
  }
}

export async function detectOrientation(
  src:LoadedSource,
  onProgress?:(
    progress:number,
    message:string
  )=>void
):Promise<OrientationResult>{
  onProgress?.(
    3,
    'OCR 문자 중심각 계산 중'
  )

  // 방향 판단용 대표 페이지.
  const representative=
    src.pageCount>1
      ?Math.min(1,src.pageCount-1)
      :0

  // 방향만 보는 probe이므로 고해상도 불필요.
  const probe=await renderPage(
    src,
    representative,
    720
  )

  // 1) PRIMARY:
  // 원본 방향 그대로 OCR하여
  // 같은 글줄 단어 중심점들의 방향 벡터를 계산한다.
  try{
    const geometry=
      await recognizeOrientationGeometry(
        probe,
        p=>onProgress?.(
          4+Math.round(p*10),
          'OCR 문자 중심점 분석 중'
        )
      )

    const analyzed=
      analyzeCenterVectors(
        geometry.vectors
      )

    if(analyzed){
      const correction=
        correctionForTextAngle(
          analyzed.snapped
        )

      onProgress?.(
        16,
        analyzed.snapped===0
          ?`중심각 ${analyzed.rawAngle.toFixed(1)}° · 정방향`
          :`중심각 ${analyzed.rawAngle.toFixed(1)}° → ${analyzed.snapped}° 범주`
      )

      // 중심각이 quarter-turn 범주에 충분히 모였으면
      // 추가 방향 OCR 없이 바로 사용한다.
      if(analyzed.confidence>=58){
        return previewResult(
          probe,
          correction,
          analyzed.confidence,
          'center-geometry',
          analyzed.rawAngle,
          analyzed.snapped,
          analyzed.vectorCount
        )
      }
    }
  }catch(error){
    console.warn(
      'center geometry orientation failed',
      error
    )
  }

  // 2) FALLBACK:
  // 중심점 벡터가 너무 적거나 ±18° 범주가 아닌 경우에만
  // 기존 auto-rotate 검증을 한 번 사용한다.
  onProgress?.(
    17,
    '문자 방향 보조검증 중'
  )

  try{
    const auto=
      await autoRotateProbe(
        probe,
        p=>onProgress?.(
          17+Math.round(p*5),
          'OCR 방향 보조검증 중'
        )
      )

    if(auto.imageColor){
      const inferred=
        await inferCorrectionFromAutoImage(
          probe,
          auto.imageColor
        )

      if(inferred.confidence>=38){
        const correction=
          inferred.correction

        const snappedTextAngle=
          normalizeDeg(
            360-correction
          ) as QuarterTurn

        return previewResult(
          probe,
          correction,
          Math.max(
            inferred.confidence,
            Math.min(
              70,
              auto.confidence*.45
            )
          ),
          'auto-rotate',
          snappedTextAngle,
          snappedTextAngle,
          0
        )
      }
    }
  }catch(error){
    console.warn(
      'auto orientation failed',
      error
    )
  }

  // 3) 최후 수단:
  // 아주 애매할 때만 520px 이하에서 4방향 OCR 비교.
  onProgress?.(
    22,
    '방향 최종 교차검증 중'
  )

  const tiny=
    document.createElement('canvas')

  const scale=Math.min(
    1,
    520/Math.max(
      probe.width,
      probe.height
    )
  )

  tiny.width=Math.max(
    1,
    Math.round(
      probe.width*scale
    )
  )

  tiny.height=Math.max(
    1,
    Math.round(
      probe.height*scale
    )
  )

  tiny
    .getContext('2d')!
    .drawImage(
      probe,
      0,0,
      tiny.width,
      tiny.height
    )

  const fallback=
    await fallbackQuarterTurn(tiny)

  const snappedTextAngle=
    normalizeDeg(
      360-fallback.correction
    ) as QuarterTurn

  return previewResult(
    probe,
    fallback.correction,
    fallback.confidence,
    fallback.correction===0
      ?'unchanged'
      :'quarter-fallback',
    snappedTextAngle,
    snappedTextAngle,
    0
  )
}
