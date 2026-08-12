import type { NormalizedRect, OCRToken, Rotation, SignatureTarget } from './types'

const clean = (s:string) => s.replace(/\s+/g,'').replace(/[.,:;_\-|]/g,'').replace(/[［\[]/g,'(').replace(/[］\]]/g,')')
const center=(r:NormalizedRect)=>({x:r.x+r.width/2,y:r.y+r.height/2})
const clamp=(r:NormalizedRect):NormalizedRect=>{
  const x=Math.max(0,Math.min(1,r.x)),y=Math.max(0,Math.min(1,r.y))
  const x1=Math.max(x,Math.min(1,r.x+r.width)),y1=Math.max(y,Math.min(1,r.y+r.height))
  return{x,y,width:x1-x,height:y1-y}
}

export function scoreFastText(text:string){
  const t=clean(text)
  let score=0
  const hits:string[]=[]
  const add=(k:string,w:number)=>{if(t.includes(k)){score+=w;hits.push(k)}}
  add('성능점검',14)
  add('자동차',5)
  add('연월일',42)
  add('년월일',40)
  add('매수인',40)
  add('서명',34)
  add('(인)',28)
  if(t.includes('년')&&t.includes('월')&&t.includes('일')){score+=32;hits.push('년·월·일')}
  if(t.includes('확인합니다')){score+=14;hits.push('확인합니다')}
  const hangul=(text.match(/[가-힣]/g)||[]).length
  score+=Math.min(25,hangul/10)
  return{score,hits,hangul}
}

function has(token:OCRToken, keyword:string){
  return clean(token.text).includes(keyword)
}

function union(rs:NormalizedRect[]):NormalizedRect{
  const x0=Math.min(...rs.map(r=>r.x)),y0=Math.min(...rs.map(r=>r.y))
  const x1=Math.max(...rs.map(r=>r.x+r.width)),y1=Math.max(...rs.map(r=>r.y+r.height))
  return{x:x0,y:y0,width:x1-x0,height:y1-y0}
}

// Convert OCR token rect from bottom-band coordinates back to full rotated-page coordinates.
export function roiTokenToPage(token: OCRToken, roi: NormalizedRect): OCRToken {
  return {
    ...token,
    rect: {
      x: roi.x + token.rect.x * roi.width,
      y: roi.y + token.rect.y * roi.height,
      width: token.rect.width * roi.width,
      height: token.rect.height * roi.height,
    },
  }
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

// Estimate "empty writing area" around the actual date / buyer-signature line.
// Important: this does NOT use a giant keyword cluster. It makes a small target around the final row.
export function detectExactSignatureTarget(
  pageTokens: OCRToken[],
  rotation: Rotation,
): SignatureTarget | null {
  const dateTokens = pageTokens.filter(t => has(t,'연월일') || has(t,'년월일') || ['년','월','일'].includes(clean(t.text)))
  const buyerTokens = pageTokens.filter(t => has(t,'매수인') || has(t,'서명') || has(t,'(인)'))
  if (!dateTokens.length && !buyerTokens.length) return null

  // Prefer anchors closest to the bottom of the page.
  const date = [...dateTokens].sort((a,b)=>center(b.rect).y-center(a.rect).y)[0]
  const buyer = [...buyerTokens].sort((a,b)=>center(b.rect).y-center(a.rect).y)[0]

  let rotated: NormalizedRect
  let source: SignatureTarget['source']
  let confidence = .58

  if (date && buyer && Math.abs(center(date.rect).y-center(buyer.rect).y) < .09) {
    const y0=Math.min(date.rect.y,buyer.rect.y)
    const y1=Math.max(date.rect.y+date.rect.height,buyer.rect.y+buyer.rect.height)
    const anchor=union([date.rect,buyer.rect])
    // Keep only one final signing row, with enough horizontal room for date/name/signature.
    rotated=clamp({
      x: Math.max(0, Math.min(date.rect.x,buyer.rect.x)-.045),
      y: Math.max(0, y0-.035),
      width: Math.min(.78, Math.max(.50, anchor.width+.32)),
      height: Math.min(.13, Math.max(.075, y1-y0+.07)),
    })
    source='date-anchor'
    confidence=.91
  } else if (date) {
    // Date row usually precedes or shares the signing line.
    rotated=clamp({
      x: Math.max(0,date.rect.x-.06),
      y: Math.max(0,date.rect.y-.04),
      width: Math.min(.82,Math.max(.58,date.rect.width+.48)),
      height: .105,
    })
    source='date-anchor'
    confidence=.80
  } else {
    rotated=clamp({
      x: Math.max(0,buyer.rect.x-.09),
      y: Math.max(0,buyer.rect.y-.04),
      width: Math.min(.75,Math.max(.48,buyer.rect.width+.38)),
      height: .105,
    })
    source='buyer-anchor'
    confidence=.73
  }

  return {
    pageIndex: pageTokens[0]?.pageIndex ?? 0,
    rotation,
    rect: unrotateRect(rotated, rotation),
    source,
    confidence,
  }
}
