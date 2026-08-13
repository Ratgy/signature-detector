import type {
  OCRLine,
  OCRToken,
  Rect,
  ScanAssessment,
  TargetCandidate
} from './types'

const clamp=(v:number)=>
  Math.max(0,Math.min(1,v))

const cx=(r:Rect)=>
  r.x+r.width/2

const cy=(r:Rect)=>
  r.y+r.height/2

function union(rects:Rect[]):Rect{
  const x0=Math.min(
    ...rects.map(r=>r.x)
  )
  const y0=Math.min(
    ...rects.map(r=>r.y)
  )
  const x1=Math.max(
    ...rects.map(
      r=>r.x+r.width
    )
  )
  const y1=Math.max(
    ...rects.map(
      r=>r.y+r.height
    )
  )

  return{
    x:x0,
    y:y0,
    width:x1-x0,
    height:y1-y0
  }
}

function normalizeText(text:string){
  return text
    .replace(/\s+/g,'')
    .replace(
      /[.,:;_\-|·()[\]{}"'`~]/g,
      ''
    )
}

function levenshtein(
  a:string,
  b:string
){
  const aa=normalizeText(a)
  const bb=normalizeText(b)

  const dp=
    Array.from(
      {length:aa.length+1},
      ()=>Array(
        bb.length+1
      ).fill(0)
    )

  for(
    let i=0;
    i<=aa.length;
    i++
  )dp[i][0]=i

  for(
    let j=0;
    j<=bb.length;
    j++
  )dp[0][j]=j

  for(
    let i=1;
    i<=aa.length;
    i++
  ){
    for(
      let j=1;
      j<=bb.length;
      j++
    ){
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

  return dp[
    aa.length
  ][
    bb.length
  ]
}

function similarity(
  a:string,
  b:string
){
  const aa=normalizeText(a)
  const bb=normalizeText(b)

  if(!aa||!bb)return 0
  if(aa===bb)return 1

  if(
    aa.includes(bb)||
    bb.includes(aa)
  ){
    return Math.min(
      .99,
      .78+
      Math.min(
        aa.length,
        bb.length
      )/
      Math.max(
        aa.length,
        bb.length
      )*.2
    )
  }

  return 1-
    levenshtein(
      aa,
      bb
    )/
    Math.max(
      aa.length,
      bb.length
    )
}

export function buildLines(
  tokens:OCRToken[]
):OCRLine[]{
  const sorted=[
    ...tokens
  ].sort(
    (a,b)=>
      cy(a.rect)-
      cy(b.rect)||
      a.rect.x-b.rect.x
  )

  const groups:
    OCRToken[][]=[]

  for(const token of sorted){
    let selected:
      OCRToken[]|null=null
    let bestDistance=
      Infinity

    for(const group of groups){
      const groupY=
        group.reduce(
          (sum,item)=>
            sum+cy(item.rect),
          0
        )/
        group.length

      const avgHeight=
        group.reduce(
          (sum,item)=>
            sum+
            item.rect.height,
          0
        )/
        group.length

      const dy=
        Math.abs(
          cy(token.rect)-
          groupY
        )

      if(
        dy<
          Math.max(
            .011,
            avgHeight*.72
          )&&
        dy<bestDistance
      ){
        selected=group
        bestDistance=dy
      }
    }

    if(selected){
      selected.push(token)
    }else{
      groups.push([token])
    }
  }

  return groups
    .map(group=>{
      const ordered=[
        ...group
      ].sort(
        (a,b)=>
          a.rect.x-b.rect.x
      )

      return{
        text:
          ordered
            .map(t=>t.text)
            .join(' '),
        confidence:
          ordered.reduce(
            (sum,t)=>
              sum+t.confidence,
            0
          )/
          ordered.length,
        rect:
          union(
            ordered.map(
              t=>t.rect
            )
          ),
        tokens:ordered
      }
    })
    .sort(
      (a,b)=>
        a.rect.y-b.rect.y
    )
}

function expandedTokens(
  tokens:OCRToken[],
  lines:OCRLine[]
){
  const out=[
    ...tokens
  ]

  for(const line of lines){
    const items=line.tokens

    for(
      let i=0;
      i<items.length;
      i++
    ){
      for(
        let length=2;
        length<=5&&
        i+length<=items.length;
        length++
      ){
        const group=
          items.slice(
            i,
            i+length
          )

        const badGap=
          group
            .slice(1)
            .some(
              (token,index)=>
                token.rect.x-
                (
                  group[index].rect.x+
                  group[index].rect.width
                )>.055
            )

        if(badGap)break

        out.push({
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
              group.map(
                t=>t.rect
              )
            )
        })
      }
    }
  }

  return out
}

function buyerScore(
  text:string
){
  const value=
    normalizeText(text)

  if(
    value.includes(
      '매수인'
    )
  )return 1

  return Math.max(
    similarity(
      value,
      '매수인'
    ),
    similarity(
      value,
      '매수언'
    )*.9,
    similarity(
      value,
      '매수입'
    )*.86
  )
}

function signerScore(
  text:string
){
  const value=
    normalizeText(text)

  if(
    value.includes(
      '서명또는인'
    )
  )return 1

  if(
    value.includes(
      '서명'
    )
  )return .94

  if(
    value==='인'
  )return .48

  return Math.max(
    similarity(
      value,
      '서명'
    )*.92,
    similarity(
      value,
      '서명또는인'
    )
  )
}

function confirmScore(
  text:string
){
  const value=
    normalizeText(text)

  let score=0

  if(
    value.includes(
      '확인'
    )
  )score=.92

  if(
    value.includes(
      '본인은'
    )
  )score=Math.max(
    score,
    .72
  )

  if(
    value.includes(
      '사실'
    )
  )score=Math.max(
    score,
    .58
  )

  return Math.max(
    score,
    similarity(
      value,
      '확인합니다'
    )*.82
  )
}

function unitKind(
  text:string
):
  'year'|
  'month'|
  'day'|
  null
{
  const value=
    normalizeText(text)

  if(
    value==='년'||
    value==='연'
  )return 'year'

  if(
    value==='월'||
    value==='원'
  )return 'month'

  if(
    value==='일'
  )return 'day'

  return null
}


interface DateCandidate {
  rect:Rect
  score:number
  line:OCRLine
  filled:boolean
}

function dateCandidates(
  lines:OCRLine[],
  expanded:OCRToken[]
){
  const result:DateCandidate[]=[]

  for(const line of lines){
    const normalized=
      normalizeText(line.text)

    const units=
      line.tokens
        .map(token=>({
          token,
          kind:unitKind(token.text)
        }))
        .filter(item=>item.kind)

    const years=units.filter(
      item=>item.kind==='year'
    )
    const months=units.filter(
      item=>item.kind==='month'
    )
    const days=units.filter(
      item=>item.kind==='day'
    )

    for(const year of years){
      const month=months
        .filter(item=>
          cx(item.token.rect)>
          cx(year.token.rect)
        )
        .sort((a,b)=>
          a.token.rect.x-
          b.token.rect.x
        )[0]

      if(!month)continue

      const day=days
        .filter(item=>
          cx(item.token.rect)>
          cx(month.token.rect)
        )
        .sort((a,b)=>
          a.token.rect.x-
          b.token.rect.x
        )[0]

      if(!day)continue

      const dateRect=
        union([
          year.token.rect,
          month.token.rect,
          day.token.rect
        ])

      const rowTokens=
        line.tokens.filter(token=>{
          const x=cx(token.rect)
          return(
            x>=dateRect.x-.12&&
            x<=dateRect.x+
              dateRect.width+.12
          )
        })

      const filled=
        rowTokens.some(token=>
          /\d/.test(token.text)
        )

      // 날짜가 채워져 있는 것은 실패 조건이 아니다.
      // 오히려 "2026년 8월 13일" 같은 정상 날짜 패턴이면 약한 가점.
      result.push({
        rect:dateRect,
        score:filled?118:122,
        line,
        filled
      })
    }

    // 한 토큰/한 줄로 합쳐진 날짜 대응:
    // 2026년8월13일 / 년월일 / 연월일 모두 허용.
    for(const token of expanded){
      if(
        Math.abs(
          cy(token.rect)-
          cy(line.rect)
        )>.026
      )continue

      const value=
        normalizeText(token.text)

      const hasDateUnits=
        (
          value.includes('년')||
          value.includes('연')
        )&&
        (
          value.includes('월')||
          value.includes('원')
        )&&
        value.includes('일')

      const numericDate=
        /\d{2,4}년\d{1,2}월\d{1,2}일/.test(
          value
        )

      if(hasDateUnits||numericDate){
        result.push({
          rect:token.rect,
          score:numericDate?120:112,
          line,
          filled:/\d/.test(value)
        })
      }
    }

    // OCR이 년/월/일 단위를 일부 놓쳐도
    // YYYY M D 형태가 같은 행에 있으면 날짜행 hint로만 사용.
    const numericParts=
      line.tokens.filter(token=>
        /^\d{1,4}$/.test(
          normalizeText(token.text)
        )
      )

    if(
      numericParts.length>=2&&
      normalized.length<80
    ){
      const numericRect=
        union(
          numericParts.map(
            token=>token.rect
          )
        )

      result.push({
        rect:numericRect,
        score:78,
        line,
        filled:true
      })
    }
  }

  // 중복 후보 제거
  return result
    .sort((a,b)=>b.score-a.score)
    .filter((candidate,index,all)=>
      all.findIndex(other=>
        Math.abs(
          cy(other.rect)-
          cy(candidate.rect)
        )<.015&&
        Math.abs(
          cx(other.rect)-
          cx(candidate.rect)
        )<.08
      )===index
    )
}

function nearbyConfirm(
  lines:OCRLine[],
  targetY:number
){
  return lines
    .map(line=>({
      line,
      score:
        confirmScore(
          line.text
        )
    }))
    .filter(item=>{
      const delta=
        targetY-
        cy(item.line.rect)

      return(
        item.score>=.4&&
        delta>=-.025&&
        delta<=.22
      )
    })
    .sort(
      (a,b)=>
        b.score-a.score
    )[0] ?? null
}

function makeTargetRect(
  date:Rect,
  buyer:Rect,
  signer:Rect|null
){
  const parts=[
    date,
    buyer
  ]

  if(signer){
    parts.push(signer)
  }

  const core=
    union(parts)

  // 실제 작성영역은 확인 문장을 포함하지 않는다.
  // 날짜 왼쪽 여백 + 매수인 이후 서명 공간까지만 포함.
  const left=
    Math.max(
      0,
      date.x-.035
    )

  const right=
    Math.min(
      1,
      signer
        ?signer.x+
          signer.width+
          .11
        :buyer.x+
          buyer.width+
          .24
    )

  const top=
    Math.max(
      0,
      core.y-.025
    )

  const bottom=
    Math.min(
      1,
      core.y+
      core.height+
      .035
    )

  return{
    x:left,
    y:top,
    width:
      Math.max(
        .20,
        right-left
      ),
    height:
      Math.max(
        .055,
        bottom-top
      )
  }
}

function focusRectFromLine(
  line:OCRLine
):Rect{
  return{
    x:0,
    y:clamp(
      line.rect.y-.10
    ),
    width:1,
    height:
      Math.min(
        1-
        clamp(
          line.rect.y-.10
        ),
        .28
      )
  }
}

export function assessTokens(
  tokensInput:OCRToken[],
  pageIndex:number
):ScanAssessment{
  const baseLines=
    buildLines(
      tokensInput
    )

  const expanded=
    expandedTokens(
      tokensInput,
      baseLines
    )

  const lines=
    buildLines(
      expanded
    )

  const dates=
    dateCandidates(
      lines,
      expanded
    )

  const buyers=
    expanded
      .map(token=>({
        token,
        score:
          buyerScore(
            token.text
          )
      }))
      .filter(
        item=>
          item.score>=.47
      )
      .sort(
        (a,b)=>
          b.score-a.score
      )

  const signers=
    expanded
      .map(token=>({
        token,
        score:
          signerScore(
            token.text
          )
      }))
      .filter(
        item=>
          item.score>=.47
      )
      .sort(
        (a,b)=>
          b.score-a.score
      )

  const confirmLines=
    lines
      .map(line=>({
        line,
        score:
          confirmScore(
            line.text
          )
      }))
      .filter(
        item=>
          item.score>=.38
      )
      .sort(
        (a,b)=>
          b.score-a.score
      )

  let best:
    TargetCandidate|null=null

  function nearestDate(
    y:number
  ){
    return dates
      .filter(date=>
        Math.abs(
          cy(date.rect)-y
        )<.13
      )
      .sort((a,b)=>
        Math.abs(
          cy(a.rect)-y
        )-
        Math.abs(
          cy(b.rect)-y
        )
      )[0] ?? null
  }

  function nearestSigner(
    buyer:OCRToken
  ){
    const buyerY=cy(buyer.rect)

    return signers
      .filter(item=>
        Math.abs(
          cy(item.token.rect)-
          buyerY
        )<.095
      )
      .sort((a,b)=>{
        const ax=
          Math.abs(
            cx(a.token.rect)-
            cx(buyer.rect)
          )
        const bx=
          Math.abs(
            cx(b.token.rect)-
            cx(buyer.rect)
          )
        return ax-bx
      })[0] ?? null
  }

  function candidateFromStructure(
    buyer:{
      token:OCRToken
      score:number
    },
    signer:{
      token:OCRToken
      score:number
    }|null,
    date:DateCandidate|null,
    confirm:{
      line:OCRLine
      score:number
    }|null
  ){
    const buyerY=cy(buyer.token.rect)

    // 핵심 구조:
    // 매수인은 필수.
    // 서명 anchor / 날짜행 / 확인문구 중 최소 두 개가 추가로 있어야 한다.
    const support=
      (signer?1:0)+
      (date?1:0)+
      (confirm?1:0)

    if(support<2)return null

    let targetRect:Rect

    if(date){
      targetRect=
        makeTargetRect(
          date.rect,
          buyer.token.rect,
          signer?.token.rect ?? null
        )
    }else{
      // 날짜 OCR이 깨져도 매수인+서명+확인문구가 강하면
      // 매수인 왼쪽의 날짜 입력 공간까지 포함한다.
      const signerRect=
        signer?.token.rect ??
        buyer.token.rect

      const top=Math.max(
        0,
        Math.min(
          buyer.token.rect.y,
          signerRect.y
        )-.032
      )
      const bottom=Math.min(
        1,
        Math.max(
          buyer.token.rect.y+
            buyer.token.rect.height,
          signerRect.y+
            signerRect.height
        )+.045
      )

      targetRect={
        x:Math.max(
          0,
          buyer.token.rect.x-.30
        ),
        y:top,
        width:Math.min(
          .70,
          Math.max(
            .34,
            signerRect.x+
              signerRect.width+
              .11-
              Math.max(
                0,
                buyer.token.rect.x-.30
              )
          )
        ),
        height:Math.max(
          .06,
          bottom-top
        )
      }
    }

    if(
      targetRect.width>.74||
      targetRect.height>.18
    )return null

    let score=
      buyer.score*105

    if(signer){
      score+=signer.score*88
    }

    if(date){
      score+=date.score
      if(date.filled)score+=4
    }

    if(confirm){
      score+=confirm.score*48
    }

    // 같은 행에 매수인+서명이 모두 잡히면 매우 강한 후보.
    if(
      signer&&
      Math.abs(
        cy(signer.token.rect)-
        buyerY
      )<.045
    ){
      score+=24
    }

    const confidence=
      Math.min(
        .99,
        Math.max(
          .62,
          score/330
        )
      )

    return{
      pageIndex,
      targetRect,
      score,
      confidence
    } satisfies TargetCandidate
  }

  // 1순위 anchor는 '매수인'.
  // 날짜가 비었는지/채워졌는지는 탐지 성공 여부와 무관하다.
  for(const buyer of buyers.slice(0,12)){
    const buyerY=
      cy(buyer.token.rect)

    const signer=
      nearestSigner(
        buyer.token
      )

    const date=
      nearestDate(
        buyerY
      )

    const confirm=
      nearbyConfirm(
        lines,
        buyerY
      )

    const candidate=
      candidateFromStructure(
        buyer,
        signer,
        date,
        confirm
      )

    if(
      candidate&&
      (
        !best||
        candidate.score>
        best.score
      )
    ){
      best=candidate
    }
  }

  // OCR이 `매수인`만 놓친 경우의 제한적 복구.
  // 날짜행 + 서명 anchor + 확인문구가 모두 있어야 한다.
  if(!best){
    for(const date of dates.slice(0,8)){
      const dateY=cy(date.rect)
      const confirm=
        nearbyConfirm(
          lines,
          dateY
        )

      if(
        !confirm||
        confirm.score<.52
      )continue

      const signer=
        signers
          .filter(item=>
            Math.abs(
              cy(item.token.rect)-
              dateY
            )<.095
          )
          .sort(
            (a,b)=>
              b.score-a.score
          )[0] ?? null

      if(!signer)continue

      const core=
        union([
          date.rect,
          signer.token.rect
        ])

      const targetRect:Rect={
        x:Math.max(
          0,
          date.rect.x-.035
        ),
        y:Math.max(
          0,
          core.y-.03
        ),
        width:Math.min(
          .72,
          Math.max(
            .36,
            signer.token.rect.x+
              signer.token.rect.width+
              .10-
              Math.max(
                0,
                date.rect.x-.035
              )
          )
        ),
        height:Math.min(
          .17,
          Math.max(
            .06,
            core.height+.065
          )
        )
      }

      const score=
        date.score+
        signer.score*78+
        confirm.score*55

      const candidate:TargetCandidate={
        pageIndex,
        targetRect,
        score,
        confidence:Math.min(
          .88,
          Math.max(
            .67,
            score/300
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

  // fallback OCR을 위한 focus만 생성한다.
  // 여기서는 절대로 본문 자체를 결과로 반환하지 않는다.
  let focusRect:
    Rect|null=null

  const strongConfirm=
    confirmLines[0]

  if(strongConfirm){
    focusRect=
      focusRectFromLine(
        strongConfirm.line
      )
  }else if(dates[0]){
    focusRect={
      x:0,
      y:clamp(
        dates[0].line.rect.y-
        .08
      ),
      width:1,
      height:.22
    }
  }else if(buyers[0]){
    focusRect={
      x:0,
      y:clamp(
        buyers[0].token.rect.y-
        .10
      ),
      width:1,
      height:.24
    }
  }

  const hintScore=
    dates.length*45+
    (buyers[0]?.score ?? 0)*45+
    (signers[0]?.score ?? 0)*35+
    (strongConfirm?.score ?? 0)*25

  return{
    target:best,
    hintScore,
    focusRect
  }
}

// v23 빠른 탐지: 친구 구현의 "매수인 우선 → 같은 글줄 bbox" 전략.
// 구조 OCR이 충분하면 복잡한 날짜 판정 전에 즉시 서명행을 반환한다.
export function quickSignatureRect(
  tokens:OCRToken[],
  pageIndex:number
):TargetCandidate|null{
  if(!tokens.length)return null

  const lines=buildLines(tokens)
  const expanded=expandedTokens(tokens,lines)

  const buyerCandidates=expanded
    .map(token=>({token,score:buyerScore(token.text)}))
    .filter(item=>item.score>=.52)
    .sort((a,b)=>b.score-a.score)

  const signerCandidates=expanded
    .map(token=>({token,score:signerScore(token.text)}))
    .filter(item=>item.score>=.52)

  // 1순위: 매수인. 성능점검기록부에서 실제 고객 서명행을 가장 잘 구분한다.
  for(const buyer of buyerCandidates.slice(0,10)){
    const ay=cy(buyer.token.rect)
    const ah=Math.max(.012,buyer.token.rect.height)

    const sameLine=tokens.filter(token=>
      Math.abs(cy(token.rect)-ay)<=Math.max(.022,ah*1.45)
    )

    const signer=signerCandidates
      .filter(item=>Math.abs(cy(item.token.rect)-ay)<=Math.max(.025,ah*1.8))
      .sort((a,b)=>
        Math.abs(cx(a.token.rect)-cx(buyer.token.rect))-
        Math.abs(cx(b.token.rect)-cx(buyer.token.rect))
      )[0] ?? null

    // 친구 코드처럼 같은 줄의 합집합을 기본으로 쓰되,
    // 너무 긴 본문 한 줄이 붙는 경우는 작성행 크기로 제한한다.
    const rowRect=sameLine.length
      ?union(sameLine.map(token=>token.rect))
      :buyer.token.rect

    // 매수인 왼쪽에는 날짜 작성 칸이 위치하는 경우가 많다.
    // OCR이 날짜를 놓쳐도 작성 가능하도록 일정 공간을 확보한다.
    const x0=Math.max(0,Math.min(rowRect.x,buyer.token.rect.x-.34))
    const signerRight=signer
      ?signer.token.rect.x+signer.token.rect.width+.08
      :buyer.token.rect.x+buyer.token.rect.width+.28
    const x1=Math.min(1,Math.max(rowRect.x+rowRect.width,signerRight))
    const y0=Math.max(0,rowRect.y-Math.max(.015,rowRect.height*.75))
    const y1=Math.min(1,rowRect.y+rowRect.height+Math.max(.02,rowRect.height*1.15))

    const rect:Rect={
      x:x0,
      y:y0,
      width:Math.max(.30,x1-x0),
      height:Math.max(.055,y1-y0)
    }

    if(rect.width>.80||rect.height>.20)continue

    let score=150+buyer.score*90
    if(signer)score+=signer.score*75

    // 같은 줄에서 년/월/일 또는 숫자 날짜가 읽히면 추가 가점.
    const rowText=normalizeText(sameLine.map(t=>t.text).join(''))
    if(/년.*월.*일/.test(rowText)||/\d{2,4}년\d{1,2}월\d{1,2}일/.test(rowText))score+=35

    return{
      pageIndex,
      targetRect:rect,
      score,
      confidence:Math.min(.99,.82+(signer?.score??0)*.12)
    }
  }

  // 매수인을 OCR이 놓쳤을 때만 '서명'을 보조 anchor로 사용.
  // 같은 줄에 날짜 단위가 있거나 바로 위 확인문구가 있을 때만 허용한다.
  const signerSorted=[...signerCandidates]
    .sort((a,b)=>b.token.rect.y-a.token.rect.y)

  for(const signer of signerSorted.slice(0,8)){
    const sy=cy(signer.token.rect)
    const sh=Math.max(.012,signer.token.rect.height)
    const sameLine=tokens.filter(token=>
      Math.abs(cy(token.rect)-sy)<=Math.max(.022,sh*1.55)
    )
    const rowText=normalizeText(sameLine.map(t=>t.text).join(''))
    const dateLike=/년.*월.*일/.test(rowText)||/\d{2,4}년\d{1,2}월\d{1,2}일/.test(rowText)
    const confirm=nearbyConfirm(lines,sy)
    if(!dateLike&&!confirm)continue

    const rowRect=union(sameLine.map(t=>t.rect))
    const x0=Math.max(0,rowRect.x-.05)
    const x1=Math.min(1,signer.token.rect.x+signer.token.rect.width+.10)
    const rect:Rect={
      x:x0,
      y:Math.max(0,rowRect.y-.02),
      width:Math.max(.32,x1-x0),
      height:Math.max(.06,rowRect.height+.05)
    }
    if(rect.width>.80||rect.height>.20)continue

    return{
      pageIndex,
      targetRect:rect,
      score:175+signer.score*65+(confirm?.score??0)*25,
      confidence:.76
    }
  }

  return null
}


/**
 * v24 second-pass detector.
 * Input tokens are already OCR'ed from a cropped coarse signature candidate.
 * Therefore this function is intentionally stricter and returns only the
 * actual writing row, not the surrounding confirmation paragraph.
 */
export function refineSignatureRect(
  tokens:OCRToken[],
  pageIndex:number
):TargetCandidate|null{
  if(!tokens.length)return null

  const lines=buildLines(tokens)
  const expanded=expandedTokens(tokens,lines)

  const buyers=expanded
    .map(token=>({token,score:buyerScore(token.text)}))
    .filter(item=>item.score>=.44)
    .sort((a,b)=>b.score-a.score)

  const signers=expanded
    .map(token=>({token,score:signerScore(token.text)}))
    .filter(item=>item.score>=.42)
    .sort((a,b)=>b.score-a.score)

  const dateUnits=expanded
    .map(token=>({token,kind:unitKind(token.text)}))
    .filter(item=>item.kind)

  function rowTokensAt(y:number,h:number){
    return tokens.filter(token=>
      Math.abs(cy(token.rect)-y)<=Math.max(.025,h*1.9)
    )
  }

  function dateRectNear(y:number,h:number):Rect|null{
    const near=dateUnits.filter(item=>
      Math.abs(cy(item.token.rect)-y)<=Math.max(.035,h*2.3)
    )
    const years=near.filter(item=>item.kind==='year')
    const months=near.filter(item=>item.kind==='month')
    const days=near.filter(item=>item.kind==='day')

    for(const year of years){
      const month=months
        .filter(item=>cx(item.token.rect)>cx(year.token.rect))
        .sort((a,b)=>a.token.rect.x-b.token.rect.x)[0]
      if(!month)continue
      const day=days
        .filter(item=>cx(item.token.rect)>cx(month.token.rect))
        .sort((a,b)=>a.token.rect.x-b.token.rect.x)[0]
      if(day){
        return union([year.token.rect,month.token.rect,day.token.rect])
      }
    }

    // Filled dates or OCR-merged dates, e.g. 2026년8월13일.
    const merged=expanded.find(token=>{
      if(Math.abs(cy(token.rect)-y)>Math.max(.04,h*2.5))return false
      const t=normalizeText(token.text)
      return /(?:\d{2,4})?년(?:\d{1,2})?월(?:\d{1,2})?일/.test(t)
    })
    return merged?.rect ?? null
  }

  // Strongest route: buyer anchor. Inside second-pass ROI this is highly specific.
  for(const buyer of buyers.slice(0,8)){
    const by=cy(buyer.token.rect)
    const bh=Math.max(.012,buyer.token.rect.height)
    const row=rowTokensAt(by,bh)

    const signer=signers
      .filter(item=>Math.abs(cy(item.token.rect)-by)<=Math.max(.035,bh*2.2))
      .sort((a,b)=>Math.abs(cx(a.token.rect)-cx(buyer.token.rect))-Math.abs(cx(b.token.rect)-cx(buyer.token.rect)))[0] ?? null

    const date=dateRectNear(by,bh)
    const rowRect=row.length?union(row.map(t=>t.rect)):buyer.token.rect

    // Actual input zone starts around the date row and ends after signature marker.
    const left=Math.max(0,date?date.x-.025:Math.min(rowRect.x,buyer.token.rect.x-.30))
    const right=Math.min(1,signer
      ?signer.token.rect.x+signer.token.rect.width+.075
      :buyer.token.rect.x+buyer.token.rect.width+.26)
    const core=union([buyer.token.rect, ...(date?[date]:[]), ...(signer?[signer.token.rect]:[])])
    const top=Math.max(0,core.y-Math.max(.018,core.height*.75))
    const bottom=Math.min(1,core.y+core.height+Math.max(.025,core.height*1.15))

    const rect:Rect={
      x:left,
      y:top,
      width:Math.max(.28,right-left),
      height:Math.max(.055,bottom-top)
    }
    if(rect.width>.82||rect.height>.24)continue

    let score=190+buyer.score*95
    if(signer)score+=signer.score*90
    if(date)score+=55

    return{
      pageIndex,
      targetRect:rect,
      score,
      confidence:Math.min(.995,.86+(signer?.score??0)*.07+(date?0.035:0))
    }
  }

  // Buyer OCR can fail on very small scans. In a second-pass ROI,
  // signer + date is enough, but never signer alone.
  for(const signer of signers.slice(0,8)){
    const sy=cy(signer.token.rect)
    const sh=Math.max(.012,signer.token.rect.height)
    const date=dateRectNear(sy,sh)
    if(!date)continue

    const core=union([date,signer.token.rect])
    const left=Math.max(0,date.x-.03)
    const right=Math.min(1,signer.token.rect.x+signer.token.rect.width+.08)
    const rect:Rect={
      x:left,
      y:Math.max(0,core.y-.025),
      width:Math.max(.30,right-left),
      height:Math.max(.06,core.height+.055)
    }
    if(rect.width>.82||rect.height>.24)continue

    return{
      pageIndex,
      targetRect:rect,
      score:185+signer.score*80,
      confidence:.80
    }
  }

  return null
}
