import type { NormalizedRect, OCRToken, Rotation, SignatureBlock } from './types'

const clean=(s:string)=>s.replace(/\s+/g,'').replace(/[.,:;_\-|]/g,'').replace(/[［\[]/g,'(').replace(/[］\]]/g,')')
const center=(r:NormalizedRect)=>({x:r.x+r.width/2,y:r.y+r.height/2})
const clamp=(r:NormalizedRect):NormalizedRect=>{
  const x=Math.max(0,Math.min(1,r.x)),y=Math.max(0,Math.min(1,r.y))
  const x1=Math.max(x,Math.min(1,r.x+r.width)),y1=Math.max(y,Math.min(1,r.y+r.height))
  return{x,y,width:x1-x,height:y1-y}
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
  if(aa.includes(bb)||bb.includes(aa))return Math.min(.98,.75+Math.min(aa.length,bb.length)/Math.max(aa.length,bb.length)*.22)
  return 1-levenshtein(aa,bb)/Math.max(aa.length,bb.length)
}
const like=(text:string,k:string)=>similarity(text,k)>=(k.length===1?.99:k.length===2?.82:.68)

export function scoreFastText(text:string){
  const t=clean(text)
  let score=0
  const hits:string[]=[]
  const add=(k:string,w:number)=>{if(t.includes(k)){score+=w;hits.push(k)}}

  // Orientation/page scoring only. Strongly favor coexistence of date + signer vocabulary.
  add('연월일',38);add('년월일',36)
  add('매수인',38);add('서명',32);add('(인)',24);add('성명',18);add('고지자',18)
  const hasDate=t.includes('연월일')||t.includes('년월일')||(t.includes('년')&&t.includes('월')&&t.includes('일'))
  const hasSigner=t.includes('매수인')||t.includes('서명')||t.includes('(인)')||t.includes('성명')||t.includes('고지자')
  if(hasDate){score+=26;hits.push('DATE')}
  if(hasSigner){score+=22;hits.push('SIGNER')}
  if(hasDate&&hasSigner){score+=58;hits.push('DATE+SIGNER')}
  const hangul=(text.match(/[가-힣]/g)||[]).length
  score+=Math.min(18,hangul/14)
  return{score,hits}
}

