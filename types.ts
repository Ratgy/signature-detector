export interface Rect {
  x:number
  y:number
  width:number
  height:number
}

export interface OCRToken {
  text:string
  confidence:number
  rect:Rect
  pageIndex:number
}

export interface RegionSpec {
  id:string
  pageIndex:number
  rect:Rect
}

export interface TargetCandidate {
  pageIndex:number
  targetRect:Rect
  score:number
  confidence:number
  mode:'exact'|'confirm-date'|'buyer-sign'
}

export interface ScanAssessment {
  target:TargetCandidate|null
  hintScore:number
}

export interface FileResult {
  id:string
  fileName:string
  fileType:'pdf'|'image'
  status:'queued'|'processing'|'success'|'failed'
  progress:number
  message:string
  pageCount:number
  pageIndex:number|null
  confidence:number
  pagePreview:string|null
  cropPreview:string|null
  targetRect:Rect|null
  cropRect:Rect|null
  elapsedMs:number

  orientationCorrection:0|90|180|270
  orientationConfidence:number
  orientationOriginalPreview:string|null
  orientationCorrectedPreview:string|null

  judgement?:'correct'|'partial'|'wrong'
}
