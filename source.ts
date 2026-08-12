import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.mjs',import.meta.url).toString()

export type LoadedSource =
  | {type:'pdf';pdf:PDFDocumentProxy;pageCount:number}
  | {type:'image';image:HTMLImageElement;pageCount:1}

export async function loadSource(file:File):Promise<LoadedSource>{
  const n=file.name.toLowerCase()
  if(file.type==='application/pdf'||n.endsWith('.pdf')){
    const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise
    return{type:'pdf',pdf,pageCount:pdf.numPages}
  }
  if(file.type.startsWith('image/')||n.endsWith('.jpg')||n.endsWith('.jpeg')||n.endsWith('.png')){
    const url=URL.createObjectURL(file)
    const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
      const img=new Image()
      img.onload=()=>resolve(img);img.onerror=reject;img.src=url
    })
    return{type:'image',image,pageCount:1}
  }
  throw new Error('PDF/JPG/PNG만 지원합니다.')
}

async function renderPdf(page:PDFPageProxy,maxSide:number){
  const base=page.getViewport({scale:1})
  const scale=Math.max(.52,Math.min(2.4,maxSide/Math.max(base.width,base.height)))
  const vp=page.getViewport({scale})
  const c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height)
  const ctx=c.getContext('2d',{willReadFrequently:true})!;ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height)
  await page.render({canvasContext:ctx,viewport:vp,canvas:c}).promise
  return c
}
function renderImage(img:HTMLImageElement,maxSide:number){
  const scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight))
  const c=document.createElement('canvas')
  c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale))
  c.getContext('2d',{willReadFrequently:true})!.drawImage(img,0,0,c.width,c.height)
  return c
}
export async function renderSourcePage(src:LoadedSource,pageIndex:number,maxSide:number){
  if(src.type==='pdf')return renderPdf(await src.pdf.getPage(pageIndex+1),maxSide)
  return renderImage(src.image,maxSide)
}
export function preprocessCanvas(source:HTMLCanvasElement){
  const c=document.createElement('canvas');c.width=source.width;c.height=source.height
  const ctx=c.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(source,0,0)
  const img=ctx.getImageData(0,0,c.width,c.height),d=img.data
  for(let i=0;i<d.length;i+=4){
    const g=.299*d[i]+.587*d[i+1]+.114*d[i+2]
    const v=Math.max(0,Math.min(255,(g-128)*1.16+128))
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
