import type { OCRToken, Rect, TargetCandidate } from './types'

const clean=(s:string)=>
  s.replace(/\s+/g,'')
   .replace(/[.,:;_\-|·()[\]{}]/g,'')

const cx=(r:Rect)=>r.x+r.width/2
const cy=(r:Rect)=>r.y+r.height/2

function union(rs:Rect[]):Rect{
  const x0=Math.min(...rs.map(r=>r.x))
  const y0=Math.min(...rs.map(r=>r.y))
  const x1=Math.max(...rs.map(r=>r.x+r.width))
  const y1=Math.max(...rs.map(r=>r.y+r.height))
  return{x:x0,y:y0,width:x1-x0,height:y1-y0}
}

function lev(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  const dp=Array.from(
    {length:aa.length+1},
    ()=>Array(bb.length+1).fill(0)
  )

  for(let i=0;i<=aa.length;i++)dp[i][0]=i
  for(let j=0;j<=bb.length;j++)dp[0][j]=j

  for(let i=1;i<=aa.length;i++){
    for(let j=1;j<=bb.length;j++){
      const c=aa[i-1]===bb[j-1]?0:1
      dp[i][j]=Math.min(
        dp[i-1][j]+1,
        dp[i][j-1]+1,
        dp[i-1][j-1]+c
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
    return Math.min(
      .99,
      .76+
      Math.min(aa.length,bb.length)/
      Math.max(aa.length,bb.length)*.22
    )
  }
  return 1-lev(aa,bb)/Math.max(aa.length,bb.length)
}

function buildLines(tokens:OCRToken[]){
  const sorted=[...tokens].sort(
    (a,b)=>cy(a.rect)-cy(b.rect)||a.rect.x-b.rect.x
  )

  const groups:OCRToken[][]=[]

  for(const token of sorted){
    let best:OCRToken[]|null=null
    let bestDy=Infinity

    for(const group of groups){
      const gy=group.reduce((s,t)=>s+cy(t.rect),0)/group.length
      const avgH=group.reduce((s,t)=>s+t.rect.height,0)/group.length
      const dy=Math.abs(cy(token.rect)-gy)

      if(dy<Math.max(.014,avgH*.82)&&dy<bestDy){
        best=group
        bestDy=dy
      }
    }

    if(best)best.push(token)
    else groups.push([token])
  }

  return groups.map(tokens=>({
    tokens:[...tokens].sort((a,b)=>a.rect.x-b.rect.x),
    rect:union(tokens.map(t=>t.rect)),
    text:[...tokens]
      .sort((a,b)=>a.rect.x-b.rect.x)
      .map(t=>t.text)
      .join(' ')
  }))
}


function expandedTokens(tokens:OCRToken[]){
  const lines=buildLines(tokens)
  const out=[...tokens]

  for(const line of lines){
    const ts=line.tokens

    for(let i=0;i<ts.length;i++){
      for(
        let len=2;
        len<=5 && i+len<=ts.length;
        len++
      ){
        const group=ts.slice(i,i+len)

        // 단어 사이가 너무 먼 경우 같은 phrase로 합치지 않는다.
        const badGap=group
          .slice(1)
          .some((t,k)=>
            t.rect.x-
            (
              group[k].rect.x+
              group[k].rect.width
            )>.07
          )

        if(badGap)break

        const rect=union(
          group.map(t=>t.rect)
        )

        out.push({
          text:group.map(t=>t.text).join(''),
          confidence:Math.min(
            ...group.map(t=>t.confidence)
          ),
          pageIndex:group[0].pageIndex,
          rect
        })
      }
    }
  }

  return out
}

function tokenBuyerScore(text:string){
  const s=clean(text)
  if(s.includes('매수인'))return 1
  return sim(s,'매수인')
}

function tokenSignScore(text:string){
  const s=clean(text)
  if(s.includes('서명또는인'))return 1
  if(s.includes('서명'))return .95
  if(s==='인')return .55
  return Math.max(sim(s,'서명'),sim(s,'서명또는인'))
}

function tokenConfirmScore(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('확인'))score=.8
  if(s.includes('본인은'))score=Math.max(score,.65)
  if(s.includes('사실'))score=Math.max(score,.45)
  return Math.max(score,sim(s,'확인합니다')*.8)
}

function isDateUnit(text:string,unit:'년'|'월'|'일'){
  const s=clean(text)
  if(s===unit)return true
  // '연' 오인식은 년으로만 제한적으로 허용.
  if(unit==='년'&&s==='연')return true
  return sim(s,unit)>=.78
}

function findBlankDateCluster(tokens:OCRToken[]){
  const years=tokens.filter(t=>isDateUnit(t.text,'년'))
  const months=tokens.filter(t=>isDateUnit(t.text,'월'))
  const days=tokens.filter(t=>isDateUnit(t.text,'일'))

  const clusters:{tokens:OCRToken[];rect:Rect;score:number}[]=[]

  for(const y of years){
    const yy=cy(y.rect)

    const m=months
      .filter(t=>
        Math.abs(cy(t.rect)-yy)<.04 &&
        cx(t.rect)>cx(y.rect)
      )
      .sort((a,b)=>cx(a.rect)-cx(b.rect))[0]

    if(!m)continue

    const d=days
      .filter(t=>
        Math.abs(cy(t.rect)-yy)<.04 &&
        cx(t.rect)>cx(m.rect)
      )
      .sort((a,b)=>cx(a.rect)-cx(b.rect))[0]

    if(!d)continue

    const rect=union([y.rect,m.rect,d.rect])

    // 사용자 요구: 년/월/일 사이에 숫자가 하나라도 있으면 이미 작성된 날짜.
    const between=tokens.filter(t=>{
      const x=cx(t.rect)
      return Math.abs(cy(t.rect)-yy)<.045 &&
        x>=y.rect.x &&
        x<=d.rect.x+d.rect.width
    })

    if(between.some(t=>/\d/.test(t.text)))continue

    clusters.push({
      tokens:[y,m,d],
      rect,
      score:100-
        Math.max(
          Math.abs(cy(y.rect)-cy(m.rect)),
          Math.abs(cy(y.rect)-cy(d.rect))
        )*600
    })
  }

  // OCR이 '년 월 일'을 하나의 token/line으로 합친 경우.
  for(const t of tokens){
    const s=clean(t.text)
    if(/\d/.test(s))continue
    if(s.includes('년월일')||s.includes('연월일')){
      clusters.push({
        tokens:[t],
        rect:t.rect,
        score:88
      })
    }
  }

  return clusters.sort((a,b)=>b.score-a.score)
}

function findBuyerAndSigner(lines:ReturnType<typeof buildLines>){
  const pairs:{
    buyer:OCRToken
    signer:OCRToken|null
    lineRect:Rect
    score:number
  }[]=[]

  for(const line of lines){
    const buyers=line.tokens
      .map(t=>({token:t,score:tokenBuyerScore(t.text)}))
      .filter(x=>x.score>=.44)
      .sort((a,b)=>b.score-a.score)

    if(!buyers.length)continue

    const signs=line.tokens
      .map(t=>({token:t,score:tokenSignScore(t.text)}))
      .filter(x=>x.score>=.43)
      .sort((a,b)=>b.score-a.score)

    for(const b of buyers){
      // '인' 단독은 매수인 근처일 때만 signer로 인정.
      let signer=signs.find(s=>{
        if(clean(s.token.text)!=='인')return true
        return Math.abs(cx(s.token.rect)-cx(b.token.rect))<.35
      })?.token ?? null

      let score=b.score*80
      if(signer)score+=tokenSignScore(signer.text)*55

      pairs.push({
        buyer:b.token,
        signer,
        lineRect:line.rect,
        score
      })
    }
  }

  return pairs.sort((a,b)=>b.score-a.score)
}

export function detectTarget(
  tokens:OCRToken[],
  pageIndex:number,
  regionRect:Rect
):TargetCandidate|null{
  if(!tokens.length)return null

  const expanded=expandedTokens(tokens)
  const lines=buildLines(expanded)
  const dates=findBlankDateCluster(expanded)
  const buyerPairs=findBuyerAndSigner(lines)

  let best:TargetCandidate|null=null

  for(const date of dates){
    const dateY=cy(date.rect)

    for(const pair of buyerPairs){
      const buyerY=cy(pair.buyer.rect)
      const dy=Math.abs(dateY-buyerY)

      // 같은 작성 행 또는 바로 인접한 행만 허용.
      if(dy>.115)continue

      const parts=[date.rect,pair.buyer.rect]
      if(pair.signer)parts.push(pair.signer.rect)

      const local=union(parts)

      // 이 검사는 이미 논리 페이지/ROI 내부에서 수행된다.
      // 따라서 서명블록 자체가 ROI의 절반 이상을 차지하면 오탐으로 본다.
      if(local.width>.72||local.height>.22)continue

      // blank date와 매수인이 너무 멀면 다른 줄을 섞은 것.
      if(Math.abs(cx(date.rect)-cx(pair.buyer.rect))>.48)continue

      // confirmation 문장은 후보 위쪽 근처에 있으면 가점만.
      const confirm=lines
        .map(line=>({
          line,
          score:Math.max(
            ...line.tokens.map(t=>tokenConfirmScore(t.text)),
            tokenConfirmScore(line.text)
          )
        }))
        .filter(x=>{
          const diff=dateY-cy(x.line.rect)
          return x.score>=.35 && diff>=-.02 && diff<=.28
        })
        .sort((a,b)=>b.score-a.score)[0]

      let score=150+date.score+pair.score
      if(pair.signer)score+=35
      if(confirm)score+=confirm.score*35

      // 하단에 있는 빈 매수인 서명란을 우선.
      score+=dateY*35

      // target crop: 확인 문장은 제외하고 실제 작성영역만.
      let target=local

      // 서명 OCR은 성공했지만 실제 사인 공간은 텍스트 오른쪽에 더 있다.
      // 매수인/서명 위치 기준으로 작성 여백까지 포함한다.
      const left=Math.max(
        0,
        Math.min(date.rect.x,pair.buyer.rect.x)-.045
      )
      const right=Math.min(
        1,
        Math.max(
          date.rect.x+date.rect.width,
          pair.signer
            ?pair.signer.rect.x+pair.signer.rect.width+.15
            :pair.buyer.rect.x+pair.buyer.rect.width+.24
        )
      )
      const top=Math.max(0,target.y-.035)
      const bottom=Math.min(
        1,
        target.y+target.height+.045
      )

      target={
        x:left,
        y:top,
        width:right-left,
        height:bottom-top
      }

      const candidate:TargetCandidate={
        pageIndex,
        region:regionRect,
        targetRect:{
          x:regionRect.x+target.x*regionRect.width,
          y:regionRect.y+target.y*regionRect.height,
          width:target.width*regionRect.width,
          height:target.height*regionRect.height
        },
        score,
        confidence:Math.max(
          .45,
          Math.min(.99,score/330)
        )
      }

      if(!best||candidate.score>best.score){
        best=candidate
      }
    }
  }

  // OCR이 년/월/일 중 하나를 놓친 경우:
  // 매수인 + 서명 + 확인문장이 강하게 잡히면 row 자체를 fallback 후보로 인정.
  if(!best){
    for(const pair of buyerPairs){
      if(!pair.signer)continue

      const y=cy(pair.lineRect)
      const confirm=lines
        .map(line=>({
          line,
          score:tokenConfirmScore(line.text)
        }))
        .filter(x=>{
          const diff=y-cy(x.line.rect)
          return x.score>=.45&&diff>=-.02&&diff<=.24
        })
        .sort((a,b)=>b.score-a.score)[0]

      if(!confirm)continue

      // 숫자가 같은 줄에 많으면 이미 작성된 검사자 영역 가능성이 높으므로 제외.
      const row=lines.find(l=>
        Math.abs(cy(l.rect)-cy(pair.lineRect))<.006 &&
        Math.abs(l.rect.x-pair.lineRect.x)<.006
      )
      if((row?.tokens ?? []).some(t=>/\d{2,}/.test(t.text)))continue

      const left=Math.max(0,pair.lineRect.x-.36)
      const right=Math.min(
        1,
        (pair.signer.rect.x+pair.signer.rect.width)+.16
      )

      const local={
        x:left,
        y:Math.max(0,pair.lineRect.y-.035),
        width:right-left,
        height:Math.min(.16,pair.lineRect.height+.075)
      }

      const score=190+pair.score+confirm.score*25+y*30

      best={
        pageIndex,
        region:regionRect,
        targetRect:{
          x:regionRect.x+local.x*regionRect.width,
          y:regionRect.y+local.y*regionRect.height,
          width:local.width*regionRect.width,
          height:local.height*regionRect.height
        },
        score,
        confidence:Math.min(.88,score/330)
      }
    }
  }

  return best
}


export function scoreRegionHints(tokens:OCRToken[]){
  const expanded=expandedTokens(tokens)
  let buyer=0,sign=0,date=0,confirm=0

  for(const t of expanded){
    buyer=Math.max(buyer,tokenBuyerScore(t.text))
    sign=Math.max(sign,tokenSignScore(t.text))
    confirm=Math.max(confirm,tokenConfirmScore(t.text))
  }

  const dates=findBlankDateCluster(expanded)
  if(dates.length)date=Math.min(1,dates[0].score/100)

  // 매수인/서명/빈 날짜를 가장 강하게 보고 확인 문구는 보조로만 사용.
  return buyer*42+sign*34+date*48+confirm*10
}
