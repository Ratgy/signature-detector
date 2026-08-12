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

export interface SearchRegion {
  id:string
  pageIndex:number
  rect:Rect
  priority:number
}

export interface TargetCandidate {
  pageIndex:number
  region:Rect
  targetRect:Rect
  score:number
  confidence:number
}

export interface FileResult {
  id:string
  fileName:string
  fileType:'pdf'|'image'
  status:'queued'|'processing'|'success'|'failed'
  progress:number
  message:string
  pageCount:number
  confidence:number
  cropPreview:string|null
  elapsedMs:number
  judgement?:'correct'|'partial'|'wrong'
}
