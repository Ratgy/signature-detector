import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

export type LoadedSource =
  | {type:'pdf';pdf:PDFDocumentProxy;pageCount:number}
  | {type:'image';image:HTMLImageElement;pageCount:1}

export async function loadSource(file:File):Promise<LoadedSource>{
  const n=file.name.toLowerCase()

  if(file.type==='application/pdf'||n.endsWith('.pdf')){
    const pdf=await pdfjsLib.getDocument({
      data:new Uint8Array(await file.arrayBuffer())
    }).promise
    return{type:'pdf',pdf,pageCount:pdf.numPages}
  }

  if(
    file.type.startsWith('image/')||
    n.endsWith('.jpg')||n.endsWith('.jpeg')||n.endsWith('.png')
  ){
    const url=URL.createObjectURL(file)
    const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
      const img=new Image()
      img.onload=()=>{URL.revokeObjectURL(url);resolve(img)}
      img.onerror=(e)=>{URL.revokeObjectURL(url);reject(e)}
      img.src=url
    })
    return{type:'image',image,pageCount:1}
  }

  throw new Error('PDF/JPG/PNG만 지원합니다.')
}

async function renderPdf(page:PDFPageProxy,maxSide:number){
  const base=page.getViewport({scale:1})
  const scale=Math.max(.55,Math.min(3.0,maxSide/Math.max(base.width,base.height)))
  const vp=page.getViewport({scale})
  const c=document.createElement('canvas')
  c.width=Math.ceil(vp.width)
  c.height=Math.ceil(vp.height)

  const ctx=c.getContext('2d',{willReadFrequently:true})!
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,c.width,c.height)

  await page.render({canvasContext:ctx,viewport:vp,canvas:c}).promise
  return c
}

function renderImage(img:HTMLImageElement,maxSide:number,allowUpscale:boolean){
  const sourceMax=Math.max(img.naturalWidth,img.naturalHeight)
  let scale=maxSide/sourceMax

  if(!allowUpscale)scale=Math.min(1,scale)

  // OCR-only image upscale. Keep memory under control on mobile.
  scale=Math.min(3.0,Math.max(.5,scale))

  const c=document.createElement('canvas')
  c.width=Math.max(1,Math.round(img.naturalWidth*scale))
  c.height=Math.max(1,Math.round(img.naturalHeight*scale))

  const ctx=c.getContext('2d',{willReadFrequently:true})!
  ctx.imageSmoothingEnabled=true
  ctx.imageSmoothingQuality='high'
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,c.width,c.height)
  ctx.drawImage(img,0,0,c.width,c.height)
  return c
}

export async function renderSourcePage(
  src:LoadedSource,
  pageIndex:number,
  maxSide:number,
  precise=false
){
  if(src.type==='pdf'){
    return renderPdf(await src.pdf.getPage(pageIndex+1),maxSide)
  }
  return renderImage(src.image,maxSide,precise)
}

export function preprocessCanvas(source:HTMLCanvasElement, strong=false){
  const c=document.createElement('canvas')
  c.width=source.width
  c.height=source.height

  const ctx=c.getContext('2d',{willReadFrequently:true})!
  ctx.drawImage(source,0,0)

  const img=ctx.getImageData(0,0,c.width,c.height)
  const d=img.data
  const contrast=strong?1.42:1.20
  const brightness=strong?5:2

  for(let i=0;i<d.length;i+=4){
    const g=.299*d[i]+.587*d[i+1]+.114*d[i+2]
    let v=(g-128)*contrast+128+brightness
    if(strong){
      // Light thresholding without destroying thin Korean strokes.
      if(v>210)v=245
      else if(v<85)v=35
    }
    v=Math.max(0,Math.min(255,v))
    d[i]=d[i+1]=d[i+2]=v
  }

  ctx.putImageData(img,0,0)

  // simple unsharp mask-ish redraw
  if(strong){
    ctx.globalAlpha=.18
    ctx.filter='contrast(1.25)'
    ctx.drawImage(c,0,0)
    ctx.globalAlpha=1
    ctx.filter='none'
  }

  return c
}

export function cropCanvas(
  source:HTMLCanvasElement,
  r:{x:number;y:number;width:number;height:number}
){
  const sx=Math.max(0,Math.floor(r.x*source.width))
  const sy=Math.max(0,Math.floor(r.y*source.height))
  const sw=Math.max(1,Math.min(source.width-sx,Math.ceil(r.width*source.width)))
  const sh=Math.max(1,Math.min(source.height-sy,Math.ceil(r.height*source.height)))

  const c=document.createElement('canvas')
  c.width=sw
  c.height=sh
  c.getContext('2d')!.drawImage(source,sx,sy,sw,sh,0,0,sw,sh)
  return c
}
