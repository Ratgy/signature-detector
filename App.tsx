import { useEffect, useMemo, useRef, useState } from 'react'
import { detectExactSignatureTarget, roiTokenToPage, scoreFastText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import { cropCanvas, loadPdf, normalizedRectForBottomBand, preprocessCanvas, renderPageFast, renderPagePrecise, renderPagePreview, ROTATIONS } from './pdf'
import type { NormalizedRect, OCRToken, Rotation, SignatureTarget } from './types'

const pct=(n:number)=>`${Math.round(n*100)}%`

export default function App(){
  const [file,setFile]=useState<File|null>(null)
  const [status,setStatus]=useState('PDF를 올려주세요')
  const [progress,setProgress]=useState(0)
  const [processing,setProcessing]=useState(false)
  const [preview,setPreview]=useState<string|null>(null)
  const [cropUrl,setCropUrl]=useState<string|null>(null)
  const [target,setTarget]=useState<SignatureTarget|null>(null)
  const [tokens,setTokens]=useState<OCRToken[]>([])
  const [timing,setTiming]=useState<{orient:number;precise:number;total:number}|null>(null)
  const [signature,setSignature]=useState<string|null>(null)
  const inputRef=useRef<HTMLInputElement>(null)
  useEffect(()=>()=>{terminateOCR()},[])

  async function analyzePdf(selected:File){
    setFile(selected);setProcessing(true);setProgress(0);setTarget(null);setSignature(null);setCropUrl(null);setPreview(null);setTiming(null)
    const started=performance.now()
    try{
      const pdf=await loadPdf(selected)
      // Prioritize the last page first, because signing blocks are commonly there; fallback to earlier pages only if needed.
      const pageOrder=[...Array(pdf.numPages)].map((_,i)=>pdf.numPages-1-i)
      let best:{pageIndex:number;rotation:Rotation;score:number}|null=null
      const orientStart=performance.now()
      setStatus('마지막 페이지부터 서명 영역 방향을 찾는 중…')

      for(let oi=0;oi<pageOrder.length;oi++){
        const pageIndex=pageOrder[oi]
        const page=await pdf.getPage(pageIndex+1)
        // First try 0°, then other rotations only if 0° has weak anchors.
        for(let ri=0;ri<ROTATIONS.length;ri++){
          const rotation=ROTATIONS[ri]
          setStatus(`${pageIndex+1}페이지 · ${rotation}° 빠른 확인`)
          const small=preprocessCanvas(await renderPageFast(page,rotation))
          const bottom=normalizedRectForBottomBand(.46)
          const roi=cropCanvas(small,bottom)
          const result=await recognizeTextFast(roi)
          const scored=scoreFastText(result.text)
          const combined=scored.score+result.confidence*.08
          if(!best||combined>best.score)best={pageIndex,rotation,score:combined}
          if(scored.score>=78)break
        }
        setProgress(Math.min(.48,(oi+1)/pageOrder.length*.48))
        if(best && best.score>=92)break
      }
      if(!best)throw new Error('서명 페이지를 찾지 못했습니다.')
      const orientMs=performance.now()-orientStart

      // One precise OCR only: selected page + selected rotation + bottom band only.
      const preciseStart=performance.now()
      setStatus(`${best.pageIndex+1}페이지 서명영역만 정밀 확인 중…`)
      const page=await pdf.getPage(best.pageIndex+1)
      const precise=preprocessCanvas(await renderPagePrecise(page,best.rotation))
      const roiRect=normalizedRectForBottomBand(.48)
      const roiCanvas=cropCanvas(precise,roiRect)
      const roiTokens=await recognizeWordsPrecise(roiCanvas,best.pageIndex,(v,s)=>{
        setProgress(.48+v*.48);setStatus(`서명란 정밀 탐지 · ${s}`)
      })
      const pageTokens=roiTokens.map(t=>roiTokenToPage(t,roiRect))
      const exact=detectExactSignatureTarget(pageTokens,best.rotation)
      setTokens(pageTokens)

      const pagePreview=await renderPagePreview(page,0)
      setPreview(pagePreview)
      if(exact){
        setTarget(exact)
        // For the signing UI, crop from the currently rotated precise canvas.
        // exact.rect is unrotated page coords, so derive rotated-space target again from page tokens via detector:
        const rotatedExact=detectExactSignatureTarget(pageTokens,0)?.rect ?? exact.rect
        const signingCrop=cropCanvas(precise, rotatedExact)
        setCropUrl(signingCrop.toDataURL('image/jpeg',.92))
        setStatus('서명해야 할 최종 영역을 찾았어요')
      }else{
        setStatus('최종 연·월·일 / 서명 영역을 정확히 찾지 못했어요')
      }

      const preciseMs=performance.now()-preciseStart
      setTiming({orient:orientMs,precise:preciseMs,total:performance.now()-started})
      setProgress(1)
    }catch(e){
      console.error(e);setStatus(`오류: ${e instanceof Error?e.message:String(e)}`)
    }finally{setProcessing(false)}
  }

  return <div className="app">
    <header><div><p className="eyebrow">ROI-FIRST OCR · SIGNATURE FLOW</p><h1>서명영역 탐지 v3</h1><p className="sub">마지막 페이지 하단부터 탐색하고, 최종 연·월·일/서명 행만 확대합니다.</p></div></header>

    <section className={`dropzone ${processing?'disabled':''}`} onClick={()=>!processing&&inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={e=>{const f=e.target.files?.[0];if(f)analyzePdf(f)}}/>
      <div className="uploadIcon">PDF</div><strong>{file?file.name:'성능점검기록부 PDF 업로드'}</strong><span>{processing?'탐지 중…':'휴대폰에서 PDF를 선택하세요.'}</span>
    </section>

    {(processing||file)&&<section className="statusCard"><div className="statusTop"><strong>{status}</strong><span>{Math.round(progress*100)}%</span></div><div className="progress"><i style={{width:`${progress*100}%`}}/></div>
      <small>마지막 페이지 하단 ROI → 방향 선택 → ROI 1회 정밀 OCR</small>
      {timing&&<div className="timing">방향 {(timing.orient/1000).toFixed(1)}s · 정밀 {(timing.precise/1000).toFixed(1)}s · 총 {(timing.total/1000).toFixed(1)}s</div>}</section>}

    {!processing&&target&&cropUrl&&<>
      <section className="card" style={{marginTop:16}}>
        <div className="cardHead"><div><p className="label">EXACT SIGNING AREA</p><h2>이 영역에 서명해 주세요</h2></div><span className="confidence high">{pct(target.confidence)}</span></div>
        <img src={cropUrl} alt="서명 영역" style={{width:'100%',border:'1px solid #ddd',borderRadius:12}}/>
        <div className="chips"><span>연·월·일</span><span>매수인/서명</span><span>최종행만</span></div>
      </section>

      <SignaturePad onChange={setSignature}/>

      {preview&&<section className="card" style={{marginTop:16}}>
        <div className="cardHead"><div><p className="label">FULL PDF PAGE</p><h2>전체 문서 위치</h2></div><span className="pageBadge">{target.pageIndex+1}페이지</span></div>
        <div className="pagePreview"><img src={preview} alt="PDF 페이지"/><div className="detectedRect" style={{left:`${target.rect.x*100}%`,top:`${target.rect.y*100}%`,width:`${target.rect.width*100}%`,height:`${target.rect.height*100}%`}}><span>서명 위치</span></div></div>
      </section>}

      <section className="judgeCard">
        <div><strong>{signature?'서명이 입력되었습니다.':'아래 패드에 서명해 주세요.'}</strong><span>다음 단계에서는 이 서명을 원본 PDF 좌표에 합성하면 됩니다.</span></div>
        <button className="primaryBtn" disabled={!signature}>서명 적용</button>
      </section>
    </>}
  </div>
}

function SignaturePad({onChange}:{onChange:(data:string|null)=>void}){
  const ref=useRef<HTMLCanvasElement>(null)
  const drawing=useRef(false)
  useEffect(()=>{
    const c=ref.current!;const rect=c.getBoundingClientRect();const dpr=Math.min(2,window.devicePixelRatio||1)
    c.width=Math.floor(rect.width*dpr);c.height=Math.floor(180*dpr)
    const ctx=c.getContext('2d')!;ctx.scale(dpr,dpr);ctx.lineWidth=2.6;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#111'
  },[])
  const pos=(e:React.PointerEvent<HTMLCanvasElement>)=>{const r=e.currentTarget.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
  return <section className="card" style={{marginTop:16}}>
    <div className="cardHead"><div><p className="label">SIGNATURE PAD</p><h2>손가락으로 서명</h2></div><button className="ghost" onClick={()=>{const c=ref.current!;c.getContext('2d')!.clearRect(0,0,c.width,c.height);onChange(null)}}>다시 쓰기</button></div>
    <canvas ref={ref} className="signaturePad"
      onPointerDown={e=>{drawing.current=true;e.currentTarget.setPointerCapture(e.pointerId);const p=pos(e);const ctx=e.currentTarget.getContext('2d')!;ctx.beginPath();ctx.moveTo(p.x,p.y)}}
      onPointerMove={e=>{if(!drawing.current)return;const p=pos(e);const ctx=e.currentTarget.getContext('2d')!;ctx.lineTo(p.x,p.y);ctx.stroke()}}
      onPointerUp={e=>{drawing.current=false;onChange(e.currentTarget.toDataURL('image/png'))}}
    />
  </section>
}
