import {
  useEffect,
  useRef,
  useState
} from 'react'

import {
  assessTokens,
  quickSignatureRect,
  refineSignatureRect
} from './detection'

import {
  decidePageDirection
} from './orientation'

import {
  recognizeFullForDirection,
  recognizePage,
  terminateOCR,
  warmupOCR
} from './ocr'

import {
  cropPage,
  expandRectByPixels,
  loadSource,
  mapLocalRectToPage,
  preprocess,
  renderOrientedPage,
  renderPage
} from './source'

import type {
  FileResult,
  OCRToken,
  Rect,
  TargetCandidate
} from './types'

const VERSION='24.0'
const BUILD='2026-08-14 · COARSE → RE-DETECT'

const makeId=()=>
  Math.random()
    .toString(36)
    .slice(2)

const emptyResult=(
  file:File
):FileResult=>({
  id:makeId(),
  fileName:file.name,
  status:'queued',
  progress:0,
  message:'대기 중',
  pageCount:0,
  pageIndex:null,
  pagePreview:null,
  cropPreview:null,
  targetRect:null,
  cropRect:null,
  elapsedMs:0
})

export default function App(){
  const [files,setFiles]=
    useState<File[]>([])

  const [results,setResults]=
    useState<FileResult[]>([])

  const [
    processing,
    setProcessing
  ]=useState(false)

  const inputRef=
    useRef<HTMLInputElement>(
      null
    )

  const timers=
    useRef<
      Record<number,number>
    >({})

  useEffect(
    ()=>{
      // 사용자가 파일을 고르는 동안 OCR wasm/kor model을 미리 준비한다.
      // 분석 버튼을 누른 뒤 발생하던 초기 로딩 시간을 숨긴다.
      void warmupOCR()

      return()=>{
        void terminateOCR()
      }
    },
    []
  )

  // progress는 어떤 내부 단계에서도 절대로 감소하지 않는다.
  function update(
    index:number,
    patch:Partial<FileResult>
  ){
    setResults(prev=>
      prev.map(
        (result,i)=>{
          if(i!==index){
            return result
          }

          const next={
            ...result,
            ...patch
          }

          if(
            patch.progress!==
            undefined
          ){
            next.progress=
              Math.max(
                result.progress,
                Math.min(
                  100,
                  Math.round(
                    patch.progress
                  )
                )
              )
          }

          return next
        }
      )
    )
  }

  function stopProgress(
    index:number
  ){
    const timer=
      timers.current[index]

    if(timer){
      clearInterval(timer)
      delete timers.current[index]
    }
  }

  function startProgress(
    index:number
  ){
    stopProgress(index)

    timers.current[index]=
      window.setInterval(
        ()=>{
          setResults(prev=>
            prev.map(
              (result,i)=>{
                if(
                  i!==index||
                  result.status!==
                    'processing'||
                  result.progress>=96
                ){
                  return result
                }

                const ceiling=
                  result.message.includes(
                    '방향'
                  )
                    ?26
                    :result.message.includes(
                        '정밀'
                      )
                      ?92
                      :result.message.includes(
                          '확대'
                        )
                        ?97
                        :74

                if(
                  result.progress>=
                  ceiling
                ){
                  return result
                }

                return{
                  ...result,
                  progress:
                    result.progress+1
                }
              }
            )
          )
        },
        160
      )
  }

  function panelRects(
    page:HTMLCanvasElement
  ):Rect[]{
    const aspect=
      page.width/page.height

    if(aspect>1.18){
      // 2-up 스캔을 가장 먼저 논리 페이지로 분리한다.
      // 우/좌는 탐색 순서일 뿐 위치를 정답으로 가정하지 않는다.
      return[
        {
          x:.49,
          y:0,
          width:.51,
          height:1
        },
        {
          x:0,
          y:0,
          width:.51,
          height:1
        },
        // 단일 landscape 서식이나 중앙을 가로지르는 필드 fallback.
        {
          x:0,
          y:0,
          width:1,
          height:1
        }
      ]
    }

    return[
      {
        x:0,
        y:0,
        width:1,
        height:1
      }
    ]
  }

  function bandRects(
    panel:Rect
  ):Rect[]{
    const starts=[
      0,
      .22,
      .44,
      .66
    ]

    return starts.map(start=>{
      const localHeight=
        Math.min(
          .34,
          1-start
        )

      return{
        x:panel.x,
        y:
          panel.y+
          start*panel.height,
        width:panel.width,
        height:
          localHeight*
          panel.height
      }
    })
  }

  function buildContactSheet(
    page:HTMLCanvasElement,
    rects:Rect[],
    targetWidth=1180
  ){
    const crops=
      rects.map(rect=>
        cropPage(
          page,
          rect,
          targetWidth
        )
      )

    const gap=26
    const width=
      Math.max(
        ...crops.map(
          crop=>crop.width
        )
      )

    const height=
      crops.reduce(
        (sum,crop)=>
          sum+crop.height,
        0
      )+
      gap*
      Math.max(
        0,
        crops.length-1
      )

    const sheet=
      document.createElement(
        'canvas'
      )

    sheet.width=width
    sheet.height=height

    const ctx=
      sheet.getContext(
        '2d',
        {willReadFrequently:true}
      )!

    ctx.fillStyle='#fff'
    ctx.fillRect(
      0,0,
      width,height
    )

    const maps:{
      pageRect:Rect
      x:number
      y:number
      width:number
      height:number
    }[]=[]

    let y=0

    crops.forEach(
      (crop,index)=>{
        ctx.drawImage(
          crop,
          0,y
        )

        maps.push({
          pageRect:
            rects[index],
          x:0,
          y,
          width:
            crop.width,
          height:
            crop.height
        })

        y+=
          crop.height+
          gap
      }
    )

    return{
      sheet,
      maps
    }
  }

  function tokensForMap(
    tokens:OCRToken[],
    sheet:
      HTMLCanvasElement,
    map:{
      pageRect:Rect
      x:number
      y:number
      width:number
      height:number
    }
  ):OCRToken[]{
    return tokens
      .filter(token=>{
        const px=
          (
            token.rect.x+
            token.rect.width/2
          )*
          sheet.width

        const py=
          (
            token.rect.y+
            token.rect.height/2
          )*
          sheet.height

        return(
          px>=map.x&&
          px<=map.x+map.width&&
          py>=map.y&&
          py<=map.y+map.height
        )
      })
      .map(token=>{
        const px=
          token.rect.x*
          sheet.width

        const py=
          token.rect.y*
          sheet.height

        const pw=
          token.rect.width*
          sheet.width

        const ph=
          token.rect.height*
          sheet.height

        const local:Rect={
          x:
            Math.max(
              0,
              (
                px-map.x
              )/
              map.width
            ),
          y:
            Math.max(
              0,
              (
                py-map.y
              )/
              map.height
            ),
          width:
            pw/
            map.width,
          height:
            ph/
            map.height
        }

        return{
          ...token,
          rect:
            mapLocalRectToPage(
              local,
              map.pageRect
            )
        }
      })
  }

  async function scanPanel(
    page:HTMLCanvasElement,
    panel:Rect,
    pageIndex:number,
    index:number,
    progressBase:number
  ){
    const bands=
      bandRects(panel)

    const {
      sheet,
      maps
    }=
      buildContactSheet(
        page,
        bands,
        1180
      )

    const processed=
      preprocess(
        sheet,
        'gray'
      )

    const tokens=
      await recognizePage(
        processed,
        pageIndex,
        progress=>
          update(
            index,
            {
              progress:
                progressBase+
                progress*18,
              message:
                '서명할 위치를 찾고 있어요'
            }
          ),
        true
      )

    let best:
      TargetCandidate|null=null

    const hints:{
      rect:Rect
      score:number
    }[]=[]

    for(const map of maps){
      const mapped=
        tokensForMap(
          tokens,
          sheet,
          map
        )

      const assessment=
        assessTokens(
          mapped,
          pageIndex
        )

      hints.push({
        rect:
          map.pageRect,
        score:
          assessment.hintScore
      })

      if(
        assessment.target&&
        (
          !best||
          assessment.target.score>
          best.score
        )
      ){
        best=
          assessment.target
      }
    }

    return{
      target:best,
      hints
    }
  }

  async function refineTile(
    page:HTMLCanvasElement,
    rect:Rect,
    pageIndex:number,
    index:number
  ){
    const crop=
      cropPage(
        page,
        rect,
        1900
      )

    const processed=
      preprocess(
        crop,
        'adaptive'
      )

    const tokens=
      await recognizePage(
        processed,
        pageIndex,
        progress=>
          update(
            index,
            {
              progress:
                80+
                progress*13,
              message:
                '서명 위치를 정밀하게 확인하고 있어요'
            }
          ),
        true
      )

    const assessment=
      assessTokens(
        tokens,
        pageIndex
      )

    if(!assessment.target){
      return null
    }

    return{
      ...assessment.target,
      targetRect:
        mapLocalRectToPage(
          assessment.target.targetRect,
          rect
        )
    }
  }

  async function processOne(
    file:File,
    index:number
  ){
    const started=performance.now()

    update(index,{
      status:'processing',
      progress:1,
      message:'문서를 준비하고 있어요'
    })
    startProgress(index)

    const src=await loadSource(file)
    update(index,{
      pageCount:src.pageCount,
      progress:3,
      message:'문서를 똑바로 맞추고 있어요'
    })

    // 성능점검기록부는 서명/확인 영역이 뒤쪽 페이지에 있는 경우가 많아
    // 마지막 페이지를 대표 페이지로 먼저 본다. 단, 위치는 탐지 점수에 사용하지 않는다.
    const representativeIndex=Math.max(0,src.pageCount-1)
    const representativeRaw=await renderPage(
      src,
      representativeIndex,
      1800
    )

    // 친구 HTML의 핵심을 그대로 사용:
    // 1600px 정규화 + grayscale/contrast + SINGLE_BLOCK + 4방향 동일 OCR 조건.
    // 이 결과의 winning words를 버리지 않고 바로 서명 탐지에도 재사용한다.
    const direction=await decidePageDirection(
      representativeRaw,
      representativeIndex,
      (progress,message)=>update(index,{progress,message})
    )

    update(index,{
      progress:25,
      message:'서명할 위치를 찾고 있어요'
    })

    let best:TargetCandidate|null=null
    let bestPageIndex=representativeIndex

    // 1차: 방향 판정에서 이미 얻은 OCR words를 즉시 재사용.
    // 추가 OCR 0회.
    best=
      quickSignatureRect(
        direction.tokens,
        representativeIndex
      ) ??
      assessTokens(
        direction.tokens,
        representativeIndex
      ).target

    // 대표 페이지에 없을 때만 다른 페이지를 정방향으로 1회씩 OCR.
    if(!best&&src.pageCount>1){
      const order=[...Array(src.pageCount).keys()]
        .filter(pageIndex=>pageIndex!==representativeIndex)
        .reverse()

      for(let i=0;i<order.length;i++){
        const pageIndex=order[i]
        update(index,{
          progress:Math.min(72,30+i*12),
          message:'다른 페이지에서 서명 위치를 확인하고 있어요'
        })

        const page=await renderOrientedPage(
          src,
          pageIndex,
          1600,
          direction.correction
        )

        const full=await recognizeFullForDirection(
          page,
          pageIndex
        )

        const candidate=
          quickSignatureRect(
            full.tokens,
            pageIndex
          ) ??
          assessTokens(
            full.tokens,
            pageIndex
          ).target

        if(candidate){
          best=candidate
          bestPageIndex=pageIndex
          break
        }
      }
    }

    // 저화질에서 매수인/서명 한 글자가 깨졌을 때만
    // 최종 후보 페이지 한 장을 adaptive OCR로 딱 한 번 재시도한다.
    if(!best){
      update(index,{
        progress:78,
        message:'글자를 선명하게 보정해 한 번 더 확인하고 있어요'
      })

      const pageIndex=representativeIndex
      const page=await renderOrientedPage(
        src,
        pageIndex,
        1950,
        direction.correction
      )
      const processed=preprocess(page,'adaptive')
      const tokens=await recognizePage(
        processed,
        pageIndex,
        progress=>update(index,{
          progress:78+progress*14,
          message:'서명 위치를 정밀하게 확인하고 있어요'
        }),
        true
      )

      best=
        quickSignatureRect(tokens,pageIndex) ??
        assessTokens(tokens,pageIndex).target
      bestPageIndex=pageIndex
    }

    if(!best){
      stopProgress(index)
      update(index,{
        status:'failed',
        progress:100,
        message:'서명영역을 찾지 못했습니다.',
        elapsedMs:performance.now()-started
      })
      return
    }

    // v24 핵심: 1차 탐지는 정답이 아니라 '후보 영역'만 확보한다.
    // 후보 주변을 넓게 다시 잘라 고해상도로 OCR하고, 그 안에서 실제 작성행을 재탐지한다.
    update(index,{
      progress:84,
      message:'찾은 영역을 확대해서 서명 위치를 다시 확인하고 있어요'
    })

    const finalPage=await renderOrientedPage(
      src,
      best.pageIndex,
      2200,
      direction.correction
    )

    const coarse=best.targetRect
    const coarseRect:Rect={
      x:Math.max(0,coarse.x-.09),
      y:Math.max(0,coarse.y-.075),
      width:Math.min(
        1-Math.max(0,coarse.x-.09),
        Math.max(.46,coarse.width+.18)
      ),
      height:Math.min(
        1-Math.max(0,coarse.y-.075),
        Math.max(.20,coarse.height+.15)
      )
    }

    const secondPassCanvas=cropPage(
      finalPage,
      coarseRect,
      2100
    )

    let refined:TargetCandidate|null=null

    // 2차 1회: 확대된 후보영역의 일반 grayscale OCR.
    const secondGray=preprocess(secondPassCanvas,'gray')
    const secondTokens=await recognizePage(
      secondGray,
      best.pageIndex,
      progress=>update(index,{
        progress:84+progress*8,
        message:'서명 위치를 정밀하게 찾고 있어요'
      }),
      true
    )

    const localRefined=refineSignatureRect(
      secondTokens,
      best.pageIndex
    )

    if(localRefined){
      refined={
        ...localRefined,
        targetRect:mapLocalRectToPage(
          localRefined.targetRect,
          coarseRect
        )
      }
    }

    // 확대 후에도 글자가 깨진 경우에만 같은 작은 영역을 adaptive로 딱 한 번 재시도.
    if(!refined){
      const secondAdaptive=preprocess(secondPassCanvas,'adaptive')
      const adaptiveTokens=await recognizePage(
        secondAdaptive,
        best.pageIndex,
        progress=>update(index,{
          progress:92+progress*4,
          message:'희미한 글자를 보정해 마지막으로 확인하고 있어요'
        }),
        true
      )

      const adaptiveRefined=refineSignatureRect(
        adaptiveTokens,
        best.pageIndex
      )

      if(adaptiveRefined){
        refined={
          ...adaptiveRefined,
          targetRect:mapLocalRectToPage(
            adaptiveRefined.targetRect,
            coarseRect
          )
        }
      }
    }

    // 재탐지 성공 시에만 더 좁고 정확한 영역으로 교체.
    // 실패해도 1차 후보를 버리지 않아 이전 성공 케이스가 퇴보하지 않게 한다.
    if(refined){
      best=refined
    }

    update(index,{
      progress:97,
      message:'서명영역을 크게 보여드릴게요'
    })

    // 최종 UI는 재탐지된 실제 작성행에 물리적 40px margin만 추가한다.
    const cropRect=expandRectByPixels(
      finalPage,
      best.targetRect,
      40
    )

    const crop=cropPage(
      finalPage,
      cropRect,
      1900
    )

    stopProgress(index)
    update(index,{
      status:'success',
      progress:100,
      message:'완료',
      pageIndex:best.pageIndex,
      pagePreview:finalPage.toDataURL('image/jpeg',.95),
      cropPreview:crop.toDataURL('image/jpeg',.99),
      targetRect:best.targetRect,
      cropRect,
      elapsedMs:performance.now()-started
    })
  }

  async function start(){
    if(
      !files.length||
      processing
    )return

    setProcessing(true)
    setResults(
      files.map(
        emptyResult
      )
    )

    for(
      let index=0;
      index<files.length;
      index++
    ){
      try{
        await processOne(
          files[index],
          index
        )
      }catch(error){
        stopProgress(index)

        update(
          index,
          {
            status:'failed',
            progress:100,
            message:
              error instanceof Error
                ?error.message
                :'문서를 처리하지 못했습니다.'
          }
        )
      }
    }

    setProcessing(false)
  }

  function selectFiles(
    list:FileList|null
  ){
    if(!list)return

    const selected=
      Array.from(list)
        .filter(file=>{
          const name=
            file.name
              .toLowerCase()

          return(
            file.type===
              'application/pdf'||
            file.type===
              'image/jpeg'||
            file.type===
              'image/png'||
            name.endsWith(
              '.pdf'
            )||
            name.endsWith(
              '.jpg'
            )||
            name.endsWith(
              '.jpeg'
            )||
            name.endsWith(
              '.png'
            )
          )
        })
        .slice(0,5)

    setFiles(selected)
    setResults([])
  }

  return(
    <div className="app v20App">
      <header className="testHeader">
        <p className="eyebrow">
          INTERNAL PROTOTYPE
        </p>

        <h1>
          서명영역 탐지 v{VERSION}
        </h1>

        <div className="versionBadge">
          BUILD {VERSION} · {BUILD}
        </div>

        <p className="sub">
          문서를 자동으로 바로 세운 뒤 매수인/서명 글줄을 찾아 크게 보여줍니다.
        </p>
      </header>

      <section
        className={
          `dropzone ${
            processing
              ?'disabled'
              :''
          }`
        }
        onClick={()=>
          !processing&&
          inputRef.current?.click()
        }
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          hidden
          onChange={event=>
            selectFiles(
              event.target.files
            )
          }
        />

        <div className="uploadIcon">
          5
        </div>

        <strong>
          {files.length
            ?`${files.length}개 파일 선택됨`
            :'PDF / JPG / PNG 최대 5개'
          }
        </strong>

        <span>
          실제 사용자 화면과 같은 결과를 확인합니다.
        </span>
      </section>

      {files.length>0&&
        <section className="batchList">
          {files.map(
            (file,index)=>
              <div
                className="fileChip"
                key={
                  `${file.name}-${index}`
                }
              >
                <b>
                  {index+1}
                </b>
                <span>
                  {file.name}
                </span>
              </div>
          )}

          <button
            className="startBtn"
            disabled={processing}
            onClick={start}
          >
            {processing
              ?'분석 중…'
              :'분석 시작'
            }
          </button>
        </section>
      }

      {results.map(
        (result,index)=>
          <section
            className="resultCard card endUserCard"
            key={result.id}
          >
            {result.status===
              'processing'&&
              <div className="simpleProgress">
                <strong>
                  성능점검기록부를 확인하고 있어요
                </strong>

                <span>
                  {result.progress}%
                </span>

                <div className="progress">
                  <i
                    style={{
                      width:
                        `${result.progress}%`
                    }}
                  />
                </div>
              </div>
            }

            {result.status===
              'success'&&
              result.pagePreview&&
              result.cropPreview&&
              result.targetRect&&
              result.cropRect&&
              <LinkedSignatureEditor
                pageImage={
                  result.pagePreview
                }
                cropImage={
                  result.cropPreview
                }
                targetRect={
                  result.targetRect
                }
                cropRect={
                  result.cropRect
                }
              />
            }

            {result.status===
              'failed'&&
              <div className="failureText">
                서명할 영역을 자동으로 찾지 못했습니다.
              </div>
            }
          </section>
      )}
    </div>
  )
}