function union(rs:NormalizedRect[]):NormalizedRect{
  const x0=Math.min(...rs.map(r=>r.x)),y0=Math.min(...rs.map(r=>r.y))
  const x1=Math.max(...rs.map(r=>r.x+r.width)),y1=Math.max(...rs.map(r=>r.y+r.height))
  return{x:x0,y:y0,width:x1-x0,height:y1-y0}
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

function buildJoinedTokens(tokens:OCRToken[]){
  const out=[...tokens]
  const sorted=[...tokens].sort((a,b)=>center(a.rect).y-center(b.rect).y||a.rect.x-b.rect.x)
  for(let i=0;i<sorted.length;i++){
    for(let len=2;len<=4 && i+len<=sorted.length;len++){
      const g=sorted.slice(i,i+len)
      const ys=g.map(t=>center(t.rect).y)
      if(Math.max(...ys)-Math.min(...ys)>.021)break
      const badGap=g.slice(1).some((t,k)=>t.rect.x-(g[k].rect.x+g[k].rect.width)>.038)
      if(badGap)break
      out.push({
        text:g.map(t=>t.text).join(''),
        confidence:Math.min(...g.map(t=>t.confidence)),
        pageIndex:g[0].pageIndex,
        rect:union(g.map(t=>t.rect)),
      })
    }
  }
  return out
}

export function detectSignatureBlocks(tokens:OCRToken[],rotation:Rotation):SignatureBlock[]{
  const all=buildJoinedTokens(tokens)

  const dateAnchors=all.filter(t=>
    like(t.text,'연월일')||like(t.text,'년월일')||
    clean(t.text)==='년'||clean(t.text)==='월'||clean(t.text)==='일'
  )
  const signerAnchors=all.filter(t=>
    like(t.text,'매수인')||like(t.text,'서명')||like(t.text,'(인)')||
    like(t.text,'성명')||like(t.text,'고지자')
  )

  const blocks:SignatureBlock[]=[]

  // Critical rule: date and signer anchors must be spatially close.
  for(const d of dateAnchors){
    for(const s of signerAnchors){
      const dc=center(d.rect),sc=center(s.rect)
      const dx=Math.abs(dc.x-sc.x),dy=Math.abs(dc.y-sc.y)

      // Allow same row or adjacent rows, but reject unrelated text elsewhere.
      if(dx>.66||dy>.16)continue

      let score=120
      score-=dx*55
      score-=dy*360
      score+=Math.min(18,(d.confidence+s.confidence)/12)

      if(like(d.text,'연월일')||like(d.text,'년월일'))score+=24
      if(like(s.text,'매수인'))score+=28
      if(like(s.text,'서명')||like(s.text,'(인)'))score+=20
      if(Math.abs(dc.y-sc.y)<.045)score+=20

      // Build one compact signing block around the pair.
      const core=union([d.rect,s.rect])
      const rotatedRect=clamp({
        x:Math.max(0,core.x-.055),
        y:Math.max(0,core.y-.055),
        width:Math.min(.82,Math.max(.40,core.width+.30)),
        height:Math.min(.22,Math.max(.105,core.height+.12)),
      })

      blocks.push({
        pageIndex:d.pageIndex,
        rotation,
        rotatedRect,
        rect:unrotateRect(rotatedRect,rotation),
        score,
        confidence:Math.max(.35,Math.min(.99,score/180)),
        matchedKeywords:[clean(d.text),clean(s.text)],
      })
    }
  }

  // Special fallback for separately OCRed 년 / 월 / 일 triplets near signer anchor.
  if(!blocks.length){
    const years=all.filter(t=>clean(t.text)==='년')
    const months=all.filter(t=>clean(t.text)==='월')
    const days=all.filter(t=>clean(t.text)==='일')
    for(const y of years){
      const yc=center(y.rect)
      const m=months.find(t=>Math.abs(center(t.rect).y-yc.y)<.04&&center(t.rect).x>yc.x&&center(t.rect).x-yc.x<.30)
      const day=days.find(t=>Math.abs(center(t.rect).y-yc.y)<.04&&center(t.rect).x>yc.x&&center(t.rect).x-yc.x<.55)
      if(!m||!day)continue
      const dateCore=union([y.rect,m.rect,day.rect])
      const signer=signerAnchors
        .filter(s=>Math.abs(center(s.rect).y-center(dateCore).y)<.15)
        .sort((a,b)=>{
          const A=Math.hypot(center(a.rect).x-center(dateCore).x,center(a.rect).y-center(dateCore).y)
          const B=Math.hypot(center(b.rect).x-center(dateCore).x,center(b.rect).y-center(dateCore).y)
          return A-B
        })[0]
      if(!signer)continue
      const core=union([dateCore,signer.rect])
      const rotatedRect=clamp({
        x:Math.max(0,core.x-.055),y:Math.max(0,core.y-.05),
        width:Math.min(.82,Math.max(.42,core.width+.28)),
        height:Math.min(.22,Math.max(.11,core.height+.11)),
      })
      blocks.push({
        pageIndex:y.pageIndex,rotation,
        rotatedRect,rect:unrotateRect(rotatedRect,rotation),
        score:142,confidence:.79,matchedKeywords:['년·월·일',clean(signer.text)]
      })
    }
  }

  // Deduplicate strongly overlapping blocks.
  const sorted=blocks.sort((a,b)=>b.score-a.score)
  const out:SignatureBlock[]=[]
  const overlap=(a:NormalizedRect,b:NormalizedRect)=>{
    const x0=Math.max(a.x,b.x),y0=Math.max(a.y,b.y)
    const x1=Math.min(a.x+a.width,b.x+b.width),y1=Math.min(a.y+a.height,b.y+b.height)
    const inter=Math.max(0,x1-x0)*Math.max(0,y1-y0)
    const uni=a.width*a.height+b.width*b.height-inter
    return uni?inter/uni:0
  }
  for(const b of sorted){
    if(!out.some(o=>overlap(o.rotatedRect,b.rotatedRect)>.55))out.push(b)
  }
  return out.slice(0,3)
}
