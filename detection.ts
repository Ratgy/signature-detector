import type {
  OCRToken,
  Rect,
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

  return{
    x:x0,
    y:y0,
    width:x1-x0,
    height:y1-y0
  }
}

function lev(a:string,b:string){
  const aa=clean(a)
  const bb=clean(b)

  const dp=Array.from(
    {length:aa.length+1},
    ()=>Array(bb.length+1).fill(0)
  )

  for(let i=0;i<=aa.length;i++){
    dp[i][0]=i
  }

  for(let j=0;j<=bb.length;j++){
    dp[0][j]=j
  }

  for(let i=1;i<=aa.length;i++){
    for(let j=1;j<=bb.length;j++){
      const cost=
        aa[i-1]===bb[j-1]
          ?0
          :1

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
  const aa=clean(a)
  const bb=clean(b)

  if(!aa||!bb)return 0
  if(aa===bb)return 1

  if(
    aa.includes(bb)||
    bb.includes(aa)
  ){
    return Math.min(
      .99,
      .77+
      Math.min(aa.length,bb.length)/
      Math.max(aa.length,bb.length)*
      .2
    )
  }

  return(
    1-
    lev(aa,bb)/
    Math.max(aa.length,bb.length)
  )
}

interface OCRLine {
  tokens:OCRToken[]
  text:string
  rect:Rect
}

function buildLines(
  tokens:OCRToken[]
):OCRLine[]{
  const sorted=[...tokens].sort(
    (a,b)=>
      cy(a.rect)-cy(b.rect)||
      a.rect.x-b.rect.x
  )

  const groups:OCRToken[][]=[]

  for(const token of sorted){
    let selected:OCRToken[]|null=null
    let bestDy=Infinity

    for(const group of groups){
      const groupY=
        group.reduce(
          (sum,t)=>sum+cy(t.rect),
          0
        )/
        group.length

      const avgHeight=
        group.reduce(
          (sum,t)=>sum+t.rect.height,
          0
        )/
        group.length

      const dy=
        Math.abs(
          cy(token.rect)-groupY
        )

      if(
        dy<
          Math.max(
            .012,
            avgHeight*.8
          ) &&
        dy<bestDy
      ){
        selected=group
        bestDy=dy
      }
    }

    if(selected){
      selected.push(token)
    }else{
      groups.push([token])
    }
  }

  return groups.map(group=>{
    const ordered=
      [...group].sort(
        (a,b)=>a.rect.x-b.rect.x
      )

    return{
      tokens:ordered,
      text:
        ordered
          .map(t=>t.text)
          .join(' '),
      rect:
        union(
          ordered.map(t=>t.rect)
        )
    }
  })
}

function expandedTokens(
  tokens:OCRToken[]
){
  const lines=buildLines(tokens)
  const expanded=[...tokens]

  for(const line of lines){
    const ts=line.tokens

    for(let i=0;i<ts.length;i++){
      for(
        let len=2;
        len<=6 &&
        i+len<=ts.length;
        len++
      ){
        const group=
          ts.slice(i,i+len)

        const badGap=
          group
            .slice(1)
            .some(
              (token,k)=>
                token.rect.x-
                (
                  group[k].rect.x+
                  group[k].rect.width
                )>.065
            )

        if(badGap)break

        expanded.push({
          text:
            group
              .map(t=>t.text)
              .join(''),
          confidence:
            Math.min(
              ...group.map(
                t=>t.confidence
              )
            ),
          pageIndex:
            group[0].pageIndex,
          rect:
            union(
              group.map(t=>t.rect)
            )
        })
      }
    }
  }

  return expanded
}

function buyerScore(text:string){
  const s=clean(text)

  if(s.includes('매수인')){
    return 1
  }

  return sim(s,'매수인')
}

function signerScore(text:string){
  const raw=text
  const s=clean(text)

  if(s.includes('서명또는인')){
    return 1
  }

  if(s.includes('서명')){
    return .96
  }

  if(
    raw.includes('(인)')||
    raw.includes('（인）')||
    raw.includes('[인]')
  ){
    return .82
  }

  // '인' 한 글자만으로는 서명란을 만들지 않는다.
  if(s==='인'){
    return .18
  }

  return Math.max(
    sim(s,'서명')*.9,
    sim(s,'서명또는인')
  )
}

function confirmScore(text:string){
  const s=clean(text)
  let score=0

  if(s.includes('확인')){
    score=Math.max(score,.82)
  }

  if(s.includes('본인은')){
    score=Math.max(score,.7)
  }

  if(s.includes('사실')){
    score=Math.max(score,.5)
  }

  return Math.max(
    score,
    sim(s,'확인합니다')*.78
  )
}

function exactDateUnit(
  text:string,
  unit:'년'|'월'|'일'
){
  const s=clean(text)

  if(unit==='년'){
    return(
      s==='년'||
      s==='연'||
      (
        s.length<=2 &&
        s.includes('년')
      )
    )
  }

  return(
    s===unit||
    (
      s.length<=2 &&
      s.includes(unit)
    )
  )
}

interface DateCluster {
  tokens:OCRToken[]
  rect:Rect
  score:number
  complete:boolean
}

function blankDateClusters(
  tokens:OCRToken[]
):DateCluster[]{
  const lines=buildLines(tokens)
  const clusters:DateCluster[]=[]

  for(const line of lines){
    const lineTokens=line.tokens
    const noDigitTokens=
      lineTokens.filter(
        t=>!/\d/.test(t.text)
      )

    const years=
      noDigitTokens.filter(
        t=>exactDateUnit(t.text,'년')
      )
    const months=
      noDigitTokens.filter(
        t=>exactDateUnit(t.text,'월')
      )
    const days=
      noDigitTokens.filter(
        t=>exactDateUnit(t.text,'일')
      )

    for(const year of years){
      const month=
        months
          .filter(
            t=>
              cx(t.rect)>
                cx(year.rect) &&
              Math.abs(
                cy(t.rect)-
                cy(year.rect)
              )<.035
          )
          .sort(
            (a,b)=>
              cx(a.rect)-cx(b.rect)
          )[0]

      if(!month)continue

      const day=
        days
          .filter(
            t=>
              cx(t.rect)>
                cx(month.rect) &&
              Math.abs(
                cy(t.rect)-
                cy(year.rect)
              )<.035
          )
          .sort(
            (a,b)=>
              cx(a.rect)-cx(b.rect)
          )[0]

      if(day){
        const dateRect=
          union([
            year.rect,
            month.rect,
            day.rect
          ])

        const between=
          lineTokens.filter(t=>{
            const x=cx(t.rect)

            return(
              x>=year.rect.x &&
              x<=
                day.rect.x+
                day.rect.width
            )
          })

        // 핵심 요구사항:
        // 년-월-일 사이에 숫자가 있으면 이미 작성된 날짜.
        if(
          between.some(
            t=>/\d/.test(t.text)
          )
        ){
          continue
        }

        clusters.push({
          tokens:[
            year,
            month,
            day
          ],
          rect:dateRect,
          score:115,
          complete:true
        })

        continue
      }

      // 2/3 날짜 단위 fallback.
      // 이 자체만으로는 성공할 수 없고,
      // 매수인+서명+확인 문맥이 모두 필요하다.
      const partialRect=
        union([
          year.rect,
          month.rect
        ])

      clusters.push({
        tokens:[
          year,
          month
        ],
        rect:partialRect,
        score:58,
        complete:false
      })
    }

    // OCR이 "년 월 일"을 하나로 합친 경우.
    for(const token of lineTokens){
      const s=clean(token.text)

      if(/\d/.test(s)){
        continue
      }

      const y=s.indexOf('년')>=0
        ?s.indexOf('년')
        :s.indexOf('연')
      const m=s.indexOf('월')
      const d=s.indexOf('일')

      if(
        y>=0 &&
        m>y &&
        d>m
      ){
        clusters.push({
          tokens:[token],
          rect:token.rect,
          score:110,
          complete:true
        })
      }
    }
  }

  return clusters
}

function buyerCandidates(
  tokens:OCRToken[]
){
  return tokens
    .map(token=>({
      token,
      score:
        buyerScore(token.text)
    }))
    .filter(
      item=>item.score>=.52
    )
    .sort(
      (a,b)=>b.score-a.score
    )
}

function bestSigner(
  tokens:OCRToken[],
  buyer:OCRToken
){
  return tokens
    .map(token=>({
      token,
      score:
        signerScore(token.text)
    }))
    .filter(
      item=>
        item.score>=.52 &&
        Math.abs(
          cy(item.token.rect)-
          cy(buyer.rect)
        )<.11
    )
    .sort(
      (a,b)=>b.score-a.score
    )[0]
}

function bestConfirmation(
  lines:OCRLine[],
  targetY:number
){
  return lines
    .map(line=>({
      line,
      score:
        Math.max(
          confirmScore(line.text),
          ...line.tokens.map(
            t=>confirmScore(t.text)
          )
        )
    }))
    .filter(item=>{
      const diff=
        targetY-
        cy(item.line.rect)

      return(
        item.score>=.38 &&
        diff>=-.03 &&
        diff<=.30
      )
    })
    .sort(
      (a,b)=>b.score-a.score
    )[0]
}

export function detectTarget(
  tokens:OCRToken[],
  pageIndex:number,
  stripRect:Rect
):TargetCandidate|null{
  if(!tokens.length){
    return null
  }

  const expanded=
    expandedTokens(tokens)

  const lines=
    buildLines(expanded)

  const dates=
    blankDateClusters(expanded)

  const buyers=
    buyerCandidates(expanded)

  if(
    !dates.length||
    !buyers.length
  ){
    return null
  }

  let best:TargetCandidate|null=null

  for(const date of dates){
    const dateY=cy(date.rect)

    for(const buyer of buyers){
      const buyerY=cy(buyer.token.rect)

      if(
        Math.abs(
          dateY-buyerY
        )>.12
      ){
        continue
      }

      const signer=
        bestSigner(
          expanded,
          buyer.token
        )

      const confirmation=
        bestConfirmation(
          lines,
          Math.max(
            dateY,
            buyerY
          )
        )

      if(
        date.complete &&
        !signer &&
        !confirmation
      ){
        continue
      }

      if(
        !date.complete &&
        (
          !signer||
          !confirmation
        )
      ){
        continue
      }

      const rects=[
        date.rect,
        buyer.token.rect
      ]

      if(signer){
        rects.push(
          signer.token.rect
        )
      }

      const local=
        union(rects)

      if(
        local.width>.82||
        local.height>.18
      ){
        continue
      }

      if(
        Math.abs(
          cx(date.rect)-
          cx(buyer.token.rect)
        )>.42
      ){
        continue
      }

      let score=
        date.score+
        buyer.score*95

      if(signer){
        score+=
          signer.score*75
      }

      if(confirmation){
        score+=
          confirmation.score*28
      }

      if(date.complete){
        score+=50
      }

      const left=Math.max(
        0,
        Math.min(
          date.rect.x,
          buyer.token.rect.x
        )-.055
      )

      const signerRight=
        signer
          ?signer.token.rect.x+
            signer.token.rect.width
          :buyer.token.rect.x+
            buyer.token.rect.width

      const right=Math.min(
        1,
        Math.max(
          date.rect.x+
            date.rect.width,
          signerRight
        )+
        (
          signer
            ?.12
            :.22
        )
      )

      const top=Math.max(
        0,
        local.y-.04
      )

      const bottom=Math.min(
        1,
        local.y+
        local.height+
        .055
      )

      const targetLocal={
        x:left,
        y:top,
        width:
          Math.max(
            .18,
            right-left
          ),
        height:
          Math.max(
            .07,
            bottom-top
          )
      }

      const candidate:TargetCandidate={
        pageIndex,
        targetRect:{
          x:
            stripRect.x+
            targetLocal.x*
            stripRect.width,
          y:
            stripRect.y+
            targetLocal.y*
            stripRect.height,
          width:
            targetLocal.width*
            stripRect.width,
          height:
            targetLocal.height*
            stripRect.height
        },
        score,
        confidence:
          Math.max(
            .55,
            Math.min(
              .99,
              score/325
            )
          )
      }

      if(
        !best||
        candidate.score>
          best.score
      ){
        best=candidate
      }
    }
  }

  return best
}
