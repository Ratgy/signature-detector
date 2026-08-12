import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { Rotation } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.mjs',import.meta.url).toString()

export type LoadedSource =
  | { type:'pdf'; pdf:PDFDocumentProxy; pageCount:number }
  | { type:'image'; image:HTMLImageElement; pageCount:1 }

export async function loadSource(file:File):Promise<LoadedSource>{
  const name=file.name.toLowerCase()
  if(file.type==='application/pdf'||name.endsWith('.pdf')){
    const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise
    return{type:'pdf',pdf,pageCount:pdf.numPages}
  }
  if(file.type.startsWith('image/')||name.endsWith('.jpg')||name.endsWith('.jpeg')||name.endsWith('.png')){
    const url=URL.createObjectURL(file)
    const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
      const img=new Image()
      img.onload=()=>resolve(img)
      img.onerror=reject
      img.src=url
    })
    return{type:'image',image,pageCount:1}
  }
  throw new Error('PDF/JPG/PNG만 지원합니다.')
}

async function renderPdfPage(page:PDFPageProxy,rotation:Rotation,maxSide:number){
  const base=page.getViewport({scale:1,rotation})
  const scale=Math.max(.48,Math.min(2.3,maxSide/Math.max(base.width,base.height)))
  const vp=page.getViewport({scale,rotation})
  const c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height)
  const ctx=c.getContext('2d',{willReadFrequently:true})!;ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height)
  await page.render({canvasContext:ctx,viewport:vp,canvas:c}).promise
  return c
}

function renderImage(img:HTMLImageElement,rotation:Rotation,maxSide:number){
  const swap=rotation===90||rotation===270
  const srcW=img.naturalWidth,srcH=img.naturalHeight
  const outW=swap?srcH:srcW,outH=swap?srcW:srcH
  const scale=Math.min(1,maxSide/Math.max(outW,outH))
  const c=document.createElement('canvas');c.width=Math.max(1,Math.round(outW*scale));c.height=Math.max(1,Math.round(outH*scale))
  const ctx=c.getContext('2d',{willReadFrequently:true})!
  ctx.save();ctx.translate(c.width/2,c.height/2);ctx.rotate(rotation*Math.PI/180)
  const dw=srcW*scale,dh=srcH*scale
  ctx.drawImage(img,-dw/2,-dh/2,dw,dh)
  ctx.restore()
  return c
}

export async function renderSourcePage(src:LoadedSource,pageIndex:number,rotation:Rotation,maxSide:number){
  if(src.type==='pdf'){
    const page=await src.pdf.getPage(pageIndex+1)
    return renderPdfPage(page,rotation,maxSide)
  }
  return renderImage(src.image,rotation,maxSide)
}

export function preprocessCanvas(source:HTMLCanvasElement){
  const c=document.createElement('canvas');c.width=source.width;c.height=source.height
  const ctx=c.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(source,0,0)
  const img=ctx.getImageData(0,0,c.width,c.height),d=img.data
  for(let i=0;i<d.length;i+=4){
    const g=.299*d[i]+.587*d[i+1]+.114*d[i+2]
    const v=Math.max(0,Math.min(255,(g-128)*1.12+128))
    d[i]=d[i+1]=d[i+2]=v
  }
  ctx.putImageData(img,0,0);return c
}

export function cropCanvas(source:HTMLCanvasElement,r:{x:number;y:number;width:number;height:number}){
  const sx=Math.max(0,Math.floor(r.x*source.width)),sy=Math.max(0,Math.floor(r.y*source.height))
  const sw=Math.max(1,Math.min(source.width-sx,Math.ceil(r.width*source.width)))
  const sh=Math.max(1,Math.min(source.height-sy,Math.ceil(r.height*source.height)))
  const c=document.createElement('canvas');c.width=sw;c.height=sh
  c.getContext('2d')!.drawImage(source,sx,sy,sw,sh,0,0,sw,sh)
  return c
}
