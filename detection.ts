import type { DetectionCandidate, NormalizedRect, OCRToken, Rotation, SignatureTarget } from './types'

const clean=(s:string)=>s.replace(/\s+/g,'').replace(/[.,:;_\-|]/g,'').replace(/[［\[]/g,'(').replace(/[］\]]/g,')')
const center=(r:NormalizedRect)=>({x:r.x+r.width/2,y:r.y+r.height/2})

function levenshtein(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  const dp=Array.from({length:aa.length+1},()=>Array(bb.length+1).fill(0))
  for(let i=0;i<=aa.length;i++)dp[i][0]=i
  for(let j=0;j<=bb.length;j++)dp[0][j]=j
  for(let i=1;i<=aa.length;i++)for(let j=1;j<=bb.length;j++){
    const c=aa[i-1]===bb[j-1]?0:1
    dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+c)
  }
  return dp[aa.length][bb.length]
}
function sim(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb)return 0
  if(aa.includes(bb)||bb.includes(aa))return .9
  return 1-levenshtein(aa,bb)/Math.max(aa.length,bb.length)
}
const hasLike=(t:string,k:string)=>sim(t,k)>=(k.length<=1?.99:k.length<=2?.82:.68)

function clamp(r:NormalizedRect):NormalizedRect{
  const x=Math.max(0,Math.min(1,r.x)),y=Math.max(0,Math.min(1,r.y))
  const x1=Math.max(x,Math.min(1,r.x+r.width)),y1=Math.max(y,Math.min(1,r.y+r.height))
  return{x,y,width:x1-x,height:y1-y}
}

export function roiTokenToPage(token:OCRToken,roi:NormalizedRect):OCRToken{
  return{
    ...token,
    rect:{
      x:roi.x+token.rect.x*roi.width,
      y:roi.y+token.rect.y*roi.height,
      width:token.rect.width*roi.width,
      height:token.rect.height*roi.height,
    },
  }
}

export function unrotateRect(r:NormalizedRect,rotation:Rotation):NormalizedRect{
  if(rotation===0)return r
  const pts=[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].map(([x,y])=>{
    if(rotation===90)return[y,1-x]
    if(rotation===180)return[1-x,1-y]
    return[1-y,x]
  })
  const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1])
  return clamp({x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)})
}

export function scoreFastText(text:string){
  const t=clean(text)
  let score=0
  const hits:string[]=[]
  const add=(k:string,w:number)=>{if(t.includes(k)){score+=w;hits.push(k)}}
  add('연월일',48)
  add('년월일',45)
  add('매수인',44)
  add('서명',42)
  add('(인)',30)
  add('성명',20)
  add('확인합니다',14)
  if(t.includes('년')&&t.includes('월')&&t.includes('일')){score+=36;hits.push('년·월·일')}
  const hangul=(text.match(/[가-힣]/g)||[]).length
  score+=Math.min(18,hangul/12)
  return{score,hits}
}

function findDateTokens(tokens:OCRToken[]){
  const direct=tokens.filter(t=>hasLike(t.text,'연월일')||hasLike(t.text,'년월일'))
  if(direct.length)return direct

  // fallback: explicit 년 / 월 / 일 close on same row
  const years=tokens.filter(t=>clean(t.text)==='년')
  const months=tokens.filter(t=>clean(t.text)==='월')
  const days=tokens.filter(t=>clean(t.text)==='일')
  const out:OCRToken[]=[]
  for(const y of years){
    const cy=center(y.rect)
    const m=months.find(x=>Math.abs(center(x.rect).y-cy.y)<.03&&center(x.rect).x>cy.x)
    const d=days.find(x=>Math.abs(center(x.rect).y-cy.y)<.03&&center(x.rect).x>(m?center(m.rect).x:cy.x))
    if(m&&d)out.push(y,m,d)
  }
  return out
}

function detectBlankLine(canvas:HTMLCanvasElement,approxY:number){
  // lightweight horizontal dark-pixel scan around the anchor zone
  const ctx=canvas.getContext('2d',{willReadFrequently:true})!
  const img=ctx.getImageData(0,0,canvas.width,canvas.height)
  const d=img.data
  const y0=Math.max(0,Math.floor((approxY-.07)*canvas.height))
  const y1=Math.min(canvas.height-1,Math.ceil((approxY+.09)*canvas.height))
  let best:{y:number,ratio:number}|null=null
  for(let y=y0;y<=y1;y+=2){
    let dark=0
    for(let x=Math.floor(canvas.width*.12);x<Math.floor(canvas.width*.95);x+=3){
      const i=(y*canvas.width+x)*4
      const g=(d[i]+d[i+1]+d[i+2])/3
      if(g<120)dark++
    }
    const ratio=dark/Math.max(1,Math.floor(canvas.width*.83/3))
    if(!best||ratio>best.ratio)best={y,ratio}
  }
  return best&&best.ratio>.06?best.y/canvas.height:null
}

