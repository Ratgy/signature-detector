import type { NormalizedRect, OCRLine, OCRToken, SigningBlock } from './types'

const clean=(s:string)=>s.replace(/\s+/g,'').replace(/[.,:;_\-|·]/g,'').replace(/[［\[]/g,'(').replace(/[］\]]/g,')')
const clamp=(r:NormalizedRect):NormalizedRect=>{
  const x=Math.max(0,Math.min(1,r.x)), y=Math.max(0,Math.min(1,r.y))
  const x1=Math.max(x,Math.min(1,r.x+r.width)), y1=Math.max(y,Math.min(1,r.y+r.height))
  return {x,y,width:x1-x,height:y1-y}
}
function union(rs:NormalizedRect[]):NormalizedRect{
  const x0=Math.min(...rs.map(r=>r.x)), y0=Math.min(...rs.map(r=>r.y))
  const x1=Math.max(...rs.map(r=>r.x+r.width)), y1=Math.max(...rs.map(r=>r.y+r.height))
  return {x:x0,y:y0,width:x1-x0,height:y1-y0}
}
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
function similarity(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb)return 0
  if(aa===bb)return 1
  if(aa.includes(bb)||bb.includes(aa))return Math.min(.99,.78+Math.min(aa.length,bb.length)/Math.max(aa.length,bb.length)*.2)
  return 1-levenshtein(aa,bb)/Math.max(aa.length,bb.length)
}
const cy=(r:NormalizedRect)=>r.y+r.height/2

export function tokensToLines(tokens:OCRToken[]):OCRLine[]{
  const sorted=[...tokens].sort((a,b)=>cy(a.rect)-cy(b.rect)||a.rect.x-b.rect.x)
  const groups:OCRToken[][]=[]

  for(const token of sorted){
    let best:OCRToken[]|null=null
    let bestDy=Infinity
    for(const g of groups){
      const gy=g.reduce((s,t)=>s+cy(t.rect),0)/g.length
      const dy=Math.abs(cy(token.rect)-gy)
      const avgH=g.reduce((s,t)=>s+t.rect.height,0)/g.length
      if(dy<Math.max(.012,avgH*.7) && dy<bestDy){
        best=g;bestDy=dy
      }
    }
    if(best)best.push(token)
    else groups.push([token])
  }

  return groups.map(g=>{
    const ordered=[...g].sort((a,b)=>a.rect.x-b.rect.x)
    return{
      text:ordered.map(t=>t.text).join(' '),
      confidence:ordered.reduce((s,t)=>s+t.confidence,0)/ordered.length,
      rect:union(ordered.map(t=>t.rect)),
      pageIndex:ordered[0].pageIndex,
    }
  }).sort((a,b)=>a.rect.y-b.rect.y)
}

function confirmScore(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('확인합니다'))score=1
  else score=Math.max(
    similarity(s,'확인합니다'),
    similarity(s,'사실을확인합니다'),
    similarity(s,'사실을확인함니다'),
    similarity(s,'확인함니다')
  )
  // phrases in supplied samples
  if(s.includes('사실'))score+=.10
  if(s.includes('본인은'))score+=.08
  return Math.min(1.2,score)
}
function dateScore(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('연월일')||s.includes('년월일'))score=.95
  if(s.includes('년')&&s.includes('월')&&s.includes('일'))score=Math.max(score,1)
  if(/\d{4}년?\d{1,2}월?\d{1,2}일?/.test(s))score=Math.max(score,.92)
  if(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(s))score=Math.max(score,.9)
  return score
}
function signerScore(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('서명또는인'))score=1
  if(s.includes('(인)'))score=Math.max(score,.92)
  if(s.includes('매수인'))score=Math.max(score,.9)
  if(s.includes('서명'))score=Math.max(score,.88)
  if(s.includes('고지자'))score=Math.max(score,.72)
  if(s.includes('점검자'))score=Math.max(score,.62)
  // multiple "인" marks in line is a strong clue
  const inCount=(s.match(/인/g)||[]).length
  if(inCount>=2)score=Math.max(score,.8)
  return score
}

