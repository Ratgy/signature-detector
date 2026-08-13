import {recognizeFullForDirection} from './ocr'
import {rotateCanvas} from './source'
import type {OCRToken} from './types'

export type QuarterTurn=0|90|180|270
export interface DirectionDecision {
  correction:QuarterTurn
  confidence:number
  tokens:OCRToken[]
  analysisWidth:number
  analysisHeight:number
  score:number
}
const ROTATIONS:QuarterTurn[]=[0,90,180,270]
const TARGET_DIM=1600
const MIN_EVIDENCE=18
const MIN_MARGIN=1.20

function normalizeForOcr(input:HTMLCanvasElement){
  const scale=TARGET_DIM/Math.max(input.width,input.height)
  const out=document.createElement('canvas')
  out.width=Math.max(1,Math.round(input.width*scale))
  out.height=Math.max(1,Math.round(input.height*scale))
  const ctx=out.getContext('2d',{willReadFrequently:true})!
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,out.width,out.height)
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high'
  ctx.filter='grayscale(1) contrast(1.35)'
  ctx.drawImage(input,0,0,out.width,out.height); ctx.filter='none'
  return out
}

export async function decidePageDirection(
  page:HTMLCanvasElement,
  pageIndex=0,
  onProgress?:(progress:number,message:string)=>void
):Promise<DirectionDecision>{
  const base=normalizeForOcr(page)
  const results:{correction:QuarterTurn;score:number;chars:number;confidence:number;tokens:OCRToken[];width:number;height:number}[]=[]
  for(let i=0;i<ROTATIONS.length;i++){
    const correction=ROTATIONS[i]
    const rotated=correction===0?base:rotateCanvas(base,correction)
    onProgress?.(4+Math.round(i/4*18),`문서 방향 확인 ${i+1}/4`)
    const result=await recognizeFullForDirection(rotated,pageIndex)
    results.push({correction,score:result.score,chars:result.hangulChars,confidence:result.confidence,tokens:result.tokens,width:rotated.width,height:rotated.height})
  }
  const sorted=[...results].sort((a,b)=>b.score-a.score)
  let best=sorted[0]; const runner=sorted[1]
  if(best.chars<MIN_EVIDENCE)best=results.find(r=>r.correction===0)!
  const ratio=runner?.score>0?best.score/runner.score:99
  if(ratio<MIN_MARGIN&&best.chars<MIN_EVIDENCE*1.8){
    const zero=results.find(r=>r.correction===0)
    if(zero&&zero.chars>=best.chars*.72)best=zero
  }
  const gap=best.score-(runner?.score??0)
  const confidence=Math.max(40,Math.min(99,62+Math.log10(Math.max(1,gap+1))*10+Math.min(20,best.chars*.16)))
  onProgress?.(23,best.correction===0?'정방향 확인 완료':'문서를 정방향으로 맞췄어요')
  return{correction:best.correction,confidence,tokens:best.tokens,analysisWidth:best.width,analysisHeight:best.height,score:best.score}
}