export function detectExactTarget(
  pageTokens:OCRToken[],
  rotation:Rotation,
  precisePageCanvas:HTMLCanvasElement,
):SignatureTarget|null{
  if(!pageTokens.length)return null

  const dateTokens=findDateTokens(pageTokens)
  const signerTokens=pageTokens.filter(t=>
    hasLike(t.text,'매수인')||hasLike(t.text,'서명')||hasLike(t.text,'(인)')||hasLike(t.text,'성명')
  )

  let bestDate:OCRToken|null=null
  let bestSigner:OCRToken|null=null
  let bestPairScore=-Infinity

  // do NOT assume last row. choose the best spatial pair anywhere in the document.
  for(const d of dateTokens){
    for(const s of signerTokens){
      const dc=center(d.rect),sc=center(s.rect)
      const dy=Math.abs(dc.y-sc.y)
      const dx=Math.abs(dc.x-sc.x)
      let score=100-dy*420-dx*45
      if(sc.y>=dc.y-.05&&sc.y<=dc.y+.11)score+=22
      if(d.confidence>60)score+=8
      if(s.confidence>60)score+=8
      if(score>bestPairScore){bestPairScore=score;bestDate=d;bestSigner=s}
    }
  }

  if(!bestDate && dateTokens.length){
    bestDate=[...dateTokens].sort((a,b)=>b.confidence-a.confidence)[0]
  }
  if(!bestSigner && signerTokens.length){
    bestSigner=[...signerTokens].sort((a,b)=>b.confidence-a.confidence)[0]
  }
  if(!bestDate&&!bestSigner)return null

  const anchorY=bestDate?center(bestDate.rect).y:center(bestSigner!.rect).y
  const lineY=detectBlankLine(precisePageCanvas,anchorY)
  const y=lineY??Math.max(0,anchorY-.04)

  let dateRect:NormalizedRect|null=null
  let signerRect:NormalizedRect|null=null

  if(bestDate){
    dateRect=clamp({
      x:Math.max(0,bestDate.rect.x-.055),
      y:Math.max(0,(lineY??bestDate.rect.y)-.045),
      width:Math.min(.68,Math.max(.34,bestDate.rect.width+.36)),
      height:.095,
    })
  }

  if(bestSigner){
    signerRect=clamp({
      x:Math.max(0,bestSigner.rect.x-.07),
      y:Math.max(0,bestSigner.rect.y-.045),
      width:Math.min(.52,Math.max(.24,bestSigner.rect.width+.28)),
      height:.105,
    })
  }

  const xs=[dateRect?.x,signerRect?.x].filter((v):v is number=>v!==undefined&&v!==null)
  const ys=[dateRect?.y,signerRect?.y].filter((v):v is number=>v!==undefined&&v!==null)
  const x1s=[dateRect?dateRect.x+dateRect.width:null,signerRect?signerRect.x+signerRect.width:null].filter((v):v is number=>v!==null)
  const y1s=[dateRect?dateRect.y+dateRect.height:null,signerRect?signerRect.y+signerRect.height:null].filter((v):v is number=>v!==null)

  let unionRect:NormalizedRect
  if(xs.length){
    unionRect=clamp({
      x:Math.min(...xs),
      y:Math.min(...ys),
      width:Math.max(...x1s)-Math.min(...xs),
      height:Math.max(...y1s)-Math.min(...ys),
    })
  }else{
    unionRect=clamp({x:.25,y,width:.5,height:.11})
  }

  return{
    pageIndex:pageTokens[0].pageIndex,
    rotation,
    rect:unrotateRect(unionRect,rotation),
    dateRect:dateRect?unrotateRect(dateRect,rotation):null,
    signerRect:signerRect?unrotateRect(signerRect,rotation):null,
    source:lineY!==null?'line-pair':bestDate?'date-anchor':'buyer-anchor',
    confidence:Math.max(.55,Math.min(.97,bestPairScore/115)),
  }
}
