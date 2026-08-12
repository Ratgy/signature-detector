import type { KeywordMatch, NormalizedRect, OCRToken, Rotation, ScoreBreakdown, SignatureCandidate } from './types'

const KEYWORDS = [
  { text: '매수인', weight: 58 },
  { text: '서명', weight: 48 },
  { text: '(인)', weight: 42 },
  { text: '인', weight: 15 },
  { text: '연월일', weight: 52 },
  { text: '년월일', weight: 50 },
  { text: '년', weight: 13 },
  { text: '월', weight: 13 },
  { text: '일', weight: 13 },
]

const clean = (s: string) =>
  s.replace(/\s+/g, '').replace(/[.,:;_\-|]/g, '').replace(/[［\[]/g, '(').replace(/[］\]]/g, ')')

function levenshtein(a: string, b: string) {
  const aa = clean(a), bb = clean(b)
  const dp = Array.from({ length: aa.length + 1 }, () => Array(bb.length + 1).fill(0))
  for (let i = 0; i <= aa.length; i++) dp[i][0] = i
  for (let j = 0; j <= bb.length; j++) dp[0][j] = j
  for (let i = 1; i <= aa.length; i++) for (let j = 1; j <= bb.length; j++) {
    const c = aa[i - 1] === bb[j - 1] ? 0 : 1
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c)
  }
  return dp[aa.length][bb.length]
}
function similarity(a: string, b: string) {
  const aa = clean(a), bb = clean(b)
  if (!aa || !bb) return 0
  if (aa.includes(bb) || bb.includes(aa)) return Math.min(1, Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length) + .16)
  return 1 - levenshtein(aa, bb) / Math.max(aa.length, bb.length)
}
const center = (r: NormalizedRect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
function union(rs: NormalizedRect[]) {
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y))
  const x1 = Math.max(...rs.map(r => r.x + r.width)), y1 = Math.max(...rs.map(r => r.y + r.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
function clamp(r: NormalizedRect) {
  const x = Math.max(0, Math.min(1, r.x)), y = Math.max(0, Math.min(1, r.y))
  const x1 = Math.max(x, Math.min(1, r.x + r.width)), y1 = Math.max(y, Math.min(1, r.y + r.height))
  return { x, y, width: x1 - x, height: y1 - y }
}
function tightExpand(r: NormalizedRect) {
  // Deliberately tight: signature/date row only, not a large half-page crop.
  return clamp({
    x: r.x - .035,
    y: r.y - .035,
    width: Math.max(.18, r.width + .20),
    height: Math.max(.075, r.height + .075),
  })
}
function dist(a: NormalizedRect, b: NormalizedRect) {
  const A = center(a), B = center(b)
  return Math.hypot(A.x - B.x, A.y - B.y)
}
export function unrotateRect(r: NormalizedRect, rotation: Rotation): NormalizedRect {
  if (rotation === 0) return r
  const pts = [[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].map(([x,y]) => {
    if (rotation === 90) return [y, 1-x]
    if (rotation === 180) return [1-x, 1-y]
    return [1-y, x]
  })
  const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1])
  return clamp({x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)})
}
function buildNgrams(tokens: OCRToken[]) {
  const out = [...tokens]
  const sorted = [...tokens].sort((a,b)=>center(a.rect).y-center(b.rect).y || a.rect.x-b.rect.x)
  for (let i=0;i<sorted.length;i++) for (let len=2;len<=4 && i+len<=sorted.length;len++) {
    const g=sorted.slice(i,i+len), ys=g.map(t=>center(t.rect).y)
    if (Math.max(...ys)-Math.min(...ys)>.017) break
    if (g.slice(1).some((t,k)=>t.rect.x-(g[k].rect.x+g[k].rect.width)>.028)) break
    out.push({text:g.map(t=>t.text).join(''),confidence:Math.min(...g.map(t=>t.confidence)),rect:union(g.map(t=>t.rect)),pageIndex:g[0].pageIndex})
  }
  return out
}
function matches(tokens: OCRToken[]): KeywordMatch[] {
  const out: KeywordMatch[]=[]
  for (const t of buildNgrams(tokens)) for (const kw of KEYWORDS) {
    const s=similarity(t.text,kw.text)
    const threshold=kw.text.length===1 ? .99 : kw.text.length===2 ? .82 : .68
    if (s>=threshold) out.push({...t,keyword:kw.text,similarity:s,weight:kw.weight})
  }
  return out
}
function dateLike(ms: KeywordMatch[]) {
  const ks = new Set(ms.map(m=>m.keyword))
  return ks.has('연월일') || ks.has('년월일') || (ks.has('년') && ks.has('월') && ks.has('일'))
}
function validCluster(ms: KeywordMatch[]) {
  const ks=new Set(ms.map(m=>m.keyword))
  // We only accept clusters that contain a date pattern and a signature/person anchor.
  return dateLike(ms) && (ks.has('매수인') || ks.has('서명') || ks.has('(인)') || ks.has('인'))
}
export function detectSignatureCandidates(tokens: OCRToken[], rotation: Rotation): SignatureCandidate[] {
  const ms=matches(tokens)
  const out: SignatureCandidate[]=[]
  for (const seed of ms) {
    const s=center(seed.rect)
    const cluster=ms.filter(m=>{
      const c=center(m.rect)
      return Math.abs(c.y-s.y)<.09 && Math.abs(c.x-s.x)<.58
    })
    if (!validCluster(cluster)) continue
    const core=union(cluster.map(m=>m.rect))
    const rotatedRect=tightExpand(core)
    const uniq=[...new Map(cluster.map(m=>[m.keyword,m])).values()]
    const keyword=uniq.reduce((a,m)=>a+m.weight*m.similarity,0)
    let proximity=0
    for (let i=0;i<uniq.length;i++) for(let j=i+1;j<uniq.length;j++) {
      const d=dist(uniq[i].rect,uniq[j].rect)
      if (d<.16) proximity+=Math.max(0,10*(1-d/.16))
    }
    const layout=Math.min(24, uniq.filter(m=>Math.abs(center(m.rect).y-center(seed.rect).y)<.025).length*4)
    const position=center(rotatedRect).y>.55 ? 6 : 0
    const avg=uniq.reduce((a,m)=>a+m.confidence,0)/Math.max(1,uniq.length)
    const ocr=Math.max(-8,Math.min(10,(avg-55)*.24))
    const score=keyword+proximity+layout+position+ocr
    const confidence=Math.max(0,Math.min(.99,(score/180)*.82+(avg/100)*.18))
    const breakdown:ScoreBreakdown={keyword,proximity,layout,position,ocr}
    out.push({
      id:`${seed.pageIndex}-${rotation}-${out.length}`,
      pageIndex:seed.pageIndex,
      rect:unrotateRect(rotatedRect,rotation),
      rotatedRect,
      rotation,
      score,
      confidence,
      matchedKeywords:[...new Set(cluster.map(m=>m.keyword))],
      breakdown,
    })
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,3)
}

// Fast pass score: choose page + orientation using text only.
export function scoreFastText(text: string) {
  const t=clean(text)
  let score=0
  const hits:string[]=[]
  const add=(k:string,w:number)=>{ if(t.includes(k)){score+=w;hits.push(k)}}
  add('성능점검',18); add('자동차',8); add('매수인',38); add('연월일',42); add('년월일',40); add('서명',34)
  if (t.includes('년') && t.includes('월') && t.includes('일')) { score+=28; hits.push('년·월·일') }
  if (t.includes('(인)') || t.includes('인')) { score+=10; hits.push('인') }
  // basic Hangul amount helps orientation selection even when keywords OCR imperfectly
  const hangul=(text.match(/[가-힣]/g)||[]).length
  score += Math.min(35, hangul/8)
  return { score, hits, hangul }
}
