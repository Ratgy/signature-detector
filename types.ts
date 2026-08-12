export type Rotation = 0 | 90 | 180 | 270

export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export interface OCRToken {
  text: string
  confidence: number
  rect: NormalizedRect
  pageIndex: number
}

export interface SignatureBlock {
  pageIndex: number
  rotation: Rotation
  rect: NormalizedRect
  rotatedRect: NormalizedRect
  confidence: number
  score: number
  matchedKeywords: string[]
}