type Point={
  x:number
  y:number
}

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
  const pageCanvas=
    useRef<HTMLCanvasElement>(
      null
    )

  const cropCanvas=
    useRef<HTMLCanvasElement>(
      null
    )

  const pageImg=
    useRef<HTMLImageElement|null>(
      null
    )

  const cropImg=
    useRef<HTMLImageElement|null>(
      null
    )

  const [
    strokes,
    setStrokes
  ]=useState<Stroke[]>([])

  const active=
    useRef<Stroke|null>(
      null
    )

  function fitCanvas(
    canvas:HTMLCanvasElement,
    image:HTMLImageElement,
    maxDpr=2
  ){
    const cssWidth=
      canvas.clientWidth||320

    const ratio=
      image.naturalHeight/
      image.naturalWidth

    const dpr=
      Math.min(
        maxDpr,
        window.devicePixelRatio||
          1
      )

    canvas.width=
      Math.max(
        1,
        Math.round(
          cssWidth*dpr
        )
      )

    canvas.height=
      Math.max(
        1,
        Math.round(
          cssWidth*
          ratio*
          dpr
        )
      )
  }

  function drawStroke(
    ctx:CanvasRenderingContext2D,
    stroke:Stroke,
    width:number,
    height:number,
    lineWidth:number
  ){
    if(
      stroke.length<1
    )return

    ctx.beginPath()

    ctx.moveTo(
      stroke[0].x*
        width,
      stroke[0].y*
        height
    )

    for(
      const point
      of stroke.slice(1)
    ){
      ctx.lineTo(
        point.x*width,
        point.y*height
      )
    }

    ctx.strokeStyle='#111'
    ctx.lineWidth=lineWidth
    ctx.lineCap='round'
    ctx.lineJoin='round'
    ctx.stroke()
  }

  function redraw(){
    const page=
      pageCanvas.current

    const crop=
      cropCanvas.current

    const pageImageElement=
      pageImg.current

    const cropImageElement=
      cropImg.current

    if(
      !page||
      !crop||
      !pageImageElement||
      !cropImageElement
    )return

    const pageContext=
      page.getContext('2d')!

    pageContext.clearRect(
      0,0,
      page.width,
      page.height
    )

    pageContext.drawImage(
      pageImageElement,
      0,0,
      page.width,
      page.height
    )

    // 사용자에게는 서명 위치만 노란색으로 명확히 안내.
    pageContext.save()
    pageContext.strokeStyle=
      '#FAC729'

    pageContext.lineWidth=
      Math.max(
        4,
        page.width*.004
      )

    pageContext.strokeRect(
      targetRect.x*
        page.width,
      targetRect.y*
        page.height,
      targetRect.width*
        page.width,
      targetRect.height*
        page.height
    )

    pageContext.restore()

    const cropContext=
      crop.getContext('2d')!

    cropContext.clearRect(
      0,0,
      crop.width,
      crop.height
    )

    cropContext.drawImage(
      cropImageElement,
      0,0,
      crop.width,
      crop.height
    )

    for(
      const stroke
      of strokes
    ){
      drawStroke(
        cropContext,
        stroke,
        crop.width,
        crop.height,
        Math.max(
          3,
          crop.width*.005
        )
      )

      const pageStroke=
        stroke.map(
          point=>({
            x:
              cropRect.x+
              point.x*
              cropRect.width,
            y:
              cropRect.y+
              point.y*
              cropRect.height
          })
        )

      drawStroke(
        pageContext,
        pageStroke,
        page.width,
        page.height,
        Math.max(
          2,
          page.width*.0025
        )
      )
    }
  }

  useEffect(
    ()=>{
      let readyCount=0

      const ready=()=>{
        readyCount++

        if(
          readyCount<2
        )return

        fitCanvas(
          pageCanvas.current!,
          pageImg.current!
        )

        fitCanvas(
          cropCanvas.current!,
          cropImg.current!
        )

        redraw()
      }

      const pageImageObject=
        new Image()

      pageImageObject.onload=
        ready

      pageImageObject.src=
        pageImage

      pageImg.current=
        pageImageObject

      const cropImageObject=
        new Image()

      cropImageObject.onload=
        ready

      cropImageObject.src=
        cropImage

      cropImg.current=
        cropImageObject
    },
    [
      pageImage,
      cropImage
    ]
  )

  useEffect(
    ()=>{
      redraw()
    },
    [strokes]
  )

  useEffect(
    ()=>{
      const resize=()=>{
        if(
          !pageCanvas.current||
          !cropCanvas.current||
          !pageImg.current||
          !cropImg.current
        )return

        fitCanvas(
          pageCanvas.current,
          pageImg.current
        )

        fitCanvas(
          cropCanvas.current,
          cropImg.current
        )

        redraw()
      }

      window.addEventListener(
        'resize',
        resize
      )

      return()=>
        window.removeEventListener(
          'resize',
          resize
        )
    },
    [strokes]
  )

  function pointerPoint(
    event:
      React.PointerEvent<
        HTMLCanvasElement
      >
  ):Point{
    const bounds=
      event
        .currentTarget
        .getBoundingClientRect()

    return{
      x:
        Math.max(
          0,
          Math.min(
            1,
            (
              event.clientX-
              bounds.left
            )/
            bounds.width
          )
        ),
      y:
        Math.max(
          0,
          Math.min(
            1,
            (
              event.clientY-
              bounds.top
            )/
            bounds.height
          )
        )
    }
  }

  return(
    <div className="linkedEditor userSigningFlow">
      <div className="editorSection">
        <div className="editorTitle">
          <h3>
            성능점검기록부
          </h3>

          <span>
            노란 영역에 날짜와 서명을 작성해주세요.
          </span>
        </div>

        <div className="originalCanvasWrap uprightDocument">
          <canvas
            ref={pageCanvas}
          />
        </div>
      </div>

      <div className="editorSection signatureEditorFill">
        <div className="editorTitle">
          <h3>
            서명할 영역
          </h3>

          <span>
            크게 확대한 문서 위에 손가락으로 직접 작성하세요.
          </span>
        </div>

        <div className="signatureCanvasWrap v20SignatureCanvas">
          <canvas
            ref={cropCanvas}
            onPointerDown={
              event=>{
                event
                  .currentTarget
                  .setPointerCapture(
                    event.pointerId
                  )

                const stroke=[
                  pointerPoint(
                    event
                  )
                ]

                active.current=
                  stroke

                setStrokes(
                  prev=>[
                    ...prev,
                    stroke
                  ]
                )
              }
            }
            onPointerMove={
              event=>{
                if(
                  !active.current
                )return

                active.current.push(
                  pointerPoint(
                    event
                  )
                )

                setStrokes(
                  prev=>{
                    const copy=[
                      ...prev
                    ]

                    copy[
                      copy.length-1
                    ]=[
                      ...active.current!
                    ]

                    return copy
                  }
                )
              }
            }
            onPointerUp={
              ()=>{
                active.current=null
              }
            }
            onPointerCancel={
              ()=>{
                active.current=null
              }
            }
          />
        </div>

        <div className="editorActions simplifiedActions">
          <span>
            확대해서 쓴 내용은 위 문서의 같은 위치에 바로 반영됩니다.
          </span>

          <button
            onClick={()=>
              setStrokes([])
            }
          >
            다시 쓰기
          </button>
        </div>
      </div>
    </div>
  )
}
