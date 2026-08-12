import type { NormalizedRect, OCRLine, OCRToken, SigningBlock } from './types'

const clean=(s:string)=>s.replace(/\s+/g,'').replace(/[.,:;_\-|·()[\]{}]/g,'')
const cy=(r:NormalizedRect)=>r.y+r.height/2
const cx=(r:NormalizedRect)=>r.x+r.width/2

const clamp=(r:NormalizedRect):NormalizedRect=>{
  const x=Math.max(0,Math.min(1,r.x)),y=Math.max(0,Math.min(1,r.y))
  const x1=Math.max(x,Math.min(1,r.x+r.width)),y1=Math.max(y,Math.min(1,r.y+r.height))
  return{x,y,width:x1-x,height:y1-y}
}
function union(rs:NormalizedRect[]):NormalizedRect{
  const x0=Math.min(...rs.map(r=>r.x)),y0=Math.min(...rs.map(r=>r.y))
  const x1=Math.max(...rs.map(r=>r.x+r.width)),y1=Math.max(...rs.map(r=>r.y+r.height))
  return{x:x0,y:y0,width:x1-x0,height:y1-y0}
}
function lev(a:string,b:string){
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
  if(aa===bb)return 1
  if(aa.includes(bb)||bb.includes(aa))return Math.min(.99,.76+Math.min(aa.length,bb.length)/Math.max(aa.length,bb.length)*.22)
  return 1-lev(aa,bb)/Math.max(aa.length,bb.length)
}

export function tokensToLines(tokens:OCRToken[]):OCRLine[]{
  const sorted=[...tokens].sort((a,b)=>cy(a.rect)-cy(b.rect)||a.rect.x-b.rect.x)
  const groups:OCRToken[][]=[]
  for(const token of sorted){
    let chosen:OCRToken[]|null=null,best=Infinity
    for(const g of groups){
      const gy=g.reduce((s,t)=>s+cy(t.rect),0)/g.length
      const avgH=g.reduce((s,t)=>s+t.rect.height,0)/g.length
      const dy=Math.abs(cy(token.rect)-gy)
      if(dy<Math.max(.015,avgH*.85)&&dy<best){chosen=g;best=dy}
    }
    if(chosen)chosen.push(token);else groups.push([token])
  }
  return groups.map(g=>{
    const ordered=[...g].sort((a,b)=>a.rect.x-b.rect.x)
    return{
      text:ordered.map(t=>t.text).join(' '),
      confidence:ordered.reduce((s,t)=>s+t.confidence,0)/ordered.length,
      rect:union(ordered.map(t=>t.rect)),
      pageIndex:ordered[0].pageIndex
    }
  }).sort((a,b)=>a.rect.y-b.rect.y)
}

// Do NOT require exact "확인합니다".
function confirmationContextScore(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('확인합니다'))score+=1.0
  if(s.includes('확인'))score+=.55
  if(s.includes('사실'))score+=.28
  if(s.includes('본인은'))score+=.30
  if(s.includes('발급받은'))score+=.16
  if(s.includes('성능')&&s.includes('점검'))score+=.10

  // fuzzy fragments survive bad OCR better than whole-sentence similarity
  score=Math.max(score,
    sim(s,'확인합니다')*.72,
    sim(s,'사실을확인합니다')*.78
  )
  return Math.min(1.35,score)
}

function dateLabelScore(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('연월일')||s.includes('년월일'))score=1
  const hasY=s.includes('년'),hasM=s.includes('월'),hasD=s.includes('일')
  if(hasY&&hasM&&hasD)score=Math.max(score,.98)
  if((hasY&&hasM)||(hasM&&hasD))score=Math.max(score,.68)
  if(/\d{4}년?\d{1,2}월?\d{1,2}일?/.test(s))score=Math.max(score,.72) // prefilled date: weaker
  return score
}
function buyerScore(text:string){
  const s=clean(text)
  if(s.includes('매수인'))return 1
  return Math.max(sim(s,'매수인')*.9,0)
}
function signerScore(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('서명또는인'))score=1
  if(s.includes('서명'))score=Math.max(score,.88)
  if(s.includes('인'))score=Math.max(score,.48)
  return score
}

function looksPrefilled(text:string){
  const s=clean(text)
  // Existing inspector block often contains full YYYY/MM/DD and company/person names.
  return /\d{4}년?\d{1,2}월?\d{1,2}일?/.test(s) || /\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(s)
}

function createTargetCrop(dateLine:OCRLine,buyerLine:OCRLine,signerLine:OCRLine){
  // Confirmation text is only a semantic anchor.
  // Final result must show only the actual fill/sign row.
  const core=union([dateLine.rect,buyerLine.rect,signerLine.rect])

  return clamp({
    x:Math.max(0,core.x-.035),
    y:Math.max(0,core.y-.025),
    width:Math.min(.94,Math.max(.42,core.width+.07)),
    height:Math.min(.16,Math.max(.075,core.height+.05))
  })
}

