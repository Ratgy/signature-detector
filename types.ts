export type Rotation = 0 | 90 | 180 | 270
export interface NormalizedRect { x:number; y:number; width:number; height:number }
export interface OCRToken { text:string; confidence:number; rect:NormalizedRect; pageIndex:number }
export interface ConfirmCandidate {
  pageIndex:number; rotation:Rotation; anchorRect:NormalizedRect; cropRect:NormalizedRect;
  confidence:number; anchorText:string
}
export interface FileResult {
  id:string; fileName:string; status:'queued'|'processing'|'success'|'failed'; progress:number;
  message:string; pageCount:number; pageIndex:number|null; rotation:Rotation; confidence:number;
  fullPreview:string|null; cropPreview:string|null; anchorText:string|null; elapsedMs:number;
  judgement?:'correct'|'partial'|'wrong'|'failed'
}
