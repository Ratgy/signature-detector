import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { OCRToken, Rect, RegionSpec } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

export type LoadedSource =
  | {type:'pdf';pdf:PDFDocumentProxy;pageCount:number}
  | {type:'image';image:HTMLImageElement;pageCount:1}

export async function loadSource(file:File):Promise<LoadedSource>{
  const name=file.name.toLowerCase()

  if(file.type==='application/pdf'||name.endsWith('.pdf')){
    const pdf=await pdfjsLib.getDocument({
      data:new Uint8Array(await file.arrayBuffer())
    }).promise

    return{type:'pdf',pdf,pageCount:pdf.numPages}
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

    return{type:'image',image,pageCount:1}
  }

  throw new Error('PDF/JPG/PNG만 지원합니다.')
}

async function renderPdfPage(page:PDFPageProxy,targetLongSide:number){
  const base=page.getViewport({scale:1})
  const scale=Math.max(
    .55,
    Math.min(3,targetLongSide/Math.max(base.width,base.height))
  )
  const viewport=page.getViewport({scale})

  const canvas=document.createElement('canvas')
  canvas.width=Math.ceil(viewport.width)
  canvas.height=Math.ceil(viewport.height)

  const ctx=canvas.getContext('2d',{willReadFrequently:true})!
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,canvas.width,canvas.height)

  await page.render({
    canvasContext:ctx,
    viewport,
    canvas
  }).promise

  return canvas
}

function renderImagePage(image:HTMLImageElement,targetLongSide:number){
  const sourceLong=Math.max(image.naturalWidth,image.naturalHeight)
  const scale=Math.max(.65,Math.min(2.6,targetLongSide/sourceLong))

  const canvas=document.createElement('canvas')
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale))
  canvas.height=Math.max(1,Math.round(image.naturalHeight*scale))

  const ctx=canvas.getContext('2d',{willReadFrequently:true})!
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,canvas.width,canvas.height)
  ctx.imageSmoothingEnabled=true
  ctx.imageSmoothingQuality='high'
  ctx.drawImage(image,0,0,canvas.width,canvas.height)

  return canvas
}

export async function renderPage(
  src:LoadedSource,
  pageIndex:number,
  targetLongSide=1700
){
  if(src.type==='image'){
    return renderImagePage(src.image,targetLongSide)
  }

  const page=await src.pdf.getPage(pageIndex+1)
  return renderPdfPage(page,targetLongSide)
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

  const image=ctx.getImageData(0,0,out.width,out.height)
  const data=image.data

  if(mode==='gray'){
    for(let i=0;i<data.length;i+=4){
      const gray=.299*data[i]+.587*data[i+1]+.114*data[i+2]
      let value=(gray-128)*1.28+132
      if(value>235)value=250
      if(value<55)value=28
      value=Math.max(0,Math.min(255,value))
      data[i]=data[i+1]=data[i+2]=value
    }
    ctx.putImageData(image,0,0)
    return out
  }

  // 촬영 사진의 그림자/조명 차이를 위한 가벼운 adaptive threshold.
  const width=out.width
  const height=out.height
  const gray=new Uint8Array(width*height)

  for(let y=0;y<height;y++){
    for(let x=0;x<width;x++){
      const i=(y*width+x)*4
      gray[y*width+x]=Math.round(
        .299*data[i]+.587*data[i+1]+.114*data[i+2]
      )
    }
  }

  const integral=new Uint32Array((width+1)*(height+1))
  for(let y=1;y<=height;y++){
    let row=0
    for(let x=1;x<=width;x++){
      row+=gray[(y-1)*width+(x-1)]
      integral[y*(width+1)+x]=
        integral[(y-1)*(width+1)+x]+row
    }
  }

  const radius=Math.max(10,Math.round(Math.min(width,height)*.014))
  const stride=width+1

  for(let y=0;y<height;y++){
    const y0=Math.max(0,y-radius)
    const y1=Math.min(height-1,y+radius)
    for(let x=0;x<width;x++){
      const x0=Math.max(0,x-radius)
      const x1=Math.min(width-1,x+radius)
      const A=integral[y0*stride+x0]
      const B=integral[y0*stride+(x1+1)]
      const C=integral[(y1+1)*stride+x0]
      const D=integral[(y1+1)*stride+(x1+1)]
      const area=(x1-x0+1)*(y1-y0+1)
      const mean=(D-B-C+A)/area
      const value=gray[y*width+x]<mean-10?0:255
      const i=(y*width+x)*4
      data[i]=data[i+1]=data[i+2]=value
    }
  }

  ctx.putImageData(image,0,0)
  return out
}

function cropRaw(source:HTMLCanvasElement,rect:Rect){
  const sx=Math.max(0,Math.floor(rect.x*source.width))
  const sy=Math.max(0,Math.floor(rect.y*source.height))
  const sw=Math.max(1,Math.min(
    source.width-sx,
    Math.ceil(rect.width*source.width)
  ))
  const sh=Math.max(1,Math.min(
    source.height-sy,
    Math.ceil(rect.height*source.height)
  ))

  const canvas=document.createElement('canvas')
  canvas.width=sw
  canvas.height=sh
  canvas.getContext('2d')!.drawImage(
    source,sx,sy,sw,sh,0,0,sw,sh
  )
  return canvas
}

