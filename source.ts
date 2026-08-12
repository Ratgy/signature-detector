import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { OCRToken, Rect, SearchRegion } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

export type LoadedSource =
  | {type:'pdf'; pdf:PDFDocumentProxy; pageCount:number}
  | {type:'image'; image:HTMLImageElement; pageCount:1}

export async function loadSource(file:File):Promise<LoadedSource>{
  const n=file.name.toLowerCase()

  if(file.type==='application/pdf'||n.endsWith('.pdf')){
    const pdf=await pdfjsLib.getDocument({
      data:new Uint8Array(await file.arrayBuffer())
    }).promise
    return{type:'pdf',pdf,pageCount:pdf.numPages}
  }

  if(
    file.type==='image/jpeg'||
    file.type==='image/png'||
    n.endsWith('.jpg')||
    n.endsWith('.jpeg')||
    n.endsWith('.png')
  ){
    const url=URL.createObjectURL(file)
    const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
      const img=new Image()
      img.onload=()=>{
        URL.revokeObjectURL(url)
        resolve(img)
      }
      img.onerror=e=>{
        URL.revokeObjectURL(url)
        reject(e)
      }
      img.src=url
    })
    return{type:'image',image,pageCount:1}
  }

  throw new Error('PDF/JPG/PNG만 지원합니다.')
}

export async function getPageSize(src:LoadedSource,pageIndex:number){
  if(src.type==='image'){
    return{width:src.image.naturalWidth,height:src.image.naturalHeight}
  }

  const page=await src.pdf.getPage(pageIndex+1)
  const vp=page.getViewport({scale:1})
  return{width:vp.width,height:vp.height}
}

// v13 핵심:
// 1) 마지막 PDF 페이지부터 확인
// 2) 가로로 2쪽이 붙어 있으면 논리 페이지를 좌/우로 분리
// 3) 각 논리 페이지의 하단부터 확인
export async function buildSearchRegions(src:LoadedSource):Promise<SearchRegion[]>{
  const regions:SearchRegion[]=[]
  let priority=0

  // 위치를 가정하지 않는다. 모든 물리 페이지를 검사하고,
  // 가로 2쪽 스캔은 먼저 좌/우 논리 페이지로 분리한다.
  for(let pageIndex=0;pageIndex<src.pageCount;pageIndex++){
    const {width,height}=await getPageSize(src,pageIndex)
    const spread=width/height>1.18

    const panels=spread
      ?[
          {id:'left', x:0,    width:.52},
          {id:'right',x:.48,  width:.52},
        ]
      :[
          {id:'page', x:0, width:1},
        ]

    for(const panel of panels){
      // 상/중/하 위치를 하드코딩하지 않고 두 개의 겹치는 반쪽으로 전체 높이를 커버한다.
      // target block 높이가 작기 때문에 어느 위치에 있어도 최소 한 ROI 안에 온전히 들어간다.
      regions.push({
        id:`p${pageIndex}-${panel.id}-upper`,
        pageIndex,
        priority:priority++,
        rect:{x:panel.x,y:0,width:panel.width,height:.58}
      })
      regions.push({
        id:`p${pageIndex}-${panel.id}-lower`,
        pageIndex,
        priority:priority++,
        rect:{x:panel.x,y:.42,width:panel.width,height:.58}
      })
    }

    // 실제 한 장짜리 landscape 서식이 중앙을 가로지르는 경우를 위한 fallback.
    // OCR 1차에서는 건너뛰고 split panel에서 못 찾았을 때만 사용한다.
    if(spread){
      regions.push({
        id:`p${pageIndex}-wide-upper`,
        pageIndex,
        priority:priority++,
        rect:{x:0,y:0,width:1,height:.58}
      })
      regions.push({
        id:`p${pageIndex}-wide-lower`,
        pageIndex,
        priority:priority++,
        rect:{x:0,y:.42,width:1,height:.58}
      })
    }
  }

  return regions
}

