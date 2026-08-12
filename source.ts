import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { OCRToken, Rect, StripSpec } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

export type LoadedSource =
  | {type:'pdf';pdf:PDFDocumentProxy;pageCount:number}
  | {type:'image';image:HTMLImageElement;pageCount:1}

export interface ContactMeta {
  strip:StripSpec
  x:number
  y:number
  width:number
  height:number
}

export async function loadSource(file:File):Promise<LoadedSource>{
  const name=file.name.toLowerCase()

  if(file.type==='application/pdf'||name.endsWith('.pdf')){
    const pdf=await pdfjsLib.getDocument({
      data:new Uint8Array(await file.arrayBuffer())
    }).promise

    return{
      type:'pdf',
      pdf,
      pageCount:pdf.numPages
    }
  }

  if(
    file.type==='image/jpeg'||
    file.type==='image/png'||
    name.endsWith('.jpg')||
    name.endsWith('.jpeg')||
    name.endsWith('.png')
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

    return{
      type:'image',
      image,
      pageCount:1
    }
  }

  throw new Error('PDF/JPG/PNG만 지원합니다.')
}

async function renderPdfPage(
  page:PDFPageProxy,
  targetLongSide:number
){
  const base=page.getViewport({scale:1})
  const scale=Math.max(
    .5,
    Math.min(
      3,
      targetLongSide/
      Math.max(base.width,base.height)
    )
  )

  const viewport=page.getViewport({scale})

  const canvas=document.createElement('canvas')
  canvas.width=Math.ceil(viewport.width)
  canvas.height=Math.ceil(viewport.height)

  const ctx=canvas.getContext(
    '2d',
    {willReadFrequently:true}
  )!

  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,canvas.width,canvas.height)

  await page.render({
    canvasContext:ctx,
    viewport,
    canvas
  }).promise

  return canvas
}

function renderImagePage(
  image:HTMLImageElement,
  targetLongSide:number
){
  const sourceLong=Math.max(
    image.naturalWidth,
    image.naturalHeight
  )

  const scale=Math.max(
    .5,
    Math.min(
      2.4,
      targetLongSide/sourceLong
    )
  )

  const canvas=document.createElement('canvas')
  canvas.width=Math.max(
    1,
    Math.round(image.naturalWidth*scale)
  )
  canvas.height=Math.max(
    1,
    Math.round(image.naturalHeight*scale)
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
    image,
    0,0,
    canvas.width,
    canvas.height
  )

  return canvas
}

