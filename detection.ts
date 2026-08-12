import type {
  OCRToken,
  Rect,
  ScanAssessment,
  TargetCandidate
} from './types'

const clean=(s:string)=>
  s.replace(/\s+/g,'')
   .replace(/[.,:;_\-|·()[\]{}]/g,'')

const cx=(r:Rect)=>r.x+r.width/2
const cy=(r:Rect)=>r.y+r.height/2

function union(rects:Rect[]):Rect{
  const x0=Math.min(...rects.map(r=>r.x))
  const y0=Math.min(...rects.map(r=>r.y))
  const x1=Math.max(...rects.map(r=>r.x+r.width))
  const y1=Math.max(...rects.map(r=>r.y+r.height))
  return{x:x0,y:y0,width:x1-x0,height:y1-y0}
}

function clamp(r:Rect):Rect{
  const x=Math.max(0,Math.min(1,r.x))
  const y=Math.max(0,Math.min(1,r.y))
  const x1=Math.max(x,Math.min(1,r.x+r.width))
  const y1=Math.max(y,Math.min(1,r.y+r.height))
  return{x,y,width:x1-x,height:y1-y}
}

function lev(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  const dp=Array.from({length:aa.length+1},()=>Array(bb.length+1).fill(0))
  for(let i=0;i<=aa.length;i++)dp[i][0]=i
  for(let j=0;j<=bb.length;j++)dp[0][j]=j
  for(let i=1;i<=aa.length;i++){
    for(let j=1;j<=bb.length;j++){
      const cost=aa[i-1]===bb[j-1]?0:1
      dp[i][j]=Math.min(
        dp[i-1][j]+1,
        dp[i][j-1]+1,
        dp[i-1][j-1]+cost
      )
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

interface OCRLine {
  tokens:OCRToken[]
  text:string
  rect:Rect
}

function buildLines(tokens:OCRToken[]):OCRLine[]{
  const sorted=[...tokens].sort(
    (a,b)=>cy(a.rect)-cy(b.rect)||a.rect.x-b.rect.x
  )
  const groups:OCRToken[][]=[]

  for(const token of sorted){
    let chosen:OCRToken[]|null=null
    let bestDy=Infinity

    for(const group of groups){
      const gy=group.reduce((s,t)=>s+cy(t.rect),0)/group.length
      const avgH=group.reduce((s,t)=>s+t.rect.height,0)/group.length
      const dy=Math.abs(cy(token.rect)-gy)
      if(dy<Math.max(.014,avgH*.85)&&dy<bestDy){
        chosen=group
        bestDy=dy
      }
    }

    if(chosen)chosen.push(token)
    else groups.push([token])
  }

  return groups.map(group=>{
    const ordered=[...group].sort((a,b)=>a.rect.x-b.rect.x)
    return{
      tokens:ordered,
      text:ordered.map(t=>t.text).join(' '),
      rect:union(ordered.map(t=>t.rect))
    }
  })
}

function expandedTokens(tokens:OCRToken[]){
  const out=[...tokens]
  const lines=buildLines(tokens)

  for(const line of lines){
    const ts=line.tokens
    for(let i=0;i<ts.length;i++){
      for(let len=2;len<=6&&i+len<=ts.length;len++){
        const group=ts.slice(i,i+len)
        const badGap=group.slice(1).some((t,k)=>
          t.rect.x-(group[k].rect.x+group[k].rect.width)>.075
        )
        if(badGap)break
        out.push({
          text:group.map(t=>t.text).join(''),
          confidence:Math.min(...group.map(t=>t.confidence)),
          pageIndex:group[0].pageIndex,
          rect:union(group.map(t=>t.rect))
        })
      }
    }
  }

  return out
}

function buyerScore(text:string){
  const s=clean(text)
  if(s.includes('매수인'))return 1
  return Math.max(
    sim(s,'매수인'),
    sim(s,'매수언')*.92,
    sim(s,'떠수인')*.9
  )
}

function signerScore(text:string){
  const raw=text
  const s=clean(text)
  if(s.includes('서명또는인'))return 1
  if(s.includes('서명'))return .96
  if(raw.includes('(인)')||raw.includes('（인）'))return .84
  return Math.max(sim(s,'서명')*.9,sim(s,'서명또는인'))
}

function confirmScore(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('확인'))score=.92
  if(s.includes('본인은')||s.includes('분인은'))score=Math.max(score,.72)
  if(s.includes('사실')||s.includes('사살')||s.includes('사실물'))score=Math.max(score,.58)
  score=Math.max(
    score,
    sim(s,'확인합니다')*.82,
    sim(s,'사실을확인합니다')*.78
  )
  return score
}

function isUnit(text:string,unit:'년'|'월'|'일'){
  const s=clean(text)
  if(unit==='년'){
    return s==='년'||s==='연'||(s.length<=2&&s.includes('년'))
  }
  if(unit==='월'){
    return s==='월'||s==='원'||(s.length<=2&&s.includes('월'))
  }
  return s==='일'||(s.length<=2&&s.includes('일'))
}

interface DateCluster {
  rect:Rect
  score:number
  complete:boolean
}

function blankDateClusters(tokens:OCRToken[]):DateCluster[]{
  const lines=buildLines(tokens)
  const result:DateCluster[]=[]

  for(const line of lines){
    const withoutNumbers=line.tokens.filter(t=>!/\d/.test(t.text))
    const years=withoutNumbers.filter(t=>isUnit(t.text,'년'))
    const months=withoutNumbers.filter(t=>isUnit(t.text,'월'))
    const days=withoutNumbers.filter(t=>isUnit(t.text,'일'))

    for(const y of years){
      const m=months
        .filter(t=>cx(t.rect)>cx(y.rect)&&Math.abs(cy(t.rect)-cy(y.rect))<.045)
        .sort((a,b)=>cx(a.rect)-cx(b.rect))[0]
      if(!m)continue

      const d=days
        .filter(t=>cx(t.rect)>cx(m.rect)&&Math.abs(cy(t.rect)-cy(y.rect))<.045)
        .sort((a,b)=>cx(a.rect)-cx(b.rect))[0]

      if(d){
        const rect=union([y.rect,m.rect,d.rect])
        const between=line.tokens.filter(t=>{
          const x=cx(t.rect)
          return x>=y.rect.x&&x<=d.rect.x+d.rect.width
        })
        if(between.some(t=>/\d/.test(t.text)))continue
        result.push({rect,score:118,complete:true})
      }else{
        result.push({rect:union([y.rect,m.rect]),score:55,complete:false})
      }
    }

    for(const token of line.tokens){
      const s=clean(token.text)
      if(/\d/.test(s))continue
      const yi=Math.max(s.indexOf('년'),s.indexOf('연'))
      const mi=Math.max(s.indexOf('월'),s.indexOf('원'))
      const di=s.indexOf('일')
      if(yi>=0&&mi>yi&&di>mi){
        result.push({rect:token.rect,score:112,complete:true})
      }
    }
  }

  return result
}

function bestConfirmLine(lines:OCRLine[],targetY:number){
  return lines
    .map(line=>({
      line,
      score:Math.max(
        confirmScore(line.text),
        ...line.tokens.map(t=>confirmScore(t.text))
      )
    }))
    .filter(item=>{
      const dy=targetY-cy(item.line.rect)
      return item.score>=.42&&dy>=-.035&&dy<=.27
    })
    .sort((a,b)=>b.score-a.score)[0]
}

function makeTargetRow(
  dateRect:Rect|null,
  buyer:OCRToken|null,
  signer:OCRToken|null,
  fallbackLine:Rect|null
){
  const rects:Rect[]=[]
  if(dateRect)rects.push(dateRect)
  if(buyer)rects.push(buyer.rect)
  if(signer)rects.push(signer.rect)
  // buyer/sign OCR fallback에서는 날짜 글자가 깨져도 같은 행의 왼쪽 공간을 포함해야 한다.
  if(fallbackLine)rects.push(fallbackLine)

  const core=union(rects)
  const left=Math.max(0,(dateRect?.x ?? core.x)-.045)
  const right=Math.min(
    1,
    Math.max(
      core.x+core.width,
      signer
        ?signer.rect.x+signer.rect.width+.16
        :buyer
          ?buyer.rect.x+buyer.rect.width+.26
          :core.x+Math.max(core.width,.58)
    )
  )

  return clamp({
    x:left,
    y:Math.max(0,core.y-.035),
    width:Math.max(.22,right-left),
    height:Math.max(.075,Math.min(.18,core.height+.075))
  })
}

export function assessTokens(
  tokensInput:OCRToken[],
  pageIndex:number
):ScanAssessment{
  const tokens=expandedTokens(tokensInput)
  const lines=buildLines(tokens)
  const dates=blankDateClusters(tokens)

  const buyers=tokens
    .map(token=>({token,score:buyerScore(token.text)}))
    .filter(x=>x.score>=.44)
    .sort((a,b)=>b.score-a.score)

  const signers=tokens
    .map(token=>({token,score:signerScore(token.text)}))
    .filter(x=>x.score>=.44)
    .sort((a,b)=>b.score-a.score)

  const confirmMax=Math.max(
    0,
    ...lines.map(line=>Math.max(
      confirmScore(line.text),
      ...line.tokens.map(t=>confirmScore(t.text))
    ))
  )

  let hintScore=
    dates.length*35+
    (buyers[0]?.score ?? 0)*38+
    (signers[0]?.score ?? 0)*34+
    confirmMax*24

  let best:TargetCandidate|null=null

  // 1) 가장 강한 정확 패턴: 빈 년월일 + 매수인 + 서명.
  for(const date of dates){
    for(const buyer of buyers.slice(0,8)){
      const dy=Math.abs(cy(date.rect)-cy(buyer.token.rect))
      if(dy>.12)continue

      const signer=signers.find(s=>
        Math.abs(cy(s.token.rect)-cy(buyer.token.rect))<.12&&
        Math.abs(cx(s.token.rect)-cx(buyer.token.rect))<.55
      )

      if(!signer)continue
      if(Math.abs(cx(date.rect)-cx(buyer.token.rect))>.5)continue

      const confirmation=bestConfirmLine(lines,cy(date.rect))
      let score=190+date.score+buyer.score*85+signer.score*68
      if(confirmation)score+=confirmation.score*30
      if(date.complete)score+=35

      const target:TargetCandidate={
        pageIndex,
        targetRect:makeTargetRow(date.rect,buyer.token,signer.token,null),
        score,
        confidence:Math.min(.99,Math.max(.76,score/420)),
        mode:'exact'
      }

      if(!best||target.score>best.score)best=target
    }
  }

  // 2) 촬영 JPG 복구: 매수인 + 서명은 읽혔는데 년/월/일 일부가 깨진 경우.
  if(!best){
    for(const buyer of buyers.slice(0,8)){
      const signer=signers.find(s=>
        Math.abs(cy(s.token.rect)-cy(buyer.token.rect))<.115&&
        Math.abs(cx(s.token.rect)-cx(buyer.token.rect))<.55
      )
      if(!signer)continue

      const rowY=(cy(buyer.token.rect)+cy(signer.token.rect))/2
      const confirmation=bestConfirmLine(lines,rowY)
      if(!confirmation||confirmation.score<.5)continue

      const row=lines
        .filter(line=>Math.abs(cy(line.rect)-rowY)<.055)
        .sort((a,b)=>Math.abs(cy(a.rect)-rowY)-Math.abs(cy(b.rect)-rowY))[0]

      if(!row)continue
      if(row.tokens.some(t=>/\d{2,}/.test(t.text)))continue

      const target:TargetCandidate={
        pageIndex,
        targetRect:makeTargetRow(null,buyer.token,signer.token,{
          x:Math.max(0,row.rect.x-.28),
          y:row.rect.y,
          width:Math.min(1,row.rect.width+.28),
          height:row.rect.height
        }),
        score:250+buyer.score*70+signer.score*55+confirmation.score*35,
        confidence:.82,
        mode:'buyer-sign'
      }
      if(!best||target.score>best.score)best=target
    }
  }

  // 3) 오래된/저화질 스캔 복구: 확인문장 바로 아래의 '숫자 없는 년월일' 행.
  // 매수인 OCR이 망가져도 이 관계는 샘플에서 안정적이다.
  if(!best){
    for(const date of dates.filter(d=>d.complete)){
      const confirmation=bestConfirmLine(lines,cy(date.rect))
      if(!confirmation||confirmation.score<.58)continue

      const dy=cy(date.rect)-cy(confirmation.line.rect)
      if(dy<0||dy>.17)continue

      const target:TargetCandidate={
        pageIndex,
        targetRect:makeTargetRow(date.rect,null,null,{
          x:date.rect.x,
          y:date.rect.y,
          width:Math.min(.68,1-date.rect.x),
          height:date.rect.height
        }),
        score:220+date.score+confirmation.score*55,
        confidence:.74,
        mode:'confirm-date'
      }
      if(!best||target.score>best.score)best=target
    }
  }

  if(best)hintScore=Math.max(hintScore,best.score)
  return{target:best,hintScore}
}
