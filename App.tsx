import { useEffect, useMemo, useRef, useState } from 'react'
import { detectExactTarget, roiTokenToPage, scoreFastText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import { cropCanvas, loadPdf, preprocessCanvas, renderPagePrecise, renderPagePreview, renderPageTiny, ROTATIONS, SEARCH_BANDS } from './pdf'
import type { NormalizedRect, OCRToken, Rotation, SignatureTarget } from './types'

type DrawMode='date'|'signature'|'pen'

const pct=(n:number)=>`${Math.round(n*100)}%`

export default function App(){
  const [file,setFile]=useState<File|null>(null)
  const [displayProgress,setDisplayProgress]=useState(0)
  const [realProgress,setRealProgress]=useState(0)
  const [status,setStatus]=useState('PDF를 올려주세요')
  const [processing,setProcessing]=useState(false)
  const [target,setTarget]=useState<SignatureTarget|null>(null)
  const [fullPreview,setFullPreview]=useState<string|null>(null)
  const [focusImage,setFocusImage]=useState<string|null>(null)
  const [timing,setTiming]=useState<{scan:number;precise:number;total:number}|null>(null)
  const [dateText,setDateText]=useState('')
  const [signatureData,setSignatureData]=useState<string|null>(null)
  const [mode,setMode]=useState<DrawMode>('date')
  const inputRef=useRef<HTMLInputElement>(null)

  useEffect(()=>()=>{terminateOCR()},[])

  // Smooth UI progress, +1% increments, never jumping backwards.
  useEffect(()=>{
    if(displayProgress>=realProgress)return
    const id=window.setInterval(()=>{
      setDisplayProgress(p=>{
        if(p>=realProgress)return p
        return Math.min(realProgress,p+1)
      })
    },28)
    return()=>clearInterval(id)
  },[displayProgress,realProgress])

  async function analyzePdf(selected:File){
    setFile(selected);setProcessing(true);setTarget(null);setFullPreview(null);setFocusImage(null)
    setRealProgress(1);setDisplayProgress(0);setTiming(null);setSignatureData(null)
    const started=performance.now()

    try{
      const pdf=await loadPdf(selected)
      const scanStart=performance.now()
      let best:{pageIndex:number;rotation:Rotation;band:NormalizedRect;score:number}|null=null

      // Speed strategy:
      // 1) 0° first for all pages
      // 2) only likely bands
      // 3) only rotate the current best page when confidence is weak
      for(let p=0;p<pdf.numPages;p++){
        const page=await pdf.getPage(p+1)
        const rotation:Rotation=0
        const tiny=preprocessCanvas(await renderPageTiny(page,rotation))

        for(let b=0;b<SEARCH_BANDS.length;b++){
          const band=SEARCH_BANDS[b]
          const roi=cropCanvas(tiny,band)
          const r=await recognizeTextFast(roi)
          const s=scoreFastText(r.text).score+r.confidence*.06
          if(!best||s>best.score)best={pageIndex:p,rotation,band,score:s}
          // if strong anchor found, no need to inspect other bands on this page
          if(s>=88)break
        }
        setRealProgress(Math.min(48,8+Math.round(((p+1)/pdf.numPages)*40)))
      }

      if(!best)throw new Error('후보 페이지를 찾지 못했습니다.')

      // Rotate only the chosen page if confidence is not strong enough.
      if(best.score<92){
        const page=await pdf.getPage(best.pageIndex+1)
        for(const rotation of ROTATIONS.slice(1)){
          const tiny=preprocessCanvas(await renderPageTiny(page,rotation))
          for(const band of SEARCH_BANDS){
            const roi=cropCanvas(tiny,band)
            const r=await recognizeTextFast(roi)
            const s=scoreFastText(r.text).score+r.confidence*.06
            if(s>best.score)best={...best,rotation,band,score:s}
            if(s>=92)break
          }
          if(best.score>=92)break
        }
      }

      const scanMs=performance.now()-scanStart
      setRealProgress(56)

      // precise OCR only for 1 page + 1 rotation + 1 selected band
      const preciseStart=performance.now()
      const page=await pdf.getPage(best.pageIndex+1)
      const precise=preprocessCanvas(await renderPagePrecise(page,best.rotation))
      const roi=cropCanvas(precise,best.band)
      const roiTokens=await recognizeWordsPrecise(roi,best.pageIndex,(v,s)=>{
        setStatus(`서명/날짜 영역 정밀 분석 · ${s}`)
        setRealProgress(56+Math.round(v*34))
      })
      const pageTokens=roiTokens.map(t=>roiTokenToPage(t,best.band))
      const exact=detectExactTarget(pageTokens,best.rotation,precise)
      setTarget(exact)

      const full=await renderPagePreview(page,0)
      setFullPreview(full)

      if(exact){
        // precise canvas is in selected rotation. Convert back is unnecessary for UX focus image:
        // crop around all detected anchors using the same band-space target approximation.
        const focusRect=best.band
        const focus=cropCanvas(precise,focusRect)
        setFocusImage(focus.toDataURL('image/jpeg',.94))
        setStatus('날짜/서명 영역을 찾았어요')
      }else{
        setStatus('날짜/서명 영역을 정확히 찾지 못했어요')
      }

      setRealProgress(96)
      await new Promise(r=>setTimeout(r,120))
      setRealProgress(100)
      setTiming({scan:scanMs,precise:performance.now()-preciseStart,total:performance.now()-started})
    }catch(e){
      console.error(e)
      setStatus(`오류: ${e instanceof Error?e.message:String(e)}`)
      setRealProgress(100)
    }finally{
      setProcessing(false)
    }
  }

  return <div className="app">
    <header>
      <div>
        <p className="eyebrow">FAST ROI OCR · INLINE ANNOTATION</p>
        <h1>서명영역 탐지 v4</h1>
        <p className="sub">문서 위치에 상관없이 날짜/서명 앵커를 찾고, 확대된 원본 위에 직접 기입합니다.</p>
      </div>
    </header>

    <section className={`dropzone ${processing?'disabled':''}`} onClick={()=>!processing&&inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={e=>{const f=e.target.files?.[0];if(f)analyzePdf(f)}}/>
      <div className="uploadIcon">PDF</div>
      <strong>{file?file.name:'성능점검기록부 PDF 업로드'}</strong>
      <span>{processing?'탐지 중…':'휴대폰에서 PDF를 선택하세요.'}</span>
    </section>

    {(processing||file)&&<section className="statusCard">
      <div className="statusTop"><strong>{status}</strong><span>{displayProgress}%</span></div>
      <div className="progress"><i style={{width:`${displayProgress}%`}}/></div>
      <small>빠른 밴드 탐색 → 필요 시 선택 페이지만 회전 → 정밀 OCR 1회</small>
      {timing&&<div className="timing">탐색 {(timing.scan/1000).toFixed(1)}s · 정밀 {(timing.precise/1000).toFixed(1)}s · 총 {(timing.total/1000).toFixed(1)}s</div>}
    </section>}

    {!processing&&target&&focusImage&&<>
      <section className="card" style={{marginTop:16}}>
        <div className="cardHead">
          <div><p className="label">ANNOTATE ON DOCUMENT</p><h2>확대한 원본 위에 직접 입력</h2></div>
          <span className="confidence high">{pct(target.confidence)}</span>
        </div>

        <div className="modeTabs">
          <button className={mode==='date'?'active':''} onClick={()=>setMode('date')}>연·월·일</button>
          <button className={mode==='signature'?'active':''} onClick={()=>setMode('signature')}>서명</button>
          <button className={mode==='pen'?'active':''} onClick={()=>setMode('pen')}>자유필기</button>
        </div>

        <AnnotationCanvas
          imageUrl={focusImage}
          mode={mode}
          dateText={dateText}
          onDateChange={setDateText}
          onSignatureChange={setSignatureData}
        />
      </section>

      {fullPreview&&<section className="card" style={{marginTop:16}}>
        <div className="cardHead">
          <div><p className="label">FULL PAGE</p><h2>전체 PDF 내 위치</h2></div>
          <span className="pageBadge">{target.pageIndex+1}페이지</span>
        </div>
        <div className="pagePreview">
          <img src={fullPreview} alt="PDF 페이지"/>
          <div className="detectedRect" style={{
            left:`${target.rect.x*100}%`,
            top:`${target.rect.y*100}%`,
            width:`${target.rect.width*100}%`,
            height:`${target.rect.height*100}%`,
          }}><span>입력 영역</span></div>
        </div>
      </section>}

      <section className="judgeCard">
        <div>
          <strong>{signatureData?'서명이 입력되었습니다.':'연·월·일과 서명을 입력해 주세요.'}</strong>
          <span>원본 확대 이미지 위에서 직접 작성하는 방식입니다.</span>
        </div>
        <button className="primaryBtn" disabled={!signatureData}>입력 완료</button>
      </section>
    </>}
  </div>
}

function AnnotationCanvas({
  imageUrl,mode,dateText,onDateChange,onSignatureChange
}:{
  imageUrl:string
  mode:DrawMode
  dateText:string
  onDateChange:(v:string)=>void
  onSignatureChange:(v:string|null)=>void
}){
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const imgRef=useRef<HTMLImageElement|null>(null)
  const drawing=useRef(false)
  const [loaded,setLoaded]=useState(false)

  const redraw=()=>{
    const c=canvasRef.current
    const img=imgRef.current
    if(!c||!img)return
    const ctx=c.getContext('2d')!
    ctx.clearRect(0,0,c.width,c.height)
    ctx.drawImage(img,0,0,c.width,c.height)
  }

  useEffect(()=>{
    const img=new Image()
    img.onload=()=>{
      imgRef.current=img
      const c=canvasRef.current!
      const w=c.clientWidth||320
      const ratio=img.height/img.width
      c.width=Math.floor(w*Math.min(2,window.devicePixelRatio||1))
      c.height=Math.floor(w*ratio*Math.min(2,window.devicePixelRatio||1))
      redraw()
      setLoaded(true)
    }
    img.src=imageUrl
  },[imageUrl])

  useEffect(()=>{ if(loaded) redraw() },[loaded])

  const pos=(e:React.PointerEvent<HTMLCanvasElement>)=>{
    const r=e.currentTarget.getBoundingClientRect()
    const sx=e.currentTarget.width/r.width
    const sy=e.currentTarget.height/r.height
    return{x:(e.clientX-r.left)*sx,y:(e.clientY-r.top)*sy}
  }

  const drawDate=(x:number,y:number)=>{
    const c=canvasRef.current!
    const ctx=c.getContext('2d')!
    const dpr=Math.min(2,window.devicePixelRatio||1)
    ctx.font=`${18*dpr}px sans-serif`
    ctx.fillStyle='#111'
    ctx.fillText(dateText||new Date().toLocaleDateString('ko-KR'),x,y)
  }

  return <div className="annotationWrap">
    <div className="dateInputRow">
      <input value={dateText} onChange={e=>onDateChange(e.target.value)} placeholder="예: 2026년 8월 12일"/>
      <button onClick={()=>onDateChange(new Date().toLocaleDateString('ko-KR'))}>오늘</button>
      <button onClick={()=>{redraw();onSignatureChange(null)}}>초기화</button>
    </div>
    <canvas
      ref={canvasRef}
      className="annotationCanvas"
      onPointerDown={e=>{
        e.currentTarget.setPointerCapture(e.pointerId)
        const p=pos(e)
        const ctx=e.currentTarget.getContext('2d')!
        if(mode==='date'){
          drawDate(p.x,p.y)
          return
        }
        drawing.current=true
        ctx.beginPath()
        ctx.moveTo(p.x,p.y)
        ctx.lineWidth=5*Math.min(2,window.devicePixelRatio||1)
        ctx.lineCap='round'
        ctx.lineJoin='round'
        ctx.strokeStyle='#111'
      }}
      onPointerMove={e=>{
        if(!drawing.current)return
        const p=pos(e)
        const ctx=e.currentTarget.getContext('2d')!
        ctx.lineTo(p.x,p.y);ctx.stroke()
      }}
      onPointerUp={e=>{
        if(drawing.current){
          drawing.current=false
          onSignatureChange(e.currentTarget.toDataURL('image/png'))
        }
      }}
    />
    <small className="hint">
      {mode==='date'?'원하는 위치를 탭하면 날짜가 들어갑니다.':mode==='signature'?'손가락으로 서명하세요.':'펜처럼 자유롭게 기입하세요.'}
    </small>
  </div>
}