export async function renderPage(
  src:LoadedSource,
  pageIndex:number,
  targetLongSide=1800
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

function panelsForCanvas(
  canvas:HTMLCanvasElement,
  splitWide=true
){
  const aspect=canvas.width/canvas.height

  if(splitWide && aspect>1.22){
    return[
      {
        id:'left',
        rect:{x:0,y:0,width:.52,height:1}
      },
      {
        id:'right',
        rect:{x:.48,y:0,width:.52,height:1}
      }
    ]
  }

  return[
    {
      id:'full',
      rect:{x:0,y:0,width:1,height:1}
    }
  ]
}

export function buildStrips(
  canvas:HTMLCanvasElement,
  pageIndex:number,
  splitWide=true
):StripSpec[]{
  const panels=panelsForCanvas(
    canvas,
    splitWide
  )

  const starts=[0,.22,.44,.66]
  const height=.34
  const strips:StripSpec[]=[]

  for(const panel of panels){
    for(let i=0;i<starts.length;i++){
      const y=starts[i]

      strips.push({
        id:`p${pageIndex}-${panel.id}-${i}`,
        pageIndex,
        panelId:panel.id,
        rect:{
          x:panel.rect.x,
          y,
          width:panel.rect.width,
          height:Math.min(height,1-y)
        }
      })
    }
  }

  return strips
}

function cropRaw(
  source:HTMLCanvasElement,
  rect:Rect
){
  const sx=Math.max(
    0,
    Math.floor(rect.x*source.width)
  )
  const sy=Math.max(
    0,
    Math.floor(rect.y*source.height)
  )
  const sw=Math.max(
    1,
    Math.min(
      source.width-sx,
      Math.ceil(rect.width*source.width)
    )
  )
  const sh=Math.max(
    1,
    Math.min(
      source.height-sy,
      Math.ceil(rect.height*source.height)
    )
  )

  const canvas=document.createElement('canvas')
  canvas.width=sw
  canvas.height=sh

  canvas.getContext('2d')!.drawImage(
    source,
    sx,sy,sw,sh,
    0,0,sw,sh
  )

  return canvas
}

export function preprocess(
  source:HTMLCanvasElement,
  mode:'gray'|'adaptive'
){
  const out=document.createElement('canvas')
  out.width=source.width
  out.height=source.height

  const ctx=out.getContext(
    '2d',
    {willReadFrequently:true}
  )!

  ctx.drawImage(source,0,0)

  const image=ctx.getImageData(
    0,0,out.width,out.height
  )
  const data=image.data

  if(mode==='gray'){
    for(let i=0;i<data.length;i+=4){
      const gray=
        .299*data[i]+
        .587*data[i+1]+
        .114*data[i+2]

      let value=
        (gray-128)*1.38+134

      if(value>225)value=250
      if(value<65)value=28

      value=Math.max(
        0,
        Math.min(255,value)
      )

      data[i]=
      data[i+1]=
      data[i+2]=value
    }

    ctx.putImageData(image,0,0)
    return out
  }

  const width=out.width
  const height=out.height
  const gray=new Uint8Array(width*height)

  for(let y=0;y<height;y++){
    for(let x=0;x<width;x++){
      const i=(y*width+x)*4

      gray[y*width+x]=Math.round(
        .299*data[i]+
        .587*data[i+1]+
        .114*data[i+2]
      )
    }
  }

  const integral=new Uint32Array(
    (width+1)*(height+1)
  )

  for(let y=1;y<=height;y++){
    let row=0

    for(let x=1;x<=width;x++){
      row+=gray[
        (y-1)*width+(x-1)
      ]

      integral[
        y*(width+1)+x
      ]=
        integral[
          (y-1)*(width+1)+x
        ]+
        row
    }
  }

  const radius=Math.max(
    10,
    Math.round(
      Math.min(width,height)*.015
    )
  )

  for(let y=0;y<height;y++){
    const y0=Math.max(0,y-radius)
    const y1=Math.min(height-1,y+radius)

    for(let x=0;x<width;x++){
      const x0=Math.max(0,x-radius)
      const x1=Math.min(width-1,x+radius)

      const stride=width+1

      const A=integral[
        y0*stride+x0
      ]
      const B=integral[
        y0*stride+(x1+1)
      ]
      const C=integral[
        (y1+1)*stride+x0
      ]
      const D=integral[
        (y1+1)*stride+(x1+1)
      ]

      const area=
        (x1-x0+1)*
        (y1-y0+1)

      const mean=
        (D-B-C+A)/area

      const value=
        gray[y*width+x]<
        mean-11
          ?0
          :255

      const i=(y*width+x)*4

      data[i]=
      data[i+1]=
      data[i+2]=value
    }
  }

  ctx.putImageData(image,0,0)
  return out
}

export function buildContactSheet(
  pageCanvas:HTMLCanvasElement,
  strips:StripSpec[],
  mode:'gray'|'adaptive',
  targetWidth=1120
){
  const gap=22
  const rendered:{
    strip:StripSpec
    canvas:HTMLCanvasElement
  }[]=[]

  let totalHeight=gap

  for(const strip of strips){
    const raw=cropRaw(
      pageCanvas,
      strip.rect
    )

    const scale=
      targetWidth/raw.width

    const resized=document.createElement('canvas')
    resized.width=targetWidth
    resized.height=Math.max(
      1,
      Math.round(raw.height*scale)
    )

    const ctx=resized.getContext(
      '2d',
      {willReadFrequently:true}
    )!

    ctx.fillStyle='#fff'
    ctx.fillRect(
      0,0,
      resized.width,
      resized.height
    )

    ctx.imageSmoothingEnabled=true
    ctx.imageSmoothingQuality='high'

    ctx.drawImage(
      raw,
      0,0,
      resized.width,
      resized.height
    )

    rendered.push({
      strip,
      canvas:preprocess(
        resized,
        mode
      )
    })

    totalHeight+=
      resized.height+
      gap
  }

  const sheet=document.createElement('canvas')
  sheet.width=targetWidth
  sheet.height=Math.max(1,totalHeight)

  const ctx=sheet.getContext(
    '2d',
    {willReadFrequently:true}
  )!

  ctx.fillStyle='#fff'
  ctx.fillRect(
    0,0,
    sheet.width,
    sheet.height
  )

  const metas:ContactMeta[]=[]
  let y=gap

  for(const item of rendered){
    ctx.drawImage(
      item.canvas,
      0,y
    )

    metas.push({
      strip:item.strip,
      x:0,
      y,
      width:item.canvas.width,
      height:item.canvas.height
    })

    y+=
      item.canvas.height+
      gap
  }

  return{
    canvas:sheet,
    metas
  }
}

export function tokensForMeta(
  contactTokens:OCRToken[],
  sheet:HTMLCanvasElement,
  meta:ContactMeta
):OCRToken[]{
  const result:OCRToken[]=[]

  for(const token of contactTokens){
    const px={
      x:token.rect.x*sheet.width,
      y:token.rect.y*sheet.height,
      width:token.rect.width*sheet.width,
      height:token.rect.height*sheet.height
    }

    const centerY=
      px.y+
      px.height/2

    if(
      centerY<meta.y ||
      centerY>meta.y+meta.height
    ){
      continue
    }

    result.push({
      ...token,
      pageIndex:meta.strip.pageIndex,
      rect:{
        x:Math.max(
          0,
          Math.min(
            1,
            (px.x-meta.x)/meta.width
          )
        ),
        y:Math.max(
          0,
          Math.min(
            1,
            (px.y-meta.y)/meta.height
          )
        ),
        width:Math.max(
          0,
          Math.min(
            1,
            px.width/meta.width
          )
        ),
        height:Math.max(
          0,
          Math.min(
            1,
            px.height/meta.height
          )
        )
      }
    })
  }

  return result
}

export async function getNativePdfTokens(
  src:LoadedSource,
  pageIndex:number
):Promise<OCRToken[]>{
  if(src.type!=='pdf')return[]

  try{
    const page=await src.pdf.getPage(
      pageIndex+1
    )

    const viewport=page.getViewport({
      scale:1
    })

    const content=await page.getTextContent()
    const tokens:OCRToken[]=[]

    for(const item of content.items as any[]){
      const text=String(
        item?.str ?? ''
      ).trim()

      if(!text)continue

      const transform=
        pdfjsLib.Util.transform(
          viewport.transform,
          item.transform
        )

      const height=Math.max(
        1,
        Math.hypot(
          transform[2],
          transform[3]
        )
      )

      const width=Math.max(
        1,
        Number(item.width ?? 0)*
        viewport.scale
      )

      tokens.push({
        text,
        confidence:100,
        pageIndex,
        rect:{
          x:transform[4]/
            viewport.width,
          y:(transform[5]-height)/
            viewport.height,
          width:width/
            viewport.width,
          height:height/
            viewport.height
        }
      })
    }

    return tokens
  }catch{
    return[]
  }
}

export function tokensInsideRect(
  tokens:OCRToken[],
  rect:Rect
){
  return tokens
    .filter(token=>{
      const x=
        token.rect.x+
        token.rect.width/2
      const y=
        token.rect.y+
        token.rect.height/2

      return(
        x>=rect.x &&
        x<=rect.x+rect.width &&
        y>=rect.y &&
        y<=rect.y+rect.height
      )
    })
    .map(token=>({
      ...token,
      rect:{
        x:
          (token.rect.x-rect.x)/
          rect.width,
        y:
          (token.rect.y-rect.y)/
          rect.height,
        width:
          token.rect.width/
          rect.width,
        height:
          token.rect.height/
          rect.height
      }
    }))
}

export async function renderFinalCrop(
  src:LoadedSource,
  pageIndex:number,
  targetRect:Rect,
  marginPx=40
){
  const page=await renderPage(
    src,
    pageIndex,
    2400
  )

  const marginX=
    marginPx/page.width
  const marginY=
    marginPx/page.height

  const x=Math.max(
    0,
    targetRect.x-marginX
  )
  const y=Math.max(
    0,
    targetRect.y-marginY
  )

  const rect:Rect={
    x,
    y,
    width:Math.min(
      1-x,
      targetRect.width+
      marginX*2
    ),
    height:Math.min(
      1-y,
      targetRect.height+
      marginY*2
    )
  }

  const raw=cropRaw(page,rect)

  const targetWidth=Math.max(
    1200,
    raw.width
  )

  const scale=
    targetWidth/raw.width

  const out=document.createElement('canvas')
  out.width=Math.round(
    raw.width*scale
  )
  out.height=Math.round(
    raw.height*scale
  )

  const ctx=out.getContext('2d')!
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,out.width,out.height)
  ctx.imageSmoothingEnabled=true
  ctx.imageSmoothingQuality='high'

  ctx.drawImage(
    raw,
    0,0,
    out.width,
    out.height
  )

  return out
}
