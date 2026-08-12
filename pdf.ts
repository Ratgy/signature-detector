import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { NormalizedRect, Rotation } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

export async function loadPdf(file:File):Promise<PDFDocumentProxy>{
  const data=new Uint8Array(await file.arrayBuffer())
  return pdfjsLib.getDocument({data}).promise
}

export const ROTATIONS:Rotation[]=[0,90,270,180]

async function render(page:PDFPageProxy,rotation:Rotation,maxSide:number){
  const base=page.getViewport({scale:1,rotation})
  const scale=Math.max(.55,Math.min(2.15,maxSide/Math.max(base.width,base.height)))
  const viewport=page.getViewport({scale,rotation})
  const canvas=document.createElement('canvas')
  canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height)
  const ctx=canvas.getContext('2d',{willReadFrequently:true})!
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height)
  await page.render({canvasContext:ctx,viewport,canvas}).promise
  return canvas
}

export const renderFast=(page:PDFPageProxy,rotation:Rotation)=>render(page,rotation,720)
export const renderPrecise=(page:PDFPageProxy,rotation:Rotation)=>render(page,rotation,1500)

export function preprocessCanvas(source:HTMLCanvasElement){
  const c=document.createElement('canvas');c.width=source.width;c.height=source.height
  const ctx=c.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(source,0,0)
  const img=ctx.getImageData(0,0,c.width,c.height),d=img.data
  for(let i=0;i<d.length;i+=4){
    const g=.299*d[i]+.587*d[i+1]+.114*d[i+2]
    const a=Math.max(0,Math.min(255,(g-128)*1.14+128))
    d[i]=d[i+1]=d[i+2]=a
  }
  ctx.putImageData(img,0,0)
  return c
}

export function cropCanvas(source:HTMLCanvasElement,r:NormalizedRect){
  const sx=Math.max(0,Math.floor(r.x*source.width)),sy=Math.max(0,Math.floor(r.y*source.height))
  const sw=Math.max(1,Math.min(source.width-sx,Math.ceil(r.width*source.width)))
  const sh=Math.max(1,Math.min(source.height-sy,Math.ceil(r.height*source.height)))
  const c=document.createElement('canvas');c.width=sw;c.height=sh
  c.getContext('2d')!.drawImage(source,sx,sy,sw,sh,0,0,sw,sh)
  return c
}

export async function renderPagePreview(page:PDFPageProxy){
  const base=page.getViewport({scale:1})
  const scale=Math.min(1.15,820/base.width)
  const viewport=page.getViewport({scale})
  const c=document.createElement('canvas');c.width=Math.ceil(viewport.width);c.height=Math.ceil(viewport.height)
  await page.render({canvasContext:c.getContext('2d')!,viewport,canvas:c}).promise
  return c.toDataURL('image/jpeg',.85)
}