async function renderPdfPage(
  page:PDFPageProxy,
  targetLongSide:number
){
  const base=page.getViewport({scale:1})
  const scale=Math.max(
    .55,
    Math.min(
      3.0,
      targetLongSide/Math.max(base.width,base.height)
    )
  )
  const vp=page.getViewport({scale})

  const canvas=document.createElement('canvas')
  canvas.width=Math.ceil(vp.width)
  canvas.height=Math.ceil(vp.height)

  const ctx=canvas.getContext(
    '2d',
    {willReadFrequently:true}
  )!

  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,canvas.width,canvas.height)

  await page.render({
    canvasContext:ctx,
    viewport:vp,
    canvas
  }).promise

  return canvas
}

function renderImagePage(
  img:HTMLImageElement,
  targetLongSide:number
){
  const srcLong=Math.max(
    img.naturalWidth,
    img.naturalHeight
  )

  // 사진은 원본이 작아도 OCR 전처리를 위해 최대 2.6배까지만 확대.
  const scale=Math.min(
    2.6,
    Math.max(.5,targetLongSide/srcLong)
  )

  const canvas=document.createElement('canvas')
  canvas.width=Math.max(
    1,
    Math.round(img.naturalWidth*scale)
  )
  canvas.height=Math.max(
    1,
    Math.round(img.naturalHeight*scale)
  )

  const ctx=canvas.getContext(
    '2d',
    {willReadFrequently:true}
  )!

  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,canvas.width,canvas.height)
  ctx.imageSmoothingEnabled=true
  ctx.imageSmoothingQuality='high'

  ctx.drawImage(
    img,
    0,0,
    canvas.width,
    canvas.height
  )

  return canvas
}

export async function renderPage(
  src:LoadedSource,
  pageIndex:number,
  targetLongSide=1900
){
  if(src.type==='image'){
    return renderImagePage(
      src.image,
      targetLongSide
    )
  }

  const page=await src.pdf.getPage(pageIndex+1)
  return renderPdfPage(
    page,
    targetLongSide
  )
}

export function cropRegion(
  pageCanvas:HTMLCanvasElement,
  rect:Rect,
  targetLongSide=1450
){
  const sx=Math.max(
    0,
    Math.floor(rect.x*pageCanvas.width)
  )
  const sy=Math.max(
    0,
    Math.floor(rect.y*pageCanvas.height)
  )
  const sw=Math.max(
    1,
    Math.min(
      pageCanvas.width-sx,
      Math.ceil(rect.width*pageCanvas.width)
    )
  )
  const sh=Math.max(
    1,
    Math.min(
      pageCanvas.height-sy,
      Math.ceil(rect.height*pageCanvas.height)
    )
  )

  const scale=Math.max(
    1,
    Math.min(
      2.2,
      targetLongSide/Math.max(sw,sh)
    )
  )

  const out=document.createElement('canvas')
  out.width=Math.max(1,Math.round(sw*scale))
  out.height=Math.max(1,Math.round(sh*scale))

  const ctx=out.getContext(
    '2d',
    {willReadFrequently:true}
  )!

  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,out.width,out.height)
  ctx.imageSmoothingEnabled=true
  ctx.imageSmoothingQuality='high'

  ctx.drawImage(
    pageCanvas,
    sx,sy,sw,sh,
    0,0,out.width,out.height
  )

  return out
}

