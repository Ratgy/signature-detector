import type { NormalizedRect, OCRToken, Rotation, SigningCluster } from './types'

const clean=(s:string)=>s.replace(/\s+/g,'').replace(/[.,:;_\-|]/g,'').replace(/[［\[]/g,'(').replace(/[］\]]/g,')')

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
export function sim(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb)return 0
  if(aa===bb)return 1
  if(aa.includes(bb)||bb.includes(aa))return Math.min(.99,.78+Math.min(aa.length,bb.length)/Math.max(aa.length,bb.length)*.2)
  return 1-lev(aa,bb)/Math.max(aa.length,bb.length)
}
const center=(r:NormalizedRect)=>({x:r.x+r.width/2,y:r.y+r.height/2})
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
function joined(tokens:OCRToken[]){
  const out=[...tokens]
  const sorted=[...tokens].sort((a,b)=>center(a.rect).y-center(b.rect).y||a.rect.x-b.rect.x)
  for(let i=0;i<sorted.length;i++)for(let len=2;len<=5&&i+len<=sorted.length;len++){
    const g=sorted.slice(i,i+len),ys=g.map(t=>center(t.rect).y)
    if(Math.max(...ys)-Math.min(...ys)>.025)break
    if(g.slice(1).some((t,k)=>t.rect.x-(g[k].rect.x+g[k].rect.width)>.05))break
    out.push({
      text:g.map(t=>t.text).join(''),
      confidence:Math.min(...g.map(t=>t.confidence)),
      pageIndex:g[0].pageIndex,
      rect:union(g.map(t=>t.rect))
    })
  }
  return out
}

export function scoreOrientationText(text:string){
  const t=clean(text)
  const confirm=Math.max(sim(t,'확인합니다'), t.includes('확인합니다')?1:0)
  const signer=Math.max(
    t.includes('서명')?1:0,
    t.includes('(인)')?1:0,
    t.includes('인')?.55:0
  )
  const date=(t.includes('연월일')||t.includes('년월일')||(t.includes('년')&&t.includes('월')&&t.includes('일')))?1:0
  const hangul=(text.match(/[가-힣]/g)||[]).length
  return confirm*90 + date*65 + signer*55 + Math.min(25,hangul/10)
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

export function detectSigningClusters(tokens:OCRToken[],rotation:Rotation):SigningCluster[]{
  const all=joined(tokens)

  const confirms=all.filter(t=>sim(t.text,'확인합니다')>=.58 || clean(t.text).includes('확인합니다'))
  const dates=all.filter(t=>{
    const s=clean(t.text)
    return sim(s,'연월일')>=.62 || sim(s,'년월일')>=.62 || s==='년' || s==='월' || s==='일'
  })
  const signers=all.filter(t=>{
    const s=clean(t.text)
    return sim(s,'서명')>=.62 || sim(s,'(인)')>=.62 || s==='인' || sim(s,'성명')>=.68 || sim(s,'매수인')>=.68
  })

  const blocks:SigningCluster[]=[]

  // Strategy is strict:
  // one candidate exists only when confirm + date + signer are spatially close.
  for(const c of confirms){
    for(const d of dates){
      for(const s of signers){
        const cc=center(c.rect),dc=center(d.rect),sc=center(s.rect)
        const maxDy=Math.max(Math.abs(cc.y-dc.y),Math.abs(cc.y-sc.y),Math.abs(dc.y-sc.y))
        const maxDx=Math.max(Math.abs(cc.x-dc.x),Math.abs(cc.x-sc.x),Math.abs(dc.x-sc.x))
        if(maxDy>.20 || maxDx>.78) continue

        let score=180
        score-=maxDy*420
        score-=maxDx*50
        score+=sim(c.text,'확인합니다')*35
        score+=Math.min(18,(c.confidence+d.confidence+s.confidence)/14)

        const core=union([c.rect,d.rect,s.rect])
        const rotatedRect=clamp({
          x:Math.max(0,core.x-.07),
          y:Math.max(0,core.y-.06),
          width:Math.min(.92,Math.max(.48,core.width+.22)),
          height:Math.min(.34,Math.max(.14,core.height+.14))
        })

        blocks.push({
          pageIndex:c.pageIndex,
          rotation,
          rotatedRect,
          rect:unrotateRect(rotatedRect,rotation),
          confidence:Math.max(.35,Math.min(.99,score/210)),
          score,
          matched:{confirm:c.text,date:d.text,signer:s.text}
        })
      }
    }
  }

  return blocks.sort((a,b)=>b.score-a.score).slice(0,3)
}
