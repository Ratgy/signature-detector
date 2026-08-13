import {
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import {assessTokens} from './detection'
import {detectOrientation} from './orientation'
import {recognizePage,terminateOCR} from './ocr'
import {
  buildFallbackRegions,
  buildFallbackSheet,
  cropPage,
  expandRectByPixels,
  loadSource,
  mapLocalRectToPage,
  preprocess,
  renderOrientedPage,
  tokensForMeta
} from './source'

import type {
  FileResult,
  OCRToken,
  Rect,
  TargetCandidate
} from './types'

const VERSION='17.0'
const BUILD='2026-08-13'

const makeId=()=>Math.random().toString(36).slice(2)

const emptyResult=(file:File):FileResult=>({
  id:makeId(),
  fileName:file.name,
  fileType:
    file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf')
      ?'pdf':'image',
  status:'queued',
  progress:0,
  message:'대기 중',
  pageCount:0,
  pageIndex:null,
  confidence:0,
  pagePreview:null,
  cropPreview:null,
  targetRect:null,
  cropRect:null,
  elapsedMs:0,
  orientationCorrection:0,
  orientationConfidence:0,
  orientationOriginalPreview:null,
  orientationCorrectedPreview:null
})

export default function App(){
  const [files,setFiles]=useState<File[]>([])
  const [results,setResults]=useState<FileResult[]>([])
  const [processing,setProcessing]=useState(false)
  const inputRef=useRef<HTMLInputElement>(null)
  const timers=useRef<Record<number,number>>({})
  const ticks=useRef<Record<number,number>>({})

  useEffect(()=>()=>{terminateOCR()},[])

  // 절대 감소하지 않는 progress 업데이트.
  function update(index:number,patch:Partial<FileResult>){
    setResults(prev=>prev.map((result,i)=>{
      if(i!==index)return result
      const next={...result,...patch}
      if(patch.progress!==undefined){
        next.progress=Math.max(
          result.progress,
          Math.min(100,Math.round(patch.progress))
        )
      }
      return next
    }))
  }

  function stopProgress(index:number){
    const id=timers.current[index]
    if(id){
      clearInterval(id)
      delete timers.current[index]
      delete ticks.current[index]
    }
  }

  function startProgress(index:number){
    stopProgress(index)
    ticks.current[index]=0
    timers.current[index]=window.setInterval(()=>{
      ticks.current[index]=(ticks.current[index]??0)+1
      const tick=ticks.current[index]
      setResults(prev=>prev.map((r,i)=>{
        if(i!==index||r.status!=='processing'||r.progress>=96)return r
        const stageCeiling=
          r.message.includes('방향')||r.message.includes('회전')
            ?32
            :r.message.includes('저화질')||r.message.includes('보정 판독')
              ?92
              :r.message.includes('확대')
                ?97
                :72
        if(r.progress>=stageCeiling)return r
        const move=
          r.progress<40||
          (r.progress<75&&tick%3===0)||
          (r.progress>=75&&tick%7===0)
        return move?{...r,progress:r.progress+1}:r
      }))
    },130)
  }

  async function firstPass(
    page:HTMLCanvasElement,
    pageIndex:number,
    index:number,
    pageNumber:number,
    pageCount:number
  ){
    const processed=preprocess(page,'gray')
    const tokens=await recognizePage(
      processed,
      pageIndex,
      p=>update(index,{
        progress:36+((pageNumber-1+p)/Math.max(1,pageCount))*34,
        message:`${pageNumber}/${pageCount} 페이지 판독 중`
      }),
      false
    )
    return assessTokens(tokens,pageIndex)
  }

  async function fallbackPass(
    page:HTMLCanvasElement,
    pageIndex:number,
    index:number
  ){
    const regions=buildFallbackRegions(page,pageIndex)
    const contact=buildFallbackSheet(page,regions,'adaptive')
    const tokens=await recognizePage(
      contact.canvas,
      pageIndex,
      p=>update(index,{
        progress:72+p*20,
        message:'저화질 스캔 보정 판독 중'
      }),
      true
    )

    let best:TargetCandidate|null=null
    let hint=0

    for(const meta of contact.metas){
      const local=tokensForMeta(tokens,contact.canvas,meta)
      const assessment=assessTokens(local,pageIndex)
      hint=Math.max(hint,assessment.hintScore)
      if(assessment.target){
        const mapped={
          ...assessment.target,
          targetRect:mapLocalRectToPage(
            assessment.target.targetRect,
            meta.region.rect
          )
        }
        if(!best||mapped.score>best.score)best=mapped
      }
    }

    return{target:best,hintScore:hint}
  }

  async function processOne(file:File,index:number){
    const started=performance.now()
    update(index,{status:'processing',progress:1,message:'문서 준비 중'})
    startProgress(index)

    const src=await loadSource(file)
    const imageInput=src.type==='image'
    update(index,{
      pageCount:src.pageCount,
      progress:4,
      message:'문자 방향 확인 중'
    })

    // v17: 파일을 새로 저장하지 않는다.
    // OCR로 필요한 회전각만 판단하고 이후 렌더링에 그 각도를 적용한다.
    const orientation=await detectOrientation(
      src,
      (progress,message)=>update(index,{progress,message})
    )

    update(index,{
      progress:25,
      message:
        orientation.correction===0
          ?'정방향 확인 완료'
          :'문자 방향에 맞춰 문서 보정 완료',
      orientationCorrection:orientation.correction,
      orientationConfidence:orientation.confidence,
      orientationOriginalPreview:orientation.originalPreview,
      orientationCorrectedPreview:orientation.correctedPreview
    })

    update(index,{
      progress:27,
      message:'서명영역 탐색 중'
    })

    let best:TargetCandidate|null=null
    const pageHints:{pageIndex:number;hint:number}[]=[]
    const pageCache=new Map<number,HTMLCanvasElement>()

    // 1차: 페이지당 OCR 딱 한 번. 기존 contact-sheet 4~8배 중복 OCR 제거.
    for(let pageIndex=0;pageIndex<src.pageCount;pageIndex++){
      const page=await renderOrientedPage(
        src,
        pageIndex,
        imageInput?1750:1450,
        orientation.correction
      )
      pageCache.set(pageIndex,page)

      const assessment=await firstPass(
        page,pageIndex,index,pageIndex+1,src.pageCount
      )
      pageHints.push({pageIndex,hint:assessment.hintScore})

      if(assessment.target&&(!best||assessment.target.score>best.score)){
        best=assessment.target
      }

      if(assessment.target&&assessment.target.confidence>=.82){
        best=assessment.target
        break
      }
    }

    // 2차는 1차 실패 때만. 가장 가능성 높은 최대 2개 페이지만 확대 분할 OCR 1회.
    if(!best||best.confidence<.72){
      const candidates=[...pageHints]
        .sort((a,b)=>b.hint-a.hint)
        .slice(0,Math.min(2,src.pageCount))

      for(const candidate of candidates){
        const page=pageCache.get(candidate.pageIndex)??await renderOrientedPage(
          src,
          candidate.pageIndex,
          imageInput?1950:1650,
          orientation.correction
        )
        pageCache.set(candidate.pageIndex,page)

        const assessment=await fallbackPass(page,candidate.pageIndex,index)
        if(assessment.target&&(!best||assessment.target.score>best.score)){
          best=assessment.target
        }
        if(assessment.target&&assessment.target.confidence>=.78){
          best=assessment.target
          break
        }
      }
    }

    if(!best||best.confidence<.68){
      stopProgress(index)
      update(index,{
        status:'failed',
        progress:100,
        message:'서명영역을 찾지 못했습니다.',
        elapsedMs:performance.now()-started
      })
      return
    }

    update(index,{progress:94,message:'서명영역 확대 중'})

    // 결과/편집용은 원본 톤으로 다시 렌더. 같은 좌표를 원본과 확대본이 공유한다.
    const finalPage=await renderOrientedPage(
      src,
      best.pageIndex,
      1800,
      orientation.correction
    )
    const cropRect=expandRectByPixels(finalPage,best.targetRect,40)
    const crop=cropPage(finalPage,cropRect,1600)

    stopProgress(index)
    update(index,{
      status:'success',
      progress:100,
      message:'완료',
      pageIndex:best.pageIndex,
      confidence:best.confidence,
      pagePreview:finalPage.toDataURL('image/jpeg',.93),
      cropPreview:crop.toDataURL('image/jpeg',.98),
      targetRect:best.targetRect,
      cropRect,
      elapsedMs:performance.now()-started
    })
  }

  async function start(){
    if(!files.length||processing)return
    setProcessing(true)
    setResults(files.map(emptyResult))

    for(let i=0;i<files.length;i++){
      try{
        await processOne(files[i],i)
      }catch(error){
        stopProgress(i)
        update(i,{
          status:'failed',
          progress:100,
          message:`오류: ${error instanceof Error?error.message:String(error)}`
        })
      }
    }

    setProcessing(false)
  }

  function selectFiles(list:FileList|null){
    if(!list)return
    const selected=Array.from(list)
      .filter(file=>{
        const name=file.name.toLowerCase()
        return file.type==='application/pdf'||
          file.type==='image/jpeg'||
          file.type==='image/png'||
          name.endsWith('.pdf')||
          name.endsWith('.jpg')||
          name.endsWith('.jpeg')||
          name.endsWith('.png')
      })
      .slice(0,5)
    setFiles(selected)
    setResults([])
  }

  function judge(index:number,judgement:FileResult['judgement']){
    update(index,{judgement})
  }

  const stats=useMemo(()=>{
    const judged=results.filter(r=>r.judgement)
    const exact=judged.filter(r=>r.judgement==='correct').length
    const partial=judged.filter(r=>r.judgement==='partial').length
    return{
      total:judged.length,
      exact:judged.length?Math.round(exact/judged.length*100):0,
      usable:judged.length?Math.round((exact+partial)/judged.length*100):0
    }
  },[results])

  return <div className="app">
    <header>
      <div>
        <p className="eyebrow">OCR ORIENTATION PREVIEW · LINKED SIGNATURE</p>
        <h1>서명영역 탐지 v{VERSION}</h1>
        <div className="versionBadge">BUILD {VERSION} · {BUILD}</div>
        <p className="sub">
          문자 방향이 틀어진 문서만 화면에서 정방향으로 보정한 뒤 서명영역을 찾아 확대합니다.
        </p>
      </div>
    </header>

    <section
      className={`dropzone ${processing?'disabled':''}`}
      onClick={()=>!processing&&inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        hidden
        onChange={e=>selectFiles(e.target.files)}
      />
      <div className="uploadIcon">5</div>
      <strong>{files.length?`${files.length}개 파일 선택됨`:'PDF / JPG / PNG 최대 5개'}</strong>
      <span>회전된 스캔은 저장하지 않고 OCR 문자 방향에 맞춰 화면에서만 보정합니다.</span>
    </section>

    {files.length>0&&<section className="batchList">
      {files.map((f,i)=><div className="fileChip" key={`${f.name}-${i}`}>
        <b>{i+1}</b><span>{f.name}</span>
      </div>)}
      <button className="startBtn" disabled={processing} onClick={start}>
        {processing?'분석 중…':'분석 시작'}
      </button>
    </section>}

    {results.map((r,i)=><section className="resultCard card" key={r.id}>
      <div className="resultTop">
        <div><p className="label">FILE {i+1}</p><h2>{r.fileName}</h2></div>
        {r.status==='success'&&<span className="successBadge">{Math.round(r.confidence*100)}%</span>}
      </div>

      {r.status==='processing'&&<>
        <div className="statusTop"><strong>{r.message}</strong><span className="bigPercent">{r.progress}%</span></div>
        <div className="progress"><i style={{width:`${r.progress}%`}}/></div>
      </>}

      {r.orientationCorrection!==0&&
        r.orientationOriginalPreview&&
        r.orientationCorrectedPreview&&
        <div className="orientationCompare">
          <div className="orientationCompareHead">
            <div>
              <span>문서 방향 보정</span>
              <strong>
                OCR 문자 방향 기준 {r.orientationCorrection}° 회전
              </strong>
            </div>
            <b>{Math.round(r.orientationConfidence)}%</b>
          </div>

          <div className="orientationCompareGrid">
            <figure>
              <figcaption>원본 방향</figcaption>
              <img
                src={r.orientationOriginalPreview}
                alt="회전 전 원본"
              />
            </figure>

            <div className="orientationArrow">→</div>

            <figure>
              <figcaption>문자 기준 정방향</figcaption>
              <img
                src={r.orientationCorrectedPreview}
                alt="OCR 문자 방향으로 회전한 문서"
              />
            </figure>
          </div>

          <p>
            원본 파일은 변경하거나 저장하지 않고,
            아래 서명 탐지만 이 정방향을 기준으로 진행합니다.
          </p>
        </div>
      }

      {r.status==='success'&&r.pagePreview&&r.cropPreview&&r.targetRect&&r.cropRect&&
        <LinkedSignatureEditor
          pageImage={r.pagePreview}
          cropImage={r.cropPreview}
          targetRect={r.targetRect}
          cropRect={r.cropRect}
        />
      }

      {r.status==='failed'&&<div className="failureText">서명영역을 찾지 못했습니다.</div>}

      {r.status==='success'&&<div className="judgeButtons">
        <button className={r.judgement==='correct'?'selected':''} onClick={()=>judge(i,'correct')}>정확함</button>
        <button className={r.judgement==='partial'?'selected':''} onClick={()=>judge(i,'partial')}>일부 포함</button>
        <button className={r.judgement==='wrong'?'selected':''} onClick={()=>judge(i,'wrong')}>틀림</button>
      </div>}
    </section>)}

    {stats.total>0&&<section className="stats compactStats">
      <div><span>평가</span><strong>{stats.total}</strong></div>
      <div><span>Exact</span><strong>{stats.exact}%</strong></div>
      <div><span>Usable</span><strong>{stats.usable}%</strong></div>
    </section>}
  </div>
}

type Point={x:number;y:number}
type Stroke=Point[]

function LinkedSignatureEditor({
  pageImage,
  cropImage,
  targetRect,
  cropRect
}:{
  pageImage:string
  cropImage:string
  targetRect:Rect
  cropRect:Rect
}){
  const pageCanvas=useRef<HTMLCanvasElement>(null)
  const cropCanvas=useRef<HTMLCanvasElement>(null)
  const pageImg=useRef<HTMLImageElement|null>(null)
  const cropImg=useRef<HTMLImageElement|null>(null)
  const [strokes,setStrokes]=useState<Stroke[]>([])
  const active=useRef<Stroke|null>(null)

  function fitCanvas(canvas:HTMLCanvasElement,img:HTMLImageElement,maxDpr=2){
    const cssWidth=canvas.clientWidth||320
    const ratio=img.naturalHeight/img.naturalWidth
    const dpr=Math.min(maxDpr,window.devicePixelRatio||1)
    canvas.width=Math.max(1,Math.round(cssWidth*dpr))
    canvas.height=Math.max(1,Math.round(cssWidth*ratio*dpr))
  }

  function drawStroke(
    ctx:CanvasRenderingContext2D,
    stroke:Stroke,
    width:number,
    height:number,
    lineWidth:number
  ){
    if(stroke.length<1)return
    ctx.beginPath()
    ctx.moveTo(stroke[0].x*width,stroke[0].y*height)
    for(const p of stroke.slice(1))ctx.lineTo(p.x*width,p.y*height)
    ctx.strokeStyle='#111'
    ctx.lineWidth=lineWidth
    ctx.lineCap='round'
    ctx.lineJoin='round'
    ctx.stroke()
  }

  function redraw(){
    const pc=pageCanvas.current
    const cc=cropCanvas.current
    const pi=pageImg.current
    const ci=cropImg.current
    if(!pc||!cc||!pi||!ci)return

    const pctx=pc.getContext('2d')!
    pctx.clearRect(0,0,pc.width,pc.height)
    pctx.drawImage(pi,0,0,pc.width,pc.height)

    // 원본 사진에서 실제 서명영역을 노란 테두리로 표시.
    pctx.save()
    pctx.strokeStyle='#FAC729'
    pctx.lineWidth=Math.max(4,pc.width*.004)
    pctx.strokeRect(
      targetRect.x*pc.width,
      targetRect.y*pc.height,
      targetRect.width*pc.width,
      targetRect.height*pc.height
    )
    pctx.restore()

    const cctx=cc.getContext('2d')!
    cctx.clearRect(0,0,cc.width,cc.height)
    cctx.drawImage(ci,0,0,cc.width,cc.height)

    for(const stroke of strokes){
      drawStroke(cctx,stroke,cc.width,cc.height,Math.max(3,cc.width*.005))

      // 확대 crop 좌표를 원본 page 좌표로 역매핑.
      const pageStroke=stroke.map(p=>({
        x:cropRect.x+p.x*cropRect.width,
        y:cropRect.y+p.y*cropRect.height
      }))
      drawStroke(pctx,pageStroke,pc.width,pc.height,Math.max(2,pc.width*.0025))
    }
  }

  useEffect(()=>{
    let count=0
    const ready=()=>{
      count++
      if(count<2)return
      const pc=pageCanvas.current!,cc=cropCanvas.current!
      fitCanvas(pc,pageImg.current!)
      fitCanvas(cc,cropImg.current!)
      redraw()
    }

    const p=new Image()
    p.onload=ready
    p.src=pageImage
    pageImg.current=p

    const c=new Image()
    c.onload=ready
    c.src=cropImage
    cropImg.current=c
  },[pageImage,cropImage])

  useEffect(()=>{redraw()},[strokes])

  useEffect(()=>{
    const onResize=()=>{
      if(!pageCanvas.current||!cropCanvas.current||!pageImg.current||!cropImg.current)return
      fitCanvas(pageCanvas.current,pageImg.current)
      fitCanvas(cropCanvas.current,cropImg.current)
      redraw()
    }
    window.addEventListener('resize',onResize)
    return()=>window.removeEventListener('resize',onResize)
  },[strokes])

  function point(e:React.PointerEvent<HTMLCanvasElement>):Point{
    const r=e.currentTarget.getBoundingClientRect()
    return{
      x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),
      y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))
    }
  }

  return <div className="linkedEditor">
    <div className="editorSection">
      <div className="editorTitle"><h3>원본</h3><span>노란 테두리가 탐지된 서명영역입니다.</span></div>
      <div className="originalCanvasWrap"><canvas ref={pageCanvas}/></div>
    </div>

    <div className="editorSection signatureEditorFill">
      <div className="editorTitle"><h3>서명영역</h3><span>확대된 원본 위에 직접 작성하세요.</span></div>
      <div className="signatureCanvasWrap">
        <canvas
          ref={cropCanvas}
          onPointerDown={e=>{
            e.currentTarget.setPointerCapture(e.pointerId)
            const s=[point(e)]
            active.current=s
            setStrokes(prev=>[...prev,s])
          }}
          onPointerMove={e=>{
            if(!active.current)return
            const p=point(e)
            active.current.push(p)
            setStrokes(prev=>{
              const copy=[...prev]
              copy[copy.length-1]=[...active.current!]
              return copy
            })
          }}
          onPointerUp={()=>{active.current=null}}
          onPointerCancel={()=>{active.current=null}}
        />
      </div>
      <div className="editorActions">
        <span>이곳에 쓴 내용은 위 원본의 같은 위치에도 반영됩니다.</span>
        <button onClick={()=>setStrokes([])}>작성 초기화</button>
      </div>
    </div>
  </div>
}
