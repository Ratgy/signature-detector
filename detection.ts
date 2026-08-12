import type { NormalizedRect, OCRToken, SigningBlock } from './types'

const clean=(s:string)=>s.replace(/\s+/g,'').replace(/[.,:;_\-|·()[\]{}]/g,'')
const cx=(r:NormalizedRect)=>r.x+r.width/2
const cy=(r:NormalizedRect)=>r.y+r.height/2

const clamp=(r:NormalizedRect):NormalizedRect=>{
  const x=Math.max(0,Math.min(1,r.x))
  const y=Math.max(0,Math.min(1,r.y))
  const x1=Math.max(x,Math.min(1,r.x+r.width))
  const y1=Math.max(y,Math.min(1,r.y+r.height))
  return{x,y,width:x1-x,height:y1-y}
}

function union(rs:NormalizedRect[]):NormalizedRect{
  const x0=Math.min(...rs.map(r=>r.x))
  const y0=Math.min(...rs.map(r=>r.y))
  const x1=Math.max(...rs.map(r=>r.x+r.width))
  const y1=Math.max(...rs.map(r=>r.y+r.height))
  return{x:x0,y:y0,width:x1-x0,height:y1-y0}
}

function lev(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  const dp=Array.from({length:aa.length+1},()=>Array(bb.length+1).fill(0))
  for(let i=0;i<=aa.length;i++)dp[i][0]=i
  for(let j=0;j<=bb.length;j++)dp[0][j]=j
  for(let i=1;i<=aa.length;i++){
    for(let j=1;j<=bb.length;j++){
      const c=aa[i-1]===bb[j-1]?0:1
      dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+c)
    }
  }
  return dp[aa.length][bb.length]
}

function sim(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb)return 0
  if(aa===bb)return 1
  if(aa.includes(bb)||bb.includes(aa)){
    return Math.min(.99,.76+Math.min(aa.length,bb.length)/Math.max(aa.length,bb.length)*.22)
  }
  return 1-lev(aa,bb)/Math.max(aa.length,bb.length)
}

function isConfirm(t:OCRToken){
  const s=clean(t.text)
  return s.includes('확인')||sim(s,'확인합니다')>=.48||s.includes('본인은')||s.includes('사실')
}

function isBuyer(t:OCRToken){
  const s=clean(t.text)
  return s.includes('매수인')||sim(s,'매수인')>=.50
}

function isSigner(t:OCRToken){
  const s=clean(t.text)
  return s.includes('서명')||s==='인'||s.includes('서명또는인')||sim(s,'서명')>=.52
}

function isYear(t:OCRToken){
  const s=clean(t.text)
  return s==='년'||s==='연'||sim(s,'년')>=.78
}
function isMonth(t:OCRToken){
  const s=clean(t.text)
  return s==='월'||sim(s,'월')>=.80
}
function isDay(t:OCRToken){
  const s=clean(t.text)
  return s==='일'||sim(s,'일')>=.80
}

function containsAnyDigit(text:string){
  return /\d/.test(text)
}

function dateCluster(tokens:OCRToken[]){
  const years=tokens.filter(isYear)
  const months=tokens.filter(isMonth)
  const days=tokens.filter(isDay)
  const clusters:{tokens:OCRToken[];score:number}[]=[]

  for(const y of years){
    const yy=cy(y.rect)
    const m=months
      .filter(t=>Math.abs(cy(t.rect)-yy)<.035 && cx(t.rect)>cx(y.rect))
      .sort((a,b)=>cx(a.rect)-cx(b.rect))[0]
    if(!m)continue

    const d=days
      .filter(t=>Math.abs(cy(t.rect)-yy)<.035 && cx(t.rect)>cx(m.rect))
      .sort((a,b)=>cx(a.rect)-cx(b.rect))[0]
    if(!d)continue

    const between=tokens.filter(t=>{
      const x=cx(t.rect)
      return Math.abs(cy(t.rect)-yy)<.04 &&
        x>cx(y.rect) && x<cx(d.rect)
    })

    // 핵심 조건: 년-월-일 사이에 숫자가 있으면 이미 작성된 날짜로 간주하고 제외.
    if(between.some(t=>containsAnyDigit(t.text)))continue

    const spread=Math.max(
      Math.abs(cy(y.rect)-cy(m.rect)),
      Math.abs(cy(y.rect)-cy(d.rect)),
      Math.abs(cy(m.rect)-cy(d.rect))
    )

    clusters.push({
      tokens:[y,m,d],
      score:100-spread*800
    })
  }

  // single token "년월일 / 연월일"도 허용하되 숫자가 섞이면 제외
  for(const t of tokens){
    const s=clean(t.text)
    if(containsAnyDigit(s))continue
    if(s.includes('년월일')||s.includes('연월일')){
      clusters.push({tokens:[t],score:92})
    }
  }

  return clusters.sort((a,b)=>b.score-a.score)
}

