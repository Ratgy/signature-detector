
import type { ConfirmCandidate, NormalizedRect, OCRToken, Rotation } from './types'

const clean=(s:string)=>s.replace(/\s+/g,'').replace(/[.,:;_\-|]/g,'')
const clamp=(r:NormalizedRect):NormalizedRect=>{
  const x=Math.max(0,Math.min(1,r.x)), y=Math.max(0,Math.min(1,r.y))
  const x1=Math.max(x,Math.min(1,r.x+r.width)), y1=Math.max(y,Math.min(1,r.y+r.height))
  return {x,y,width:x1-x,height:y1-y}
}
function lev(a:string,b:string){
  const aa=clean(a),bb=clean(b),dp=Array.from({length:aa.length+1},()=>Array(bb.length+1).fill(0))
  for(let i=0;i<=aa.length;i++)dp[i][0]=i
  for(let j=0;j<=bb.length;j++)dp[0][j]=j
  for(let i=1;i<=aa.length;i++)for(let j=1;j<=bb.length;j++){
    const c=aa[i-1]===bb[j-1]?0:1
    dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+c)
  }
  return dp[aa.length][bb.length]
}
export function similarity(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb)return 0
  if(aa===bb)return 1
  if(aa.includes(bb)||bb.includes(aa))return Math.min(.99,.80+Math.min(aa.length,bb.length)/Math.max(aa.length,bb.length)*.18)
  return 1-lev(aa,bb)/Math.max(aa.length,bb.length)
}
export function scoreFastText(text:string){
  const t=clean(text)
  const exact=t.includes('확인합니다')
  const sim=similarity(t,'확인합니다')
  return {score:exact?150:sim>=.68?90+sim*40:0,found:exact||sim>=.68}
}
function joined(tokens:OCRToken[]){
  const out=[...tokens], sorted=[...tokens].sort((a,b)=>(a.rect.y+a.rect.height/2)-(b.rect.y+b.rect.height/2)||a.rect.x-b.rect.x)
  for(let i=0;i<sorted.length;i++)for(let len=2;len<=5&&i+len<=sorted.length;len++){
    const g=sorted.slice(i,i+len),ys=g.map(t=>t.rect.y+t.rect.height/2)
    if(Math.max(...ys)-Math.min(...ys)>.022)break
    if(g.slice(1).some((t,k)=>t.rect.x-(g[k].rect.x+g[k].rect.width)>.045))break
    const x0=Math.min(...g.map(t=>t.rect.x)),y0=Math.min(...g.map(t=>t.rect.y))
    const x1=Math.max(...g.map(t=>t.rect.x+t.rect.width)),y1=Math.max(...g.map(t=>t.rect.y+t.rect.height))
    out.push({text:g.map(t=>t.text).join(''),confidence:Math.min(...g.map(t=>t.confidence)),pageIndex:g[0].pageIndex,rect:{x:x0,y:y0,width:x1-x0,height:y1-y0}})
  }
  return out
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
export function findConfirmCandidate(tokens:OCRToken[],rotation:Rotation):ConfirmCandidate|null{
  let best:{token:OCRToken,score:number}|null=null
  for(const t of joined(tokens)){
    const s=similarity(t.text,'확인합니다')
    if(s<.62)continue
    const score=s*100+t.confidence*.25
    if(!best||score>best.score)best={token:t,score}
  }
  if(!best)return null
  const a=best.token.rect
  const cropRotated=clamp({
    x:Math.max(0,a.x-.28), y:Math.max(0,a.y-.075),
    width:Math.min(.92,Math.max(.62,a.width+.56)),
    height:Math.min(.30,Math.max(.16,a.height+.19))
  })
  return {
    pageIndex:best.token.pageIndex, rotation,
    anchorRect:unrotateRect(a,rotation), cropRect:unrotateRect(cropRotated,rotation),
    confidence:Math.max(.35,Math.min(.99,best.score/125)), anchorText:best.token.text
  }
}
