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

export interface OCRLine {
  text:string
  confidence:number
  rect:Rect
  tokens:OCRToken[]
}

export interface TargetCandidate {
  pageIndex:number
  targetRect:Rect
  score:number
  confidence:number
}

export interface ScanAssessment {
  target:TargetCandidate|null
  hintScore:number
  focusRect:Rect|null
}

export interface FileResult {
  id:string
  fileName:string
  status:'queued'|'processing'|'success'|'failed'
  progress:number
  message:string
  pageCount:number
  pageIndex:number|null
  pagePreview:string|null
  cropPreview:string|null
  targetRect:Rect|null
  cropRect:Rect|null
  elapsedMs:number
}