export function preprocess(
  source:HTMLCanvasElement,
  mode:'gray'|'adaptive'='gray'
){
  const out=document.createElement('canvas')
  out.width=source.width
  out.height=source.height
  const ctx=out.getContext('2d',{willReadFrequently:true})!
  ctx.drawImage(source,0,0)

  const img=ctx.getImageData(0,0,out.width,out.height)
  const d=img.data

  if(mode==='gray'){
    for(let i=0;i<d.length;i+=4){
      const g=.299*d[i]+.587*d[i+1]+.114*d[i+2]
      let v=(g-128)*1.32+132
      v=Math.max(0,Math.min(255,v))
      d[i]=d[i+1]=d[i+2]=v
    }
    ctx.putImageData(img,0,0)
    return out
  }

  // 사진 촬영본의 조명/그림자 대응용 간단 adaptive threshold.
  const w=out.width,h=out.height
  const gray=new Uint8Array(w*h)
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4
      gray[y*w+x]=Math.round(.299*d[i]+.587*d[i+1]+.114*d[i+2])
    }
  }

  const integral=new Float64Array((w+1)*(h+1))
  for(let y=1;y<=h;y++){
    let row=0
    for(let x=1;x<=w;x++){
      row+=gray[(y-1)*w+(x-1)]
      integral[y*(w+1)+x]=integral[(y-1)*(w+1)+x]+row
    }
  }

  const radius=Math.max(12,Math.round(Math.min(w,h)*.018))
  const bias=12

  for(let y=0;y<h;y++){
    const y0=Math.max(0,y-radius)
    const y1=Math.min(h-1,y+radius)
    for(let x=0;x<w;x++){
      const x0=Math.max(0,x-radius)
      const x1=Math.min(w-1,x+radius)

      const A=integral[y0*(w+1)+x0]
      const B=integral[y0*(w+1)+(x1+1)]
      const C=integral[(y1+1)*(w+1)+x0]
      const D=integral[(y1+1)*(w+1)+(x1+1)]
      const area=(x1-x0+1)*(y1-y0+1)
      const mean=(D-B-C+A)/area

      const v=gray[y*w+x] < mean-bias ? 0 : 255
      const i=(y*w+x)*4
      d[i]=d[i+1]=d[i+2]=v
    }
  }

  ctx.putImageData(img,0,0)
  return out
}

export function remapTokens(
  tokens:OCRToken[],
  region:SearchRegion
):OCRToken[]{
  return tokens.map(t=>({
    ...t,
    rect:{
      x:region.rect.x+t.rect.x*region.rect.width,
      y:region.rect.y+t.rect.y*region.rect.height,
      width:t.rect.width*region.rect.width,
      height:t.rect.height*region.rect.height
    }
  }))
}

export async function getNativePdfTokens(
  src:LoadedSource,
  pageIndex:number
):Promise<OCRToken[]>{
  if(src.type!=='pdf')return[]

  try{
    const page=await src.pdf.getPage(pageIndex+1)
    const viewport=page.getViewport({scale:1})
    const content=await page.getTextContent()
    const out:OCRToken[]=[]

    for(const item of content.items as any[]){
      const text=String(item?.str ?? '').trim()
      if(!text)continue

      const tx=pdfjsLib.Util.transform(
        viewport.transform,
        item.transform
      )

      const height=Math.max(
        1,
        Math.hypot(tx[2],tx[3])
      )
      const width=Math.max(
        1,
        Number(item.width ?? 0)*viewport.scale
      )

      out.push({
        text,
        confidence:100,
        pageIndex,
        rect:{
          x:tx[4]/viewport.width,
          y:(tx[5]-height)/viewport.height,
          width:width/viewport.width,
          height:height/viewport.height
        }
      })
    }

    return out
  }catch{
    return[]
  }
}

export function filterTokensInRect(tokens:OCRToken[],rect:Rect){
  return tokens.filter(t=>{
    const x=t.rect.x+t.rect.width/2
    const y=t.rect.y+t.rect.height/2
    return x>=rect.x && x<=rect.x+rect.width &&
      y>=rect.y && y<=rect.y+rect.height
  })
}


export async function renderFinalCrop(
  src:LoadedSource,
  pageIndex:number,
  rect:Rect,
  marginPx=40
){
  const pageCanvas=await renderPage(
    src,
    pageIndex,
    2300
  )

  const mx=marginPx/pageCanvas.width
  const my=marginPx/pageCanvas.height

  const expanded:Rect={
    x:Math.max(0,rect.x-mx),
    y:Math.max(0,rect.y-my),
    width:Math.min(
      1-Math.max(0,rect.x-mx),
      rect.width+mx*2
    ),
    height:Math.min(
      1-Math.max(0,rect.y-my),
      rect.height+my*2
    )
  }

  return cropRegion(
    pageCanvas,
    expanded,
    1800
  )
}