export function buildFallbackRegions(
  page:HTMLCanvasElement,
  pageIndex:number
):RegionSpec[]{
  const aspect=page.width/page.height

  if(aspect>1.18){
    // 가로 2페이지 스캔/촬영: 좌우 논리 페이지를 각각 크게 OCR.
    return[
      {id:'right',pageIndex,rect:{x:.47,y:0,width:.53,height:1}},
      {id:'left',pageIndex,rect:{x:0,y:0,width:.53,height:1}}
    ]
  }

  // 세로 문서는 위/아래가 22% 겹치도록 두 영역으로 확대.
  // 특정 위치를 가정하지 않으면서 글자 크기를 약 1.6배 확보한다.
  return[
    {id:'upper',pageIndex,rect:{x:0,y:0,width:1,height:.61}},
    {id:'lower',pageIndex,rect:{x:0,y:.39,width:1,height:.61}}
  ]
}

export interface ContactMeta {
  region:RegionSpec
  y:number
  height:number
}

export function buildFallbackSheet(
  page:HTMLCanvasElement,
  regions:RegionSpec[],
  mode:'gray'|'adaptive'
){
  const targetWidth=1500
  const gap=34
  const items:{region:RegionSpec;canvas:HTMLCanvasElement}[]=[]
  let totalHeight=gap

  for(const region of regions){
    const raw=cropRaw(page,region.rect)
    const scale=Math.min(2.4,targetWidth/raw.width)
    const resized=document.createElement('canvas')
    resized.width=Math.max(1,Math.round(raw.width*scale))
    resized.height=Math.max(1,Math.round(raw.height*scale))

    const ctx=resized.getContext('2d',{willReadFrequently:true})!
    ctx.fillStyle='#fff'
    ctx.fillRect(0,0,resized.width,resized.height)
    ctx.imageSmoothingEnabled=true
    ctx.imageSmoothingQuality='high'
    ctx.drawImage(raw,0,0,resized.width,resized.height)

    items.push({region,canvas:preprocess(resized,mode)})
    totalHeight+=resized.height+gap
  }

  const sheet=document.createElement('canvas')
  sheet.width=Math.max(...items.map(i=>i.canvas.width),1)
  sheet.height=Math.max(1,totalHeight)
  const ctx=sheet.getContext('2d',{willReadFrequently:true})!
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,sheet.width,sheet.height)

  const metas:ContactMeta[]=[]
  let y=gap
  for(const item of items){
    ctx.drawImage(item.canvas,0,y)
    metas.push({region:item.region,y,height:item.canvas.height})
    y+=item.canvas.height+gap
  }

  return{canvas:sheet,metas}
}

export function tokensForMeta(
  tokens:OCRToken[],
  sheet:HTMLCanvasElement,
  meta:ContactMeta
){
  return tokens
    .filter(token=>{
      const y=(token.rect.y+token.rect.height/2)*sheet.height
      return y>=meta.y&&y<=meta.y+meta.height
    })
    .map(token=>({
      ...token,
      pageIndex:meta.region.pageIndex,
      rect:{
        x:token.rect.x*sheet.width/(sheet.width),
        y:((token.rect.y*sheet.height)-meta.y)/meta.height,
        width:token.rect.width*sheet.width/(sheet.width),
        height:token.rect.height*sheet.height/meta.height
      }
    }))
    .filter(token=>
      token.rect.y>=-.05&&token.rect.y<=1.05
    )
}

export function mapLocalRectToPage(local:Rect,region:Rect):Rect{
  return{
    x:region.x+local.x*region.width,
    y:region.y+local.y*region.height,
    width:local.width*region.width,
    height:local.height*region.height
  }
}

export function expandRectByPixels(
  page:HTMLCanvasElement,
  rect:Rect,
  marginPx=40
):Rect{
  const mx=marginPx/page.width
  const my=marginPx/page.height
  const x=Math.max(0,rect.x-mx)
  const y=Math.max(0,rect.y-my)
  return{
    x,
    y,
    width:Math.min(1-x,rect.width+mx*2),
    height:Math.min(1-y,rect.height+my*2)
  }
}

export function cropPage(
  page:HTMLCanvasElement,
  rect:Rect,
  targetWidth=1600
){
  const raw=cropRaw(page,rect)
  const scale=Math.max(1,targetWidth/raw.width)
  const out=document.createElement('canvas')
  out.width=Math.round(raw.width*scale)
  out.height=Math.round(raw.height*scale)
  const ctx=out.getContext('2d')!
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,out.width,out.height)
  ctx.imageSmoothingEnabled=true
  ctx.imageSmoothingQuality='high'
  ctx.drawImage(raw,0,0,out.width,out.height)
  return out
}