export function detectSigningBlocks(tokens:OCRToken[]):SigningBlock[]{
  const lines=tokensToLines(tokens)
  const confirms=lines.map(line=>({line,score:confirmationContextScore(line.text)})).filter(x=>x.score>=.42)
  const dates=lines.map(line=>({line,score:dateLabelScore(line.text)})).filter(x=>x.score>=.55)
  const buyers=lines.map(line=>({line,score:buyerScore(line.text)})).filter(x=>x.score>=.45)
  const signers=lines.map(line=>({line,score:signerScore(line.text)})).filter(x=>x.score>=.42)

  const candidates:SigningBlock[]=[]

  // Target layout seen in supplied samples:
  // [confirmation sentence]
  // [blank 년 월 일]   [매수인]   [(서명 또는 인)]
  for(const c of confirms){
    const cY=cy(c.line.rect)

    const nearbyDates=dates.filter(d=>{
      const dy=cy(d.line.rect)-cY
      return dy>=-.01 && dy<=.18
    })
    const nearbyBuyers=buyers.filter(b=>{
      const dy=cy(b.line.rect)-cY
      return dy>=-.01 && dy<=.20
    })
    const nearbySigners=signers.filter(s=>{
      const dy=cy(s.line.rect)-cY
      return dy>=-.02 && dy<=.22
    })

    for(const d of nearbyDates){
      for(const b of nearbyBuyers){
        for(const s of nearbySigners){
          const targetY=Math.max(cy(d.line.rect),cy(b.line.rect),cy(s.line.rect))
          const spreadY=Math.max(
            Math.abs(cy(d.line.rect)-cy(b.line.rect)),
            Math.abs(cy(d.line.rect)-cy(s.line.rect)),
            Math.abs(cy(b.line.rect)-cy(s.line.rect))
          )
          if(spreadY>.10)continue

          let score=170
          score+=c.score*42+d.score*35+b.score*42+s.score*32
          score-=spreadY*160

          // Strongly prefer the blank buyer acknowledgement row.
          if(!looksPrefilled(d.line.text))score+=38
          else score-=28

          // In samples buyer/signature labels tend to be horizontally separated on same row.
          if(Math.abs(cx(b.line.rect)-cx(s.line.rect))>.12)score+=12

          // Prefer the lower valid acknowledgement block if multiple exist.
          score+=targetY*28

          const crop=createTargetCrop(d.line,b.line,s.line)
          candidates.push({
            pageIndex:c.line.pageIndex,
            rect:crop,
            confidence:Math.max(.35,Math.min(.99,score/300)),
            score,
            confirmLine:c.line.text,
            dateLine:d.line.text,
            signerLine:`${b.line.text} | ${s.line.text}`
          })
        }
      }
    }
  }

  // OCR often splits isolated 년 / 월 / 일 into different "lines".
  // Build a geometric fallback directly from token positions near a confirmation line.
  if(!candidates.length){
    const yearTokens=tokens.filter(t=>clean(t.text)==='년')
    const monthTokens=tokens.filter(t=>clean(t.text)==='월')
    const dayTokens=tokens.filter(t=>clean(t.text)==='일')
    const buyerTokens=tokens.filter(t=>sim(t.text,'매수인')>=.45)
    const signTokens=tokens.filter(t=>sim(t.text,'서명')>=.45||clean(t.text)==='인'||sim(t.text,'서명또는인')>=.42)

    for(const c of confirms){
      const cY=cy(c.line.rect)
      for(const y of yearTokens){
        const yY=cy(y.rect)
        if(yY<cY||yY-cY>.20)continue
        const m=monthTokens.find(t=>Math.abs(cy(t.rect)-yY)<.035)
        const d=dayTokens.find(t=>Math.abs(cy(t.rect)-yY)<.035)
        const b=buyerTokens.find(t=>Math.abs(cy(t.rect)-yY)<.08)
        const s=signTokens.find(t=>Math.abs(cy(t.rect)-yY)<.09)
        if(!m||!d||!b||!s)continue

        const pseudoLines:OCRLine[]=[
          c.line,
          {text:'년 월 일',confidence:Math.min(y.confidence,m.confidence,d.confidence),rect:union([y.rect,m.rect,d.rect]),pageIndex:y.pageIndex},
          {text:b.text,confidence:b.confidence,rect:b.rect,pageIndex:b.pageIndex},
          {text:s.text,confidence:s.confidence,rect:s.rect,pageIndex:s.pageIndex},
        ]
        const score=235+c.score*35+yY*25
        candidates.push({
          pageIndex:y.pageIndex,
          rect:createTargetCrop(pseudoLines[1],pseudoLines[2],pseudoLines[3]),
          confidence:Math.min(.94,score/300),
          score,
          confirmLine:c.line.text,
          dateLine:'년 월 일',
          signerLine:`${b.text} | ${s.text}`
        })
      }
    }
  }

  return candidates.sort((a,b)=>b.score-a.score).slice(0,3)
}

export function scoreFastPageText(text:string){
  const s=clean(text)
  let score=0

  const hasConfirm=s.includes('확인')||s.includes('사실')||s.includes('본인은')
  const hasDate=(s.includes('년')&&s.includes('월')&&s.includes('일'))||
    s.includes('연월일')||s.includes('년월일')
  const hasBuyer=s.includes('매수인')
  const hasSign=s.includes('서명')||s.includes('서명또는인')||s.includes('(인)')

  if(hasConfirm)score+=28
  if(hasDate)score+=70
  if(hasBuyer)score+=90
  if(hasSign)score+=72

  // Strong page discriminator: the real target page normally contains this combination.
  if(hasDate&&hasBuyer)score+=85
  if(hasBuyer&&hasSign)score+=95
  if(hasDate&&hasBuyer&&hasSign)score+=125
  if(hasConfirm&&hasDate&&hasBuyer&&hasSign)score+=40

  return score
}