function cropAround(lines:OCRLine[]){
  const core=union(lines.map(l=>l.rect))
  return clamp({
    x:Math.max(0,core.x-.055),
    y:Math.max(0,core.y-.035),
    width:Math.min(.96,Math.max(.48,core.width+.11)),
    height:Math.min(.38,Math.max(.13,core.height+.08)),
  })
}

export function detectSigningBlocks(tokens:OCRToken[]):SigningBlock[]{
  const lines=tokensToLines(tokens)
  const confirms=lines.map(l=>({line:l,score:confirmScore(l.text)})).filter(x=>x.score>=.52)
  const dates=lines.map(l=>({line:l,score:dateScore(l.text)})).filter(x=>x.score>=.55)
  const signers=lines.map(l=>({line:l,score:signerScore(l.text)})).filter(x=>x.score>=.55)
  const blocks:SigningBlock[]=[]

  // Primary strategy based on supplied samples:
  // confirm sentence first, then date/signature rows at or below it.
  for(const c of confirms){
    for(const d of dates){
      const dyDate=d.line.rect.y-c.line.rect.y
      if(dyDate < -.03 || dyDate > .24)continue

      for(const s of signers){
        const dySigner=s.line.rect.y-c.line.rect.y
        if(dySigner < -.04 || dySigner > .28)continue

        // Date/signature should belong to the same local block.
        const localY=Math.abs((d.line.rect.y+d.line.rect.height/2)-(s.line.rect.y+s.line.rect.height/2))
        if(localY>.18)continue

        let score=160
        score+=c.score*45+d.score*32+s.score*38
        score-=Math.max(0,dyDate)*80
        score-=Math.max(0,dySigner)*55
        score-=localY*80

        // Prefer samples' common order: confirm -> date -> signer/buyer.
        if(d.line.rect.y>=c.line.rect.y)score+=12
        if(s.line.rect.y>=c.line.rect.y)score+=10

        const rect=cropAround([c.line,d.line,s.line])

        blocks.push({
          pageIndex:c.line.pageIndex,
          rect,
          confidence:Math.max(.35,Math.min(.99,score/260)),
          score,
          confirmLine:c.line.text,
          dateLine:d.line.text,
          signerLine:s.line.text,
        })
      }
    }
  }

  // Fallback: if OCR misses "확인합니다" but date + signer are clearly paired,
  // only allow when they are very close and located in the same lower/local block.
  if(!blocks.length){
    for(const d of dates){
      for(const s of signers){
        const localY=Math.abs(cy(d.line.rect)-cy(s.line.rect))
        const localX=Math.abs((d.line.rect.x+d.line.rect.width/2)-(s.line.rect.x+s.line.rect.width/2))
        if(localY>.10||localX>.55)continue

        // Find nearest weak confirm-like line above.
        const weak=lines
          .map(l=>({line:l,score:confirmScore(l.text)}))
          .filter(x=>x.line.rect.y<=Math.max(d.line.rect.y,s.line.rect.y)+.03 && x.line.rect.y>=Math.min(d.line.rect.y,s.line.rect.y)-.22)
          .sort((a,b)=>b.score-a.score)[0]

        if(!weak||weak.score<.35)continue

        const score=130+d.score*32+s.score*38+weak.score*35-localY*100
        blocks.push({
          pageIndex:d.line.pageIndex,
          rect:cropAround([weak.line,d.line,s.line]),
          confidence:Math.max(.35,Math.min(.9,score/240)),
          score,
          confirmLine:weak.line.text,
          dateLine:d.line.text,
          signerLine:s.line.text,
        })
      }
    }
  }

  return blocks.sort((a,b)=>b.score-a.score).slice(0,3)
}

export function scoreFastPageText(text:string){
  const s=clean(text)
  let score=0
  if(s.includes('확인합니다'))score+=80
  if(s.includes('사실'))score+=16
  if((s.includes('년')&&s.includes('월')&&s.includes('일'))||s.includes('연월일')||s.includes('년월일'))score+=55
  if(s.includes('서명')||s.includes('(인)')||s.includes('매수인'))score+=45
  if(s.includes('본인은'))score+=12
  return score
}
