import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { NormalizedRect } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

export type LoadedSource=
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

async function renderPdf(page:PDFPageProxy,maxSide:number){
  const base=page.getViewport({scale:1})
  const scale=Math.max(.6,Math.min(3.4,maxSide/Math.max(base.width,base.height)))
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

function renderImage(
  img:HTMLImageElement,
  maxSide:number,
  allowUpscale:boolean
){
  const srcMax=Math.max(img.naturalWidth,img.naturalHeight)
  let scale=maxSide/srcMax

  if(!allowUpscale)scale=Math.min(1,scale)

  // JPG/PNG OCR accuracy 우선. 최대 4배 업스케일 허용.
  scale=Math.min(4.0,Math.max(.5,scale))

  const c=document.createElement('canvas')
  c.width=Math.max(1,Math.round(img.naturalWidth*scale))
  c.height=Math.max(1,Math.round(img.naturalHeight*scale))

  const ctx=c.getContext('2d',{willReadFrequently:true})!
  ctx.fillStyle='#fff'
  ctx.fillRect(0,0,c.width,c.height)

  ctx.imageSmoothingEnabled=true
  ctx.imageSmoothingQuality='high'
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

function otsuThreshold(data:Uint8ClampedArray){
  const hist=new Array(256).fill(0)
  let total=0

  for(let i=0;i<data.length;i+=4){
    const g=Math.round(.299*data[i]+.587*data[i+1]+.114*data[i+2])
    hist[g]++
    total++
  }

  let sum=0
  for(let i=0;i<256;i++)sum+=i*hist[i]

  let sumB=0,wB=0,maxVar=0,threshold=128

  for(let t=0;t<256;t++){
    wB+=hist[t]
    if(wB===0)continue

    const wF=total-wB
    if(wF===0)break

    sumB+=t*hist[t]
    const mB=sumB/wB
    const mF=(sum-sumB)/wF
    const between=wB*wF*(mB-mF)*(mB-mF)

    if(between>maxVar){
      maxVar=between
      threshold=t
    }
  }

  return threshold
}

export function preprocessCanvas(
  source:HTMLCanvasElement,
  mode:'normal'|'strong'|'binary'='normal'
){
  const c=document.createElement('canvas')
  c.width=source.width
  c.height=source.height

  const ctx=c.getContext('2d',{willReadFrequently:true})!
  ctx.drawImage(source,0,0)

  const img=ctx.getImageData(0,0,c.width,c.height)
  const d=img.data

  const threshold=mode==='binary'?otsuThreshold(d):128
  const contrast=mode==='strong'?1.50:1.22

  for(let i=0;i<d.length;i+=4){
    const g=.299*d[i]+.587*d[i+1]+.114*d[i+2]

    let v:number

    if(mode==='binary'){
      v=g>threshold?255:0
    }else{
      v=(g-128)*contrast+128+(mode==='strong'?6:2)
      if(mode==='strong'){
        if(v>215)v=248
        else if(v<75)v=28
      }
    }

    v=Math.max(0,Math.min(255,v))
    d[i]=d[i+1]=d[i+2]=v
  }

  ctx.putImageData(img,0,0)
  return c
}

export function cropCanvasWithMargin(
  source:HTMLCanvasElement,
  r:NormalizedRect,
  marginPx=40
){
  const rawX=r.x*source.width
  const rawY=r.y*source.height
  const rawW=r.width*source.width
  const rawH=r.height*source.height

  const sx=Math.max(0,Math.floor(rawX-marginPx))
  const sy=Math.max(0,Math.floor(rawY-marginPx))
  const x2=Math.min(source.width,Math.ceil(rawX+rawW+marginPx))
  const y2=Math.min(source.height,Math.ceil(rawY+rawH+marginPx))

  const sw=Math.max(1,x2-sx)
  const sh=Math.max(1,y2-sy)

  const c=document.createElement('canvas')
  c.width=sw
  c.height=sh

  c.getContext('2d')!.drawImage(
    source,
    sx,sy,sw,sh,
    0,0,sw,sh
  )

  return c
}

export function cropNormalized(
  source:HTMLCanvasElement,
  r:NormalizedRect
){
  const sx=Math.max(0,Math.floor(r.x*source.width))
  const sy=Math.max(0,Math.floor(r.y*source.height))
  const sw=Math.max(1,Math.min(
    source.width-sx,
    Math.ceil(r.width*source.width)
  ))
  const sh=Math.max(1,Math.min(
    source.height-sy,
    Math.ceil(r.height*source.height)
  ))

  const c=document.createElement('canvas')
  c.width=sw
  c.height=sh
  c.getContext('2d')!.drawImage(
    source,
    sx,sy,sw,sh,
    0,0,sw,sh
  )

  return c
}


export async function getPdfNativeText(src:LoadedSource,pageIndex:number){
  if(src.type!=='pdf') return ''
  try{
    const page=await src.pdf.getPage(pageIndex+1)
    const content=await page.getTextContent()
    return (content.items as any[])
      .map((it:any)=>String(it?.str ?? ''))
      .join(' ')
  }catch{
    return ''
  }
}