export function detectSigningBlocks(tokens:OCRToken[]):SigningBlock[]{
  const confirms=tokens.filter(isConfirm)
  const buyers=tokens.filter(isBuyer)
  const signers=tokens.filter(isSigner)
  const dates=dateCluster(tokens)

  const candidates:SigningBlock[]=[]

  for(const date of dates){
    const dateRect=union(date.tokens.map(t=>t.rect))
    const dateY=cy(dateRect)

    const nearbyBuyer=buyers
      .filter(b=>Math.abs(cy(b.rect)-dateY)<.11)
      .sort((a,b)=>{
        const da=Math.hypot(cx(a.rect)-cx(dateRect),cy(a.rect)-dateY)
        const db=Math.hypot(cx(b.rect)-cx(dateRect),cy(b.rect)-dateY)
        return da-db
      })[0]
    if(!nearbyBuyer)continue

    const nearbySigner=signers
      .filter(s=>Math.abs(cy(s.rect)-dateY)<.12)
      .sort((a,b)=>{
        const da=Math.hypot(cx(a.rect)-cx(nearbyBuyer.rect),cy(a.rect)-cy(nearbyBuyer.rect))
        const db=Math.hypot(cx(b.rect)-cx(nearbyBuyer.rect),cy(b.rect)-cy(nearbyBuyer.rect))
        return da-db
      })[0]
    if(!nearbySigner)continue

    // confirmation은 최종 crop에는 넣지 않고 semantic score에만 사용.
    const confirm=confirms
      .filter(c=>{
        const dy=dateY-cy(c.rect)
        return dy>=-.03 && dy<=.24
      })
      .sort((a,b)=>Math.abs(dateY-cy(a.rect))-Math.abs(dateY-cy(b.rect)))[0]

    const targetRect=union([
      dateRect,
      nearbyBuyer.rect,
      nearbySigner.rect
    ])

    // v12: 서로 다른 컬럼/서식 조각을 하나의 서명영역으로 합치지 않는다.
    // 실제 입력란은 날짜·매수인·서명 표기가 한 로컬 블록 안에 있어야 한다.
    const centers=[dateRect,nearbyBuyer.rect,nearbySigner.rect].map(cx)
    const centerSpan=Math.max(...centers)-Math.min(...centers)
    if(targetRect.width>.48 || targetRect.height>.145 || centerSpan>.40) continue

    // 날짜와 매수인/서명 사이가 지나치게 멀면 다른 영역의 OCR 토큰으로 판단.
    if(Math.abs(cx(dateRect)-cx(nearbyBuyer.rect))>.34) continue
    if(Math.abs(cx(nearbyBuyer.rect)-cx(nearbySigner.rect))>.34) continue

    let score=210+date.score
    score+=Math.min(20,nearbyBuyer.confidence*.2)
    score+=Math.min(18,nearbySigner.confidence*.18)

    if(confirm)score+=35

    // 같은 row에 가까울수록 강한 후보
    const spreadY=Math.max(
      Math.abs(cy(dateRect)-cy(nearbyBuyer.rect)),
      Math.abs(cy(dateRect)-cy(nearbySigner.rect)),
      Math.abs(cy(nearbyBuyer.rect)-cy(nearbySigner.rect))
    )
    score-=spreadY*180

    // 작고 응집된 입력 블록을 강하게 우선한다.
    score += Math.max(0, 42-targetRect.width*70)
    score += Math.max(0, 24-targetRect.height*100)

    candidates.push({
      pageIndex:date.tokens[0].pageIndex,
      rect:clamp(targetRect),
      confidence:Math.max(.35,Math.min(.99,score/330)),
      score
    })
  }

  return candidates.sort((a,b)=>b.score-a.score).slice(0,3)
}

export function scoreFastPageText(text:string){
  const s=clean(text)
  let score=0

  const hasDate=
    s.includes('년월일')||
    s.includes('연월일')||
    (s.includes('년')&&s.includes('월')&&s.includes('일'))

  const hasBuyer=s.includes('매수인')
  const hasSign=s.includes('서명')||s.includes('서명또는인')||s.includes('(인)')
  const hasConfirm=s.includes('확인')||s.includes('본인은')||s.includes('사실')

  if(hasDate)score+=80
  if(hasBuyer)score+=105
  if(hasSign)score+=85
  if(hasConfirm)score+=30

  if(hasDate&&hasBuyer)score+=95
  if(hasBuyer&&hasSign)score+=105
  if(hasDate&&hasBuyer&&hasSign)score+=150

  return score
}
