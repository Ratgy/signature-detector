# Signature Detector Batch v10.0

BUILD 10.0 · 2026-08-12

## 변경사항

- PDF 여러 페이지를 결과에 섞지 않음.
- 빠른 OCR 점수가 가장 높은 "서명 페이지 하나"만 선택.
- `확인` 문맥은 후보 판정에만 사용.
- 실제 Crop은 `년·월·일 / 매수인 / 서명 또는 인` 행만 포함.
- 전체 페이지 미리보기 및 OCR 원문 표시 제거.
- 결과 UI는 서명영역 확대 이미지만 표시.

## JPG / PNG 개선

v9.x의 이미지 OCR 문제:
`renderImage()`가 원본 크기보다 확대하지 않았기 때문에
작은 한글이 있는 저해상도 사진은 정밀 OCR에서도 픽셀 정보가 부족했습니다.

v10:
- 정밀 이미지 OCR 시 최대 3200px 렌더.
- 최대 3배 OCR용 업스케일 허용.
- 고품질 interpolation.
- 강한 grayscale/contrast 전처리.
- 첫 OCR 실패 시 다른 전처리로 한 번 더 정밀 OCR.
- PDF에는 불필요한 재시도를 하지 않음.

## 입력

PDF / JPG / JPEG / PNG, 최대 5개.
