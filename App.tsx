import { useEffect, useRef, useState } from 'react'
import { detectSignatureBlocks, scoreFastText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import { cropCanvas, loadPdf, preprocessCanvas, renderFast, renderPagePreview, renderPrecise, ROTATIONS } from './pdf'
import type { Rotation, SignatureBlock } from './types'

type Tool='date'|'signature'|'pen'
const pct=(n:number)=>`${Math.round(n*100)}%`

export default function App(){
  const [file,setFile]=useState<File|null>(null)
  const [status,setStatus]=useState('PDF를 올려주세요')
  const [processing,setProcessing]=useState(false)

  // targetProgress = actual stage ceiling
  // visibleProgress = animated, never appears frozen
  const [targetProgress,setTargetProgress]=useState(0)
  const [visibleProgress,setVisibleProgress]=useState(0)

  const [block,setBlock]=useState<SignatureBlock|null>(null)
  const [focusImage,setFocusImage]=useState<string|null>(null)
  const [fullPreview,setFullPreview]=useState<string|null>(null)
  const [timing,setTiming]=useState<{scan:number;precise:number;total:number}|null>(null)
  const [tool,setTool]=useState<Tool>('date')
  const [dateText,setDateText]=useState('')
  const [hasInk,setHasInk]=useState(false)
  const inputRef=useRef<HTMLInputElement>(null)

  useEffect(()=>()=>{terminateOCR()},[])

  // Continuous progress animator:
  // - increments visibly by 1%
  // - while a long OCR call is running, gently "breathes" toward targetProgress+buffer
  // - never reaches 100 until processing is actually complete
  useEffect(()=>{
    if(!processing && visibleProgress>=targetProgress)return
    const id=window.setInterval(()=>{
      setVisibleProgress(v=>{
        let ceiling=targetProgress
        if(processing){
          // During a blocking OCR stage, allow slow continued visual motion up to 4% beyond
          // the last real milestone, capped at 96%.
          ceiling=Math.min(96,Math.max(ceiling,targetProgress+4))
        }
        if(v<ceiling)return v+1
        return v
      })
    },70)
    return()=>clearInterval(id)
  },[processing,targetProgress,visibleProgress])

  async function analyze(selected:File){
    setFile(selected);setProcessing(true);setBlock(null);setFocusImage(null);setFullPreview(null)
    setTiming(null);setHasInk(false);setVisibleProgress(0);setTargetProgress(2)
    const totalStart=performance.now()

    try{
      const pdf=await loadPdf(selected)
      setStatus('문서 방향과 서명 블록을 빠르게 찾는 중…')
      setTargetProgress(6)

      // v3-style fast path:
      // scan each page at 0° once; only rotate pages whose text/date+signer score is weak.
      const scanStart=performance.now()
      let best:{pageIndex:number;rotation:Rotation;score:number}|null=null

      for(let p=0;p<pdf.numPages;p++){
        const page=await pdf.getPage(p+1)
        const c=preprocessCanvas(await renderFast(page,0))
        const r=await recognizeTextFast(c)
        const s=scoreFastText(r.text).score+r.confidence*.08
        if(!best||s>best.score)best={pageIndex:p,rotation:0,score:s}
        setTargetProgress(8+Math.round(((p+1)/pdf.numPages)*36))
      }

      if(!best)throw new Error('후보 페이지를 찾지 못했습니다.')

      // Rotate only the single best page if score is not strong.
      if(best.score<115){
        const page=await pdf.getPage(best.pageIndex+1)
        for(let i=1;i<ROTATIONS.length;i++){
          const rotation=ROTATIONS[i]
          setStatus(`${best.pageIndex+1}페이지 방향 확인 · ${rotation}°`)
          const c=preprocessCanvas(await renderFast(page,rotation))
          const r=await recognizeTextFast(c)
          const s=scoreFastText(r.text).score+r.confidence*.08
          if(s>best.score)best={...best,rotation,score:s}
          setTargetProgress(45+i*4)
          if(best.score>=115)break
        }
      }

      const scanMs=performance.now()-scanStart
      setTargetProgress(60)

      // Precise word boxes once, only selected page+rotation.
      const preciseStart=performance.now()
      setStatus(`${best.pageIndex+1}페이지에서 연·월·일 + 서명 영역을 확인 중…`)
      const page=await pdf.getPage(best.pageIndex+1)
      const precise=preprocessCanvas(await renderPrecise(page,best.rotation))
      const tokens=await recognizeWordsPrecise(precise,best.pageIndex,(p,s)=>{
        setStatus(`정밀 탐지 · ${s}`)
        setTargetProgress(60+Math.round(p*28))
      })

      const blocks=detectSignatureBlocks(tokens,best.rotation)
      const top=blocks[0]??null
      setBlock(top)
      setTargetProgress(91)

      const preview=await renderPagePreview(page)
      setFullPreview(preview)

      if(top){
        const crop=cropCanvas(precise,top.rotatedRect)
        setFocusImage(crop.toDataURL('image/jpeg',.94))
        setStatus('연·월·일과 서명이 함께 있는 영역을 찾았어요')
      }else{
        setStatus('날짜와 서명이 함께 있는 영역을 찾지 못했어요')
      }

      setTiming({
        scan:scanMs,
        precise:performance.now()-preciseStart,
        total:performance.now()-totalStart
      })

      setTargetProgress(97)
      // Give the animated progress enough time to visibly finish rather than jumping.
      await new Promise(r=>setTimeout(r,220))
      setTargetProgress(100)
    }catch(e){
      console.error(e)
      setStatus(`오류: ${e instanceof Error?e.message:String(e)}`)
      setTargetProgress(100)
    }finally{
      setProcessing(false)
      // Finish one percent at a time after actual work ends.
      setTargetProgress(100)
    }
  }

  return <div className="app">
    <header><div>
      <p className="eyebrow">DATE + SIGNATURE PROXIMITY · FAST OCR</p>
      <h1>서명영역 탐지 v5</h1>
      <p className="sub">문서 위치가 아니라 ‘날짜 + 서명 계열 텍스트가 함께 있는 블록’을 찾습니다.</p>
    </div></header>

    <section className={`dropzone ${processing?'disabled':''}`} onClick={()=>!processing&&inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={e=>{const f=e.target.files?.[0];if(f)analyze(f)}}/>
      <div className="uploadIcon">PDF</div>
      <strong>{file?file.name:'성능점검기록부 PDF 업로드'}</strong>
      <span>{processing?'분석 중…':'휴대폰에서 PDF를 선택하세요.'}</span>
    </section>

    {(processing||file)&&<section className="statusCard">
      <div className="statusTop"><strong>{status}</strong><span className="bigPercent">{visibleProgress}%</span></div>
      <div className="progress"><i style={{width:`${visibleProgress}%`}}/></div>
      <div className="progressTicks"><span>문서</span><span>방향</span><span>정밀 OCR</span><span>완료</span></div>
      {timing&&<div className="timing">탐색 {(timing.scan/1000).toFixed(1)}s · 정밀 {(timing.precise/1000).toFixed(1)}s · 총 {(timing.total/1000).toFixed(1)}s</div>}
    </section>}

    {!processing&&block&&focusImage&&<>
      <section className="card editorCard" style={{marginTop:16}}>
        <div className="cardHead">
          <div><p className="label">FOUND SIGNING BLOCK</p><h2>이 영역에 날짜와 서명을 입력해 주세요</h2></div>
          <span className="confidence high">{pct(block.confidence)}</span>
        </div>

        <div className="toolTabs">
          <button className={tool==='date'?'active':''} onClick={()=>setTool('date')}>연·월·일</button>
          <button className={tool==='signature'?'active':''} onClick={()=>setTool('signature')}>서명</button>
          <button className={tool==='pen'?'active':''} onClick={()=>setTool('pen')}>자유필기</button>
        </div>

        <DocumentInkEditor
          imageUrl={focusImage}
          tool={tool}
          dateText={dateText}
          setDateText={setDateText}
          onInk={()=>setHasInk(true)}
        />
      </section>

      {fullPreview&&<section className="card" style={{marginTop:16}}>
        <div className="cardHead"><div><p className="label">FULL PAGE</p><h2>전체 PDF 내 위치</h2></div><span className="pageBadge">{block.pageIndex+1}페이지</span></div>
        <div className="pagePreview">
          <img src={fullPreview} alt="PDF 페이지"/>
          <div className="detectedRect" style={{
            left:`${block.rect.x*100}%`,top:`${block.rect.y*100}%`,
            width:`${block.rect.width*100}%`,height:`${block.rect.height*100}%`
          }}><span>날짜·서명 영역</span></div>
        </div>
      </section>}

      <section className="judgeCard">
        <div><strong>{hasInk?'입력 내용이 있습니다.':'날짜와 서명을 입력해 주세요.'}</strong><span>확대한 스캔본 자체 위에 손가락으로 작성할 수 있습니다.</span></div>
        <button className="primaryBtn" disabled={!hasInk}>입력 완료</button>
      </section>
    </>}
  </div>
}

function DocumentInkEditor({
  imageUrl,tool,dateText,setDateText,onInk
}:{
  imageUrl:string;tool:Tool;dateText:string;setDateText:(v:string)=>void;onInk:()=>void
}){
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const imgRef=useRef<HTMLImageElement|null>(null)
  const drawing=useRef(false)
  const strokes=useRef<ImageData[]>([])

  const redrawBase=()=>{
    const c=canvasRef.current,img=imgRef.current
    if(!c||!img)return
    const ctx=c.getContext('2d')!
    ctx.clearRect(0,0,c.width,c.height)
    ctx.drawImage(img,0,0,c.width,c.height)
    strokes.current=[]
  }

  useEffect(()=>{
    const img=new Image()
    img.onload=()=>{
      imgRef.current=img
      const c=canvasRef.current!
      const cssW=c.clientWidth||320
      const dpr=Math.min(2,window.devicePixelRatio||1)
      c.width=Math.floor(cssW*dpr)
      c.height=Math.max(160,Math.floor(cssW*(img.height/img.width)*dpr))
      redrawBase()
    }
    img.src=imageUrl
  },[imageUrl])

  const pos=(e:React.PointerEvent<HTMLCanvasElement>)=>{
    const r=e.currentTarget.getBoundingClientRect()
    return{
      x:(e.clientX-r.left)*(e.currentTarget.width/r.width),
      y:(e.clientY-r.top)*(e.currentTarget.height/r.height)
    }
  }

  const putDate=(x:number,y:number)=>{
    const c=canvasRef.current!,ctx=c.getContext('2d')!
    const dpr=Math.min(2,window.devicePixelRatio||1)
    ctx.fillStyle='#111'
    ctx.font=`${17*dpr}px sans-serif`
    ctx.textBaseline='middle'
    ctx.fillText(dateText||new Date().toLocaleDateString('ko-KR'),x,y)
    onInk()
  }

  return <div className="annotationWrap">
    <div className="dateInputRow">
      <input value={dateText} onChange={e=>setDateText(e.target.value)} placeholder="예: 2026년 8월 12일"/>
      <button onClick={()=>setDateText(new Date().toLocaleDateString('ko-KR'))}>오늘</button>
      <button onClick={redrawBase}>초기화</button>
    </div>

    <canvas ref={canvasRef} className="annotationCanvas"
      onPointerDown={e=>{
        e.currentTarget.setPointerCapture(e.pointerId)
        const p=pos(e)
        if(tool==='date'){putDate(p.x,p.y);return}
        const ctx=e.currentTarget.getContext('2d')!
        drawing.current=true
        ctx.beginPath();ctx.moveTo(p.x,p.y)
        ctx.strokeStyle='#111'
        ctx.lineCap='round';ctx.lineJoin='round'
        ctx.lineWidth=(tool==='signature'?3.2:2.2)*Math.min(2,window.devicePixelRatio||1)
      }}
      onPointerMove={e=>{
        if(!drawing.current)return
        const p=pos(e),ctx=e.currentTarget.getContext('2d')!
        ctx.lineTo(p.x,p.y);ctx.stroke();onInk()
      }}
      onPointerUp={()=>{drawing.current=false}}
    />
    <small className="hint">
      {tool==='date'?'입력할 위치를 탭하면 날짜가 들어갑니다.':tool==='signature'?'원본 위에 손가락으로 바로 서명하세요.':'날짜도 직접 쓰고 싶다면 자유필기로 작성할 수 있습니다.'}
    </small>
  </div>
}
